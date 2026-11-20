import { beforeEach, describe, expect, it } from 'vitest';
import { press, undo } from '../src/actions/executor.ts';
import { conversation, listThreads } from '../src/dashboard/queries/mail.ts';
import { messageDetail } from '../src/dashboard/queries/messages.ts';
import { scopeFor } from '../src/dashboard/scope.ts';
import { recordSync } from '../src/store/accounts.ts';
import { getAction, lastStandingChange } from '../src/store/actions.ts';
import { recordDecision } from '../src/store/decisions.ts';
import { recordLabels } from '../src/store/messages.ts';
import { sealPart } from '../src/store/content.ts';
import type { Sql } from '../src/store/sql.ts';
import { mailBodies } from '../src/store/query.ts';
import type { Mailbox } from '../src/actions/mailbox.ts';
import { connectGmail, fakeGoogle, openUserDb } from './fixtures.ts';
import type { FakeGmail } from './google.ts';
import { ACCOUNT, facts } from './helpers.ts';
import { plain } from '../src/plain.ts';
import { applyFeedback } from '../src/learn/feedback.ts';

const fake = fakeGoogle();

let db: Sql;
let mailbox: Mailbox;
let gmail: FakeGmail;
let mine: string;
const scope = scopeFor([ACCOUNT], true);
const deps = () => ({ db, mailbox, now: () => 1000 });
const ada = { address: 'ada@example.org', domain: 'example.org', name: 'Ada Lovelace' };
const base = { subscription: 'preserve', reason: 'test', stage: 'model' } as const;

beforeEach(async () => {
  db = await openUserDb(ACCOUNT);
  await recordSync(
    db,
    ACCOUNT,
    [
      // A conversation: Ada's question, the reader's answer from their other client, Ada's reply. Only the newest is unread.
      facts({ messageId: 'q', threadId: 'lunch', subject: 'Lunch?', from: ada, receivedAt: 100, labelIds: ['INBOX'] }),
      facts({ messageId: 'mine', threadId: 'lunch', subject: 'Re: Lunch?', from: { address: ACCOUNT, domain: 'example.org' }, receivedAt: 200, labelIds: [] }),
      facts({ messageId: 'reply', threadId: 'lunch', subject: 'Re: Lunch?', from: ada, receivedAt: 300 }),
      facts({ messageId: 'news', threadId: 'news', subject: 'Widgets', receivedAt: 250 }),
      facts({ messageId: 'gone', threadId: 'gone', subject: 'Archived already', receivedAt: 400, labelIds: [] }),
    ],
    '2',
  );
  await recordDecision(db, ACCOUNT, 'reply', { ...base, disposition: 'review', confidence: 0.4 }, { now: 300 });
  await recordDecision(db, ACCOUNT, 'news', { ...base, disposition: 'archive', labelId: 'newsletter' }, { now: 250 });
  await db
    .insert(mailBodies)
    .values({ accountId: ACCOUNT, messageId: 'reply', bodyText: sealPart(db, ACCOUNT, 'reply', 'text', 'Thursday   works.\nSee you')!, fetchedAt: 300 });
  ({ mailbox, gmail } = connectGmail(fake.google));
  mine = gmail.label('mine');
  gmail.deliver({ id: 'reply', threadId: 'lunch', from: 'Ada Lovelace <ada@example.org>', subject: 'Re: Lunch?', labelIds: ['INBOX', 'UNREAD', mine] });
  gmail.deliver({ id: 'gone', from: 'news@example.com', subject: 'Archived already', labelIds: [] });
});

const list = async (query: Parameters<typeof listThreads>[2] = { view: 'all' }) => plain(await listThreads(db, scope, query));

describe('Inbox’s list', () => {
  it('is the conversations with mail in the inbox, newest first, each with who wrote, what Sift thinks of its newest and the start of its text', async () => {
    const { threads, next } = await list();
    expect(threads.map((t) => t.threadId)).toEqual(['lunch', 'news']);
    expect(threads[0]).toMatchObject({
      subject: 'Re: Lunch?',
      who: ['Ada Lovelace', 'me'],
      messageIds: ['q', 'mine', 'reply'],
      unread: true,
      newestAt: 300,
      preview: 'Thursday works. See you',
      thinks: { disposition: 'review', labelId: null, confidence: 0.4 },
    });
    expect(threads[1]).toMatchObject({ unread: true, thinks: { disposition: 'archive', labelName: 'Newsletters' } });
    expect(next).toBeNull();
  });

  it('narrows by what Sift would do, by label and by unread', async () => {
    const ids = async (query: Parameters<typeof listThreads>[2]) => (await list(query)).threads.map((t) => t.threadId);
    expect(await ids({ view: 'needs' })).toEqual(['lunch']);
    expect(await ids({ view: 'sorted' })).toEqual(['news']);
    expect(await ids({ view: 'all', label: 'newsletter' })).toEqual(['news']);
    await recordLabels(db, ACCOUNT, 'news', ['INBOX']);
    expect(await ids({ view: 'all', unread: true })).toEqual(['lunch']);
  });

  it('narrows by what an Ask makes: senders and domains in any message of it, and when its newest came, past the inbox', async () => {
    const ids = async (query: Partial<Parameters<typeof listThreads>[2]>) => (await list({ view: 'all', ...query })).threads.map((t) => t.threadId);
    expect(await ids({ from: ['ADA@example.org'] })).toEqual(['lunch']);
    expect(await ids({ from: ['nobody@example.org'], domain: ['example.com'] })).toEqual(['gone', 'news']);
    expect(await ids({ domain: ['example.org'] })).toEqual(['lunch']);
    expect(await ids({ since: 260 })).toEqual(['gone', 'lunch']);
  });

  it('goes on from where a page ended', async () => {
    await recordSync(
      db,
      ACCOUNT,
      Array.from({ length: 60 }, (_, i) => facts({ messageId: `bulk${i}`, threadId: `bulk${i}`, receivedAt: 10 })),
      '3',
    );
    const first = await list();
    expect(first.threads).toHaveLength(50);
    const rest = await list({ view: 'all', before: first.next! });
    expect(rest.next).toBeNull();
    expect(new Set([...first.threads, ...rest.threads].map((t) => t.threadId)).size).toBe(62);
  });
});

describe('a conversation', () => {
  it('is its recorded messages, oldest first, each as its folded row shows it', async () => {
    const found = plain(await conversation(db, scope, 'lunch'));
    expect(found?.messages.map((m) => [m.messageId, m.fromName, m.unread, m.preview])).toEqual([
      ['q', 'Ada Lovelace', false, null],
      ['mine', null, false, null],
      ['reply', 'Ada Lovelace', true, 'Thursday works. See you'],
    ]);
    expect(await conversation(db, scopeFor(['other@example.org'], false), 'lunch')).toBeNull();
    expect(await conversation(db, scope, 'nothing')).toBeNull();
  });
});

describe('the reader’s own press', () => {
  it('archives by taking the message out of the inbox alone, written down before Gmail is asked', async () => {
    const { outcome, labels } = await press(deps(), ACCOUNT, 'reply', 'archive');
    expect(outcome).toMatchObject({ status: 'done' });
    expect(labels).toEqual(['UNREAD', mine]);
    expect(await getAction(db, 1)).toMatchObject({
      type: 'archive',
      status: 'done',
      payload: { add: [], remove: ['INBOX'] },
      originalLabels: ['INBOX', 'UNREAD', mine],
    });
    // Not Sift's change, so correcting what Sift said does not take it back.
    expect(await lastStandingChange(db, ACCOUNT, 'reply')).toBeNull();
    expect((await undo(deps(), 1)).status).toBe('done');
    expect(gmail.message('reply')!.labelIds).toEqual(['UNREAD', mine, 'INBOX']);
  });

  it('marks read and unread', async () => {
    expect((await press(deps(), ACCOUNT, 'reply', 'read')).labels).toEqual(['INBOX', mine]);
    expect((await press(deps(), ACCOUNT, 'reply', 'unread')).labels).toEqual(['INBOX', mine, 'UNREAD']);
    expect((await getAction(db, 2))?.type).toBe('unread');
  });

  it('leaves mail that is no longer in the inbox, and says what Gmail holds of it', async () => {
    expect(await press(deps(), ACCOUNT, 'gone', 'archive')).toEqual({ outcome: { status: 'skipped', reason: 'message is not in the inbox' }, labels: [] });
    expect(await press(deps(), ACCOUNT, 'unknown', 'read')).toMatchObject({ outcome: { status: 'skipped' }, labels: null });
    expect(gmail.asked('users.messages.modify')).toEqual([]);
  });

  it('records a change Gmail may not have taken as unknown, to be settled from the mailbox', async () => {
    gmail.fail('users.messages.modify', 'network');
    expect((await press(deps(), ACCOUNT, 'reply', 'archive')).outcome).toMatchObject({ status: 'unknown' });
    expect(await getAction(db, 1)).toMatchObject({ type: 'archive', status: 'unknown' });
  });
});

describe('a message opened from Inbox', () => {
  it('shows the whole text Inbox keeps', async () => {
    expect(plain((await messageDetail(db, scope, 'reply'))?.body)).toBe('Thursday   works.\nSee you');
  });
});

describe('what Inbox says Sift thinks', () => {
  it('is the reader’s own answer where they gave one', async () => {
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'ada@example.org', label: 'newsletter', disposition: 'keep', messageId: 'reply', via: 'gmail' }, 400);
    const [lunch] = (await list({ view: 'all', label: 'newsletter' })).threads;
    expect(lunch?.thinks).toMatchObject({ labelId: 'newsletter', labelName: 'Newsletters', disposition: 'keep', confidence: null });
    expect((await list({ view: 'needs' })).threads.map((t) => t.threadId)).toEqual(['lunch']);
  });
});
