import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTLE_MS } from '../../src/actions/send.ts';
import { ASK_TOOL } from '../../src/triage/mail-ask.ts';
import { FIND_TOOL } from '../../src/triage/rule-draft.ts';
import { fakeGoogle, fauxModel, startSift } from '../fixtures.ts';
import { DAY } from '../helpers.ts';
import { everyRouteAnswered } from './areas.ts';

const fake = fakeGoogle();
const ME = 'me@example.org';
const OTHER = 'other@example.com';
const AT = Date.UTC(2026, 10, 18, 12);

beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'], now: AT, shouldAdvanceTime: true }));
afterEach(() => void vi.useRealTimers());

type Thread = { threadId: string; subject: string; messageIds: string[]; unread: boolean; place: string; preview: string | null };
const threadsOf = (reply: { body: Record<string, unknown> }) => reply.body['threads'] as Thread[];

/** Signed in with a label of their own and Inbox on, its copy of their mail made. */
async function withInbox(model?: ReturnType<typeof fauxModel>) {
  const sift = await startSift(fake.google, model ? { model: model.chosen } : {});
  const box = fake.google.mailbox(ME);
  const me = await sift.settled(ME);
  expect((await me.call('POST', '/api/mail/on', { on: true })).status).toBe(200);
  await sift.work();
  return { sift, box, me };
}

/** New mail, as the next pass brings it. */
async function arrives(sift: Awaited<ReturnType<typeof startSift>>, me: Awaited<ReturnType<typeof withInbox>>['me']) {
  expect((await me.call('POST', '/api/check', {})).status).toBe(200);
  await sift.work();
}

describe('Inbox, turned on and off', () => {
  it('says how much each window would copy from Gmail’s counts, and asks Gmail again only after a while', async () => {
    const sift = await startSift(fake.google);
    const box = fake.google.mailbox(ME);
    box.deliver({ from: 'ada@example.com', at: AT - 2 * DAY }, { quietly: true });
    box.deliver({ from: 'bo@example.com', at: AT - 400 * DAY, labelIds: [] }, { quietly: true });
    box.deliver({ from: 'cy@example.com', at: AT - 1500 * DAY, labelIds: [] }, { quietly: true });
    const me = await sift.settled(ME);

    const reach = await me.call('GET', '/api/mail/reach');
    expect(reach.status).toBe(200);
    expect(reach.body).toMatchObject({ year: { messages: 1 }, three_years: { messages: 2 }, all: { messages: 3 } });
    const asked = box.requests.length;
    expect((await me.call('GET', '/api/mail/reach')).body).toEqual(reach.body);
    expect(box.requests).toHaveLength(asked);
  });

  it('copies the inbox and the window chosen, each message read whole once, and lets go of the text when turned off', async () => {
    const sift = await startSift(fake.google);
    const box = fake.google.mailbox(ME);
    const lunch = box.deliver({ from: 'Ada <ada@example.com>', subject: 'Lunch?', text: 'Lunch on Friday?', at: AT - 2 * DAY }, { quietly: true });
    const archived = box.deliver({ from: 'bo@example.com', subject: 'Old news', at: AT - 30 * DAY, labelIds: [] }, { quietly: true });
    const outside = box.deliver({ from: 'cy@example.com', subject: 'Older news', at: AT - 400 * DAY, labelIds: [] }, { quietly: true });
    const me = await sift.settled(ME);

    expect((await me.call('POST', '/api/mail/on', { on: true, window: 'year' })).status).toBe(200);
    expect((await me.call('GET', '/api/manage')).body).toMatchObject({ mail: true, mailWindow: 'year' });
    await sift.work();
    for (const id of [lunch, archived]) expect(box.asked('users.messages.get', id)).toEqual([{ method: 'users.messages.get', id, format: 'full' }]);
    expect(box.asked('users.messages.get', outside)).toEqual([]);
    expect((await me.call('GET', `/api/message?id=${lunch}`)).body).toMatchObject({ subject: 'Lunch?', body: 'Lunch on Friday?' });
    expect((await me.call('GET', `/api/message?id=${archived}`)).body).toMatchObject({ subject: 'Old news' });

    expect((await me.call('POST', '/api/mail/on', { on: false })).status).toBe(200);
    expect((await me.call('GET', '/api/manage')).body).toMatchObject({ mail: false });
    expect((await me.call('GET', `/api/message?id=${lunch}`)).body).toMatchObject({ subject: 'Lunch?', body: null, hasHtml: false });
  });
});

describe('reading mail', () => {
  it('lists the inbox’s conversations newest first, and gives one oldest first with each message’s text and HTML', async () => {
    const { sift, box, me } = await withInbox();
    const first = box.deliver({
      from: 'Ada <ada@example.com>',
      subject: 'Lunch?',
      text: 'Lunch on Friday?',
      html: '<p>Lunch on <b>Friday</b>?</p>',
      at: AT - DAY,
    });
    const reply = box.deliver({ from: 'Ada <ada@example.com>', subject: 'Re: Lunch?', threadId: first, text: 'Or Saturday.', at: AT - 60_000 });
    const older = box.deliver({ from: 'Bo <bo@example.com>', subject: 'Tea?', at: AT - 2 * DAY });
    await arrives(sift, me);

    const threads = await me.call('GET', '/api/mail/threads');
    expect(threadsOf(threads).map((t) => ({ threadId: t.threadId, subject: t.subject, messageIds: t.messageIds, place: t.place }))).toEqual([
      { threadId: first, subject: 'Re: Lunch?', messageIds: [first, reply], place: 'inbox' },
      { threadId: older, subject: 'Tea?', messageIds: [older], place: 'inbox' },
    ]);
    expect(threadsOf(await me.call('GET', '/api/mail/threads?q=saturday')).map((t) => t.threadId)).toEqual([first]);

    const thread = await me.call('GET', `/api/mail/thread?thread=${first}`);
    expect(thread.status).toBe(200);
    expect(thread.body).toMatchObject({
      threadId: first,
      messages: [
        { messageId: first, fromAddress: 'ada@example.com', preview: 'Lunch on Friday?' },
        { messageId: reply, preview: 'Or Saturday.' },
      ],
    });
    expect((await me.call('GET', `/api/message?id=${reply}`)).body).toMatchObject({
      fromName: 'Ada',
      subject: 'Re: Lunch?',
      body: 'Or Saturday.',
      hasHtml: false,
    });

    const html = await me.call('GET', `/api/message/html?id=${first}`);
    expect(html.status).toBe(200);
    expect(html.body['text']).toContain('<p>Lunch on <b>Friday</b>?</p>');
    expect((await me.call('GET', `/api/message/html?id=${reply}`)).status).toBe(404);
  });

  it('shows someone else none of it', async () => {
    const { sift, box, me } = await withInbox();
    const id = box.deliver({ from: 'ada@example.com', subject: 'Lunch?', html: '<p>Lunch</p>' });
    await arrives(sift, me);
    const other = await sift.settled(OTHER);
    expect(threadsOf(await other.call('GET', '/api/mail/threads'))).toEqual([]);
    expect((await other.call('GET', `/api/mail/thread?thread=${id}`)).status).toBe(404);
    expect((await other.call('GET', `/api/message?id=${id}`)).status).toBe(404);
    expect((await other.call('GET', `/api/message/html?id=${id}`)).status).toBe(404);
    expect((await other.call('GET', `/api/mail/threads?mailbox=${ME}`)).status).toBe(404);
  });
});

describe('changing mail', () => {
  it('archives and marks read in Gmail, as the record then says, and Undo puts it back', async () => {
    const { sift, box, me } = await withInbox();
    const a = box.deliver({ from: 'ada@example.com', subject: 'One' });
    const b = box.deliver({ from: 'bo@example.com', subject: 'Two' });
    await arrives(sift, me);

    const read = await me.call('POST', '/api/mail/change', { accountId: ME, messageIds: [a], change: 'read' });
    expect(read.body).toMatchObject({ actions: [expect.any(Number)], missed: 0 });
    expect(box.message(a)!.labelIds).toEqual(['INBOX']);

    const archived = await me.call('POST', '/api/mail/change', { accountId: ME, messageIds: [a, b], change: 'archive' });
    expect(archived.status).toBe(200);
    const { actions } = archived.body as { actions: number[] };
    expect(actions).toHaveLength(2);
    expect(box.message(a)!.labelIds).not.toContain('INBOX');
    expect(box.message(b)!.labelIds).not.toContain('INBOX');
    expect(threadsOf(await me.call('GET', '/api/mail/threads'))).toEqual([]);

    expect(await me.call('POST', '/api/undo', { id: actions[1] })).toMatchObject({ status: 200, body: { message: null } });
    expect(box.message(b)!.labelIds).toContain('INBOX');
    expect(threadsOf(await me.call('GET', '/api/mail/threads')).map((t) => t.threadId)).toEqual([b]);
  });

  it('leaves mail no longer in the inbox as it is', async () => {
    const { sift, box, me } = await withInbox();
    const id = box.deliver({ from: 'ada@example.com' });
    await arrives(sift, me);
    box.change(id, { remove: ['INBOX'] });
    expect((await me.call('POST', '/api/mail/change', { accountId: ME, messageIds: [id], change: 'read' })).body).toEqual({ actions: [], missed: 0 });
    expect(box.message(id)!.labelIds).toEqual(['UNREAD']);
  });

  it('returns what landed when a message’s Gmail call throws, with that one counted missed, so Undo still takes the rest back', async () => {
    const { sift, box, me } = await withInbox();
    const a = box.deliver({ from: 'ada@example.com' });
    const b = box.deliver({ from: 'bo@example.com' });
    await arrives(sift, me);
    // Gmail's client tries a read four times before it gives up.
    box.fail('users.messages.get', ...Array.from({ length: 4 }, () => ({ status: 503 })));

    const changed = await me.call('POST', '/api/mail/change', { accountId: ME, messageIds: [a, b], change: 'archive' });
    expect(changed.status).toBe(200);
    const { actions, missed } = changed.body as { actions: number[]; missed: number };
    expect(missed).toBe(1);
    expect(actions).toHaveLength(1);
    expect(box.message(a)!.labelIds).toContain('INBOX');
    expect(box.message(b)!.labelIds).not.toContain('INBOX');

    expect((await me.call('POST', '/api/undo', { id: actions[0] })).status).toBe(200);
    expect(box.message(b)!.labelIds).toContain('INBOX');
  });

  it('offers Undo for a change whose answer was lost, which takes it back once Gmail shows it landed', async () => {
    const { sift, box, me } = await withInbox();
    const id = box.deliver({ from: 'ada@example.com' });
    await arrives(sift, me);
    box.fail('users.messages.modify', 'lost');

    const changed = await me.call('POST', '/api/mail/change', { accountId: ME, messageIds: [id], change: 'archive' });
    const { actions } = changed.body as { actions: number[] };
    expect(changed.body).toEqual({ actions: [expect.any(Number)], missed: 0 });
    expect(box.message(id)!.labelIds).not.toContain('INBOX');

    expect((await me.call('POST', '/api/undo', { id: actions[0] })).status).toBe(200);
    expect(box.message(id)!.labelIds).toContain('INBOX');
    await arrives(sift, me);
    expect(threadsOf(await me.call('GET', '/api/mail/threads'))).toHaveLength(1);
  });

  it('offers Undo for a change Gmail never got, which then has nothing to take back', async () => {
    const { sift, box, me } = await withInbox();
    const id = box.deliver({ from: 'ada@example.com' });
    await arrives(sift, me);
    box.fail('users.messages.modify', 'network');

    const { actions } = (await me.call('POST', '/api/mail/change', { accountId: ME, messageIds: [id], change: 'archive' })).body as { actions: number[] };
    expect(actions).toHaveLength(1);
    expect(box.message(id)!.labelIds).toContain('INBOX');
    expect((await me.call('POST', '/api/undo', { id: actions[0] })).status).toBe(200);
    expect(box.asked('users.messages.modify')).toHaveLength(1);
    expect(box.message(id)!.labelIds).toContain('INBOX');
  });

  it('refuses an Undo Gmail refuses, leaving the change in place to be undone again', async () => {
    const { sift, box, me } = await withInbox();
    const id = box.deliver({ from: 'ada@example.com' });
    await arrives(sift, me);
    const { actions } = (await me.call('POST', '/api/mail/change', { accountId: ME, messageIds: [id], change: 'archive' })).body as { actions: number[] };
    box.fail('users.messages.modify', { status: 500 });

    expect((await me.call('POST', '/api/undo', { id: actions[0] })).status).toBe(409);
    expect(box.message(id)!.labelIds).not.toContain('INBOX');
    expect((await me.call('POST', '/api/undo', { id: actions[0] })).status).toBe(200);
    expect(box.message(id)!.labelIds).toContain('INBOX');
  });

  it('changes and undoes nothing of someone else’s', async () => {
    const { sift, box, me } = await withInbox();
    const id = box.deliver({ from: 'ada@example.com' });
    await arrives(sift, me);
    const { actions } = (await me.call('POST', '/api/mail/change', { accountId: ME, messageIds: [id], change: 'read' })).body as { actions: number[] };
    const other = await sift.settled(OTHER);
    const asked = box.requests.length;

    expect((await other.call('POST', '/api/mail/change', { accountId: ME, messageIds: [id], change: 'archive' })).status).toBe(404);
    expect(await other.call('POST', '/api/undo', { id: actions[0] })).toMatchObject({ status: 409, body: { error: `There is no change #${actions[0]}.` } });
    expect(box.requests).toHaveLength(asked);
    expect(box.message(id)!.labelIds).toEqual(['INBOX']);
  });
});

describe('sending mail', () => {
  /** What the composer sends for a press of Send: `id` is the Message-ID it made for that press. */
  const written = (id: string) => ({
    accountId: ME,
    id,
    from: { address: ME, name: 'Me' },
    to: [{ address: 'ada@example.com', name: 'Ada' }],
    cc: [],
    text: 'See you Friday.',
  });
  const mail = (id: string, more: Record<string, unknown> = {}) => ({ ...written(id), subject: 'Friday', ...more });

  /** `withInbox`, with Google letting Sift send from the mailbox. */
  async function canSend() {
    const ready = await withInbox();
    await ready.me.signIn(ME, { send: true });
    return ready;
  }

  it('sends what was written as the person, and keeps it in the record', async () => {
    const { box, me } = await canSend();
    const sent = await me.call('POST', '/api/mail/send', mail('<friday.1@example.org>'));
    expect(sent.status).toBe(200);
    const { id, threadId } = sent.body as { id: string; threadId: string };
    expect(box.sent()).toHaveLength(1);
    const went = box.message(id)!;
    expect(went.header('from')).toBe('"Me" <me@example.org>');
    expect(went.header('to')).toBe('"Ada" <ada@example.com>');
    expect(went.header('subject')).toBe('Friday');
    expect(went.header('message-id')).toBe('<friday.1@example.org>');
    expect((await me.call('GET', `/api/mail/thread?thread=${threadId}`)).body).toMatchObject({ messages: [{ messageId: id, preview: 'See you Friday.' }] });
  });

  it('answers a message in its conversation, naming the one it answers', async () => {
    const { sift, box, me } = await canSend();
    const asked = box.deliver({ from: 'Ada <ada@example.com>', subject: 'Lunch?' });
    await arrives(sift, me);
    const sent = await me.call('POST', '/api/mail/send', { ...written('<re.1@example.org>'), replyTo: { messageId: asked } });
    expect(sent.status).toBe(200);
    const went = box.message((sent.body as { id: string }).id)!;
    expect(went.threadId).toBe(asked);
    expect(went.header('subject')).toBe('Re: Lunch?');
    expect(went.header('in-reply-to')).toBe(`<${asked}@mail.example.com>`);
  });

  it('refuses with Inbox off, or from a mailbox Google has not let it send from', async () => {
    const { box, me } = await withInbox();
    expect(await me.call('POST', '/api/mail/send', mail('<a.1@example.org>'))).toMatchObject({
      status: 409,
      body: { error: `Google has not let Sift send from ${ME}.` },
    });
    await me.signIn(ME, { send: true });
    await me.call('POST', '/api/mail/on', { on: false });
    expect(await me.call('POST', '/api/mail/send', mail('<a.1@example.org>'))).toMatchObject({
      status: 409,
      body: { error: 'Turn Inbox on to send mail from Sift.' },
    });
    expect(box.asked('users.messages.send')).toEqual([]);
  });

  it('sends once when Gmail lost its answer: a retry is refused until Gmail’s search finds what went, then answers with it', async () => {
    const { box, me } = await canSend();
    box.lagSearch = true;
    box.fail('users.messages.send', 'lost');
    const press = mail('<lost.1@example.org>');

    expect((await me.call('POST', '/api/mail/send', press)).status).toBe(500);
    expect(box.sent()).toHaveLength(1);
    expect(await me.call('POST', '/api/mail/send', press)).toMatchObject({ status: 409, body: { error: expect.stringContaining('cannot tell yet') } });
    box.index();
    const found = await me.call('POST', '/api/mail/send', press);
    expect(found).toMatchObject({ status: 200, body: { id: box.sent()[0]!.id } });
    expect(box.asked('users.messages.send')).toHaveLength(1);
    expect(box.sent()).toHaveLength(1);
  });

  it('sends again once a try that never reached Gmail has settled, and an edited draft goes as new mail', async () => {
    const { box, me } = await canSend();
    box.fail('users.messages.send', 'network');
    const press = mail('<retry.1@example.org>');

    expect((await me.call('POST', '/api/mail/send', press)).status).toBe(500);
    expect(box.sent()).toEqual([]);
    expect((await me.call('POST', '/api/mail/send', press)).status).toBe(409);
    vi.setSystemTime(Date.now() + SETTLE_MS);
    expect((await me.call('POST', '/api/mail/send', press)).status).toBe(200);
    expect(box.sent().map((m) => m.header('message-id'))).toEqual(['<retry.1@example.org>']);

    const edited = await me.call('POST', '/api/mail/send', mail('<retry.2@example.org>', { text: 'See you Saturday.' }));
    expect(edited.status).toBe(200);
    expect(box.sent().map((m) => m.header('message-id'))).toEqual(['<retry.1@example.org>', '<retry.2@example.org>']);
  });

  it('sends nothing from someone else’s mailbox', async () => {
    const { sift, box } = await canSend();
    const other = await sift.settled(OTHER);
    expect((await other.call('POST', '/api/mail/send', mail('<theirs.1@example.org>'))).status).toBe(404);
    expect(box.asked('users.messages.send')).toEqual([]);
  });
});

describe('asking Inbox in words', () => {
  it('turns the words into a filter on the list, naming only senders Sift has recorded', async () => {
    const model = fauxModel();
    const { sift, box, me } = await withInbox(model);
    box.deliver({ from: 'Vendor <billing@vendor.example.com>', subject: 'Your invoice' });
    await arrives(sift, me);
    const blank = { reading: '', from: [], domains: [], label: '', view: '', unread: false, since: '', words: [], note: '' };
    model.answers(
      fauxAssistantMessage([fauxToolCall(FIND_TOOL, { query: 'vendor' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall(ASK_TOOL, { ...blank, from: ['billing@vendor.example.com'], words: ['invoice'] })], { stopReason: 'toolUse' }),
    );

    const asked = await me.call('POST', '/api/mail/ask', { words: 'invoices from the vendor', today: '2026-11-18' });
    expect(asked).toMatchObject({ status: 200, body: { filter: { from: ['billing@vendor.example.com'], words: ['invoice'] } } });
    expect(threadsOf(await me.call('GET', '/api/mail/threads?from=billing@vendor.example.com&q=invoice')).map((t) => t.subject)).toEqual(['Your invoice']);
  });

  it('is refused with Inbox off, without asking the model', async () => {
    const model = fauxModel();
    const { me } = await withInbox(model);
    await me.call('POST', '/api/mail/on', { on: false });
    expect(await me.call('POST', '/api/mail/ask', { words: 'invoices', today: '2026-11-18' })).toMatchObject({
      status: 409,
      body: { error: 'Turn Inbox on first.' },
    });
  });
});

everyRouteAnswered('mail');
