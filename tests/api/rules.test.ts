import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILL_TOOL, FIND_TOOL } from '../../src/triage/rule-draft.ts';
import { FILTER_CHECK_MINUTES } from '../../src/work/filters.ts';
import { type Browser, fakeGoogle, fauxModel, startSift } from '../fixtures.ts';
import { DAY } from '../helpers.ts';
import { everyRouteAnswered } from './areas.ts';

const fake = fakeGoogle();
const ME = 'me@example.org';
const OTHER = 'other@example.com';
const NEWS = 'news@example.com';
const AT = Date.UTC(2026, 10, 18, 12);

beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'], now: AT, shouldAdvanceTime: true }));
afterEach(() => void vi.useRealTimers());

type Rule = {
  id: string;
  match: Record<string, string[]>;
  labelId: string | null;
  disposition: string | null;
  hits: number;
  filterId: string | null;
  filter: { state: string };
};
const rulesOf = async (b: Browser) => (await b.call('GET', '/api/rules')).body['rules'] as Rule[];
const waitingOn = async (b: Browser, id: string) =>
  (await b.call('GET', `/api/rules/waiting?id=${id}`)).body as { total: number; messages: { messageId: string }[] };

/** Signed in, with mail from `NEWS` the pass recorded and the model read as Receipts, waiting on them. */
async function waiting(model?: ReturnType<typeof fauxModel>) {
  const sift = await startSift(fake.google, model ? { model: model.chosen } : {});
  const box = fake.google.mailbox(ME);
  const me = await sift.settled(ME);
  const news = box.deliver({ from: `News <${NEWS}>`, subject: 'This week' });
  await me.call('POST', '/api/check', {});
  await sift.work();
  await sift.judged(ME, news, 'receipts');
  return { sift, box, me, news };
}

describe('making a rule', () => {
  it('decides the mail waiting that it matches, which the rule then lists, and counts what it decided by day', async () => {
    const { me, news } = await waiting();
    const made = await me.call('POST', '/api/rules', { match: { from: [NEWS] }, disposition: 'keep' });
    expect(made).toMatchObject({ status: 200, body: { replaced: false, redecided: 1, filter: null } });
    const { id } = made.body as { id: string };

    expect(await rulesOf(me)).toMatchObject([{ id, match: { from: [NEWS] }, disposition: 'keep', hits: 1 }]);
    expect(await waitingOn(me, id)).toMatchObject({ total: 1, messages: [{ messageId: news }] });
    const usage = (await me.call('GET', `/api/rules/usage?id=${id}`)).body as { daily: { day: string; changed: number; left: number }[] };
    expect(usage.daily.at(-1)).toEqual({ day: '2026-11-18', changed: 0, left: 1, costUsd: 0 });
    expect((await me.call('GET', '/api/suggestions')).body).toMatchObject({ items: [] });
  });

  it('replaces the rule with exactly its conditions, and refuses one that names a sender by name alone', async () => {
    const { me } = await waiting();
    const { id } = (await me.call('POST', '/api/rules', { match: { from: [NEWS] }, disposition: 'keep' })).body as { id: string };
    expect((await me.call('POST', '/api/rules', { match: { from: [NEWS] }, label: 'receipts' })).body).toMatchObject({ id, replaced: true });
    expect(await rulesOf(me)).toMatchObject([{ id, labelId: 'receipts' }]);
    expect((await me.call('POST', '/api/rules', { match: { fromName: ['News'] }, disposition: 'archive' })).status).toBe(400);
    expect(await rulesOf(me)).toHaveLength(1);
  });

  it('changes what a rule says in place, and removing it hands its mail back to what the model said', async () => {
    const { me, news } = await waiting();
    const { id } = (await me.call('POST', '/api/rules', { match: { from: [NEWS] }, disposition: 'keep' })).body as { id: string };

    expect((await me.call('POST', '/api/rules/edit', { id, match: { from: [NEWS] }, disposition: 'spam' })).status).toBe(200);
    expect(await rulesOf(me)).toMatchObject([{ id, disposition: 'spam' }]);
    expect(await waitingOn(me, id)).toMatchObject({ total: 1 });

    expect(await me.call('POST', '/api/rules/remove', { id })).toMatchObject({ status: 200, body: { redecided: 1 } });
    expect(await rulesOf(me)).toEqual([]);
    expect((await me.call('GET', '/api/suggestions')).body).toMatchObject({ items: [{ messageId: news, labelId: 'receipts', stage: 'model' }] });
  });
});

describe('a rule as a Gmail filter', () => {
  it('is written to Gmail only with Sift on, taken out again, and goes with its rule', async () => {
    const { box, me } = await waiting();
    const { id } = (await me.call('POST', '/api/rules', { match: { from: [NEWS] }, label: 'receipts' })).body as { id: string };
    expect((await me.call('POST', '/api/rules/filter', { id, on: true })).status).toBe(409);
    expect(box.filters).toEqual([]);

    await me.call('POST', '/api/active', { active: true });
    const on = await me.call('POST', '/api/rules/filter', { id, on: true });
    expect(on).toMatchObject({ status: 200, body: { filterId: box.filters[0]?.id, filter: { state: 'active' } } });
    expect(box.filters).toEqual([
      { id: expect.any(String), criteria: { from: NEWS }, action: { addLabelIds: [box.labelId('sift/receipts')], removeLabelIds: ['INBOX'] } },
    ]);
    expect(await rulesOf(me)).toMatchObject([{ id, filterId: box.filters[0]!.id }]);

    expect(await me.call('POST', '/api/rules/filter', { id, on: false })).toMatchObject({ status: 200, body: { filterId: null } });
    expect(box.filters).toEqual([]);
    await me.call('POST', '/api/rules/filter', { id, on: true });
    await me.call('POST', '/api/rules/remove', { id });
    expect(box.filters).toEqual([]);
  });

  it('is brought into line with its rule in Gmail at the next look after the rule changed', async () => {
    const { sift, box, me } = await waiting();
    await me.call('POST', '/api/active', { active: true });
    const { id } = (await me.call('POST', '/api/rules', { match: { from: [NEWS] }, label: 'receipts' })).body as { id: string };
    await me.call('POST', '/api/rules/filter', { id, on: true });
    await me.call('POST', '/api/rules/edit', { id, match: { from: [NEWS] }, label: 'receipts', disposition: 'keep' });

    vi.setSystemTime(Date.now() + FILTER_CHECK_MINUTES * 60_000);
    await me.call('POST', '/api/check', {});
    await sift.work();
    expect(box.filters).toEqual([{ id: expect.any(String), criteria: { from: NEWS }, action: { addLabelIds: [box.labelId('sift/receipts')] } }]);
  });

  it('is refused when Gmail refuses it, with nothing recorded, and written when tried again', async () => {
    const { box, me } = await waiting();
    await me.call('POST', '/api/active', { active: true });
    const { id } = (await me.call('POST', '/api/rules', { match: { from: [NEWS] }, label: 'receipts' })).body as { id: string };
    box.fail('users.settings.filters.create', { status: 500 });

    expect((await me.call('POST', '/api/rules/filter', { id, on: true })).status).toBe(500);
    expect(box.filters).toEqual([]);
    expect(await rulesOf(me)).toMatchObject([{ id, filterId: null }]);
    expect((await me.call('POST', '/api/rules/filter', { id, on: true })).status).toBe(200);
    expect(box.filters).toHaveLength(1);
  });

  it('is found in Gmail when the answer to writing it was lost, rather than written twice, and goes with its rule', async () => {
    const { box, me } = await waiting();
    await me.call('POST', '/api/active', { active: true });
    const { id } = (await me.call('POST', '/api/rules', { match: { from: [NEWS] }, label: 'receipts' })).body as { id: string };
    box.fail('users.settings.filters.create', 'lost');

    expect(await me.call('POST', '/api/rules/filter', { id, on: true })).toMatchObject({ status: 200, body: { filterId: box.filters[0]?.id } });
    expect(box.filters).toHaveLength(1);
    expect((await me.call('POST', '/api/rules/filter', { id, on: true })).status).toBe(200);
    expect(box.filters).toHaveLength(1);
    await me.call('POST', '/api/rules/remove', { id });
    expect(box.filters).toEqual([]);
  });
});

describe('applying a rule to the inbox', () => {
  it('looks at what it would decide in Gmail, once a while, and applying it changes that mail in Gmail', async () => {
    const sift = await startSift(fake.google);
    const box = fake.google.mailbox(ME);
    const before = box.deliver({ from: 'Shop <shop@example.com>', subject: 'Old receipt', at: AT - DAY }, { quietly: true });
    const me = await sift.settled(ME);
    const after = box.deliver({ from: 'Shop <shop@example.com>', subject: 'New receipt' });
    box.deliver({ from: 'ada@example.com', subject: 'Lunch?' });
    await me.call('POST', '/api/check', {});
    await sift.work();
    const { id } = (await me.call('POST', '/api/rules', { match: { from: ['shop@example.com'] }, label: 'receipts' })).body as { id: string };

    const look = await me.call('GET', `/api/rules/inbox?id=${id}`);
    expect(look).toMatchObject({
      status: 200,
      body: {
        messages: 2,
        exact: true,
        examples: [
          { messageId: after, subject: 'New receipt' },
          { messageId: before, subject: 'Old receipt' },
        ],
      },
    });
    const searched = box.asked('users.messages.list').length;
    expect((await me.call('GET', `/api/rules/inbox?id=${id}`)).body).toEqual(look.body);
    expect(box.asked('users.messages.list')).toHaveLength(searched);

    expect((await me.call('POST', '/api/rules/apply', { id })).status).toBe(200);
    expect(await me.call('POST', '/api/rules/apply', { id })).toMatchObject({ status: 409, body: { error: 'Sift is already applying this rule.' } });
    await sift.work();
    await sift.tick();
    for (const message of [before, after])
      expect(box.message(message)!.labelIds).toEqual(['UNREAD', box.labelId('sift/receipts'), box.labelId('sift/did/archived')]);
  });

  it('changes nothing in Gmail once stopped', async () => {
    const { sift, box, me, news } = await waiting();
    const { id } = (await me.call('POST', '/api/rules', { match: { from: [NEWS] }, label: 'receipts' })).body as { id: string };
    await me.call('POST', '/api/rules/apply', { id });
    expect((await me.call('POST', '/api/inbox/stop', { rule: id })).status).toBe(200);
    await sift.work();
    await sift.tick();
    expect(box.message(news)!.labelIds).toEqual(['INBOX', 'UNREAD']);
    expect(box.asked('users.messages.modify')).toEqual([]);
  });
});

describe('a rule drafted by the model', () => {
  it('is filled in from the person’s words and the senders Sift has recorded, and makes nothing', async () => {
    const model = fauxModel();
    const { me } = await waiting(model);
    const blank = { facts: [], label: '', onlyOnceLabelled: false, when: '', markRead: false, unsubscribe: false, note: '', name: '' };
    model.answers(
      fauxAssistantMessage([fauxToolCall(FIND_TOOL, { query: 'news' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall(FILL_TOOL, { ...blank, conditions: [{ by: 'from', value: NEWS }], action: 'archive', markRead: true })], {
        stopReason: 'toolUse',
      }),
    );

    const drafted = await me.call('POST', '/api/rules/draft', { goal: 'Archive the weekly news' });
    expect(drafted).toMatchObject({ status: 200, body: { match: { from: [NEWS] }, disposition: 'archive', markRead: true } });
    expect(await rulesOf(me)).toEqual([]);
  });

  it('is refused without a model', async () => {
    const { me } = await waiting();
    expect(await me.call('POST', '/api/rules/draft', { goal: 'Archive the weekly news' })).toMatchObject({
      status: 409,
      body: { error: 'Choose a model first.' },
    });
  });
});

describe('a rule Sift proposes from answers', () => {
  /** Two of `NEWS`'s mail the model read as Receipts, answered as staying in the inbox: a run Sift proposes a rule from. */
  async function proposed() {
    const ready = await waiting();
    const second = ready.box.deliver({ from: `News <${NEWS}>`, subject: 'Next week' });
    await ready.me.call('POST', '/api/check', {});
    await ready.sift.work();
    await ready.sift.judged(ME, second, 'receipts');
    for (const messageId of [ready.news, second])
      expect((await ready.me.call('POST', '/api/feedback', { accountId: ME, sender: NEWS, label: 'receipts', disposition: 'keep', messageId })).status).toBe(
        200,
      );
    const { proposals } = (await ready.me.call('GET', '/api/suggestions')).body as { proposals: { id: number; disposition: string }[] };
    expect(proposals).toMatchObject([{ disposition: 'keep' }]);
    return { ...ready, proposal: proposals[0]!.id };
  }

  it('is dismissed, once', async () => {
    const { me, proposal } = await proposed();
    expect((await me.call('POST', '/api/proposals', { id: proposal })).status).toBe(200);
    expect((await me.call('GET', '/api/suggestions')).body).toMatchObject({ proposals: [] });
    expect(await me.call('POST', '/api/proposals', { id: proposal })).toMatchObject({ status: 409, body: { error: 'That proposal is no longer open.' } });
  });

  it('is settled by the rule made from it', async () => {
    const { me, proposal } = await proposed();
    expect((await me.call('POST', '/api/rules', { match: { from: [NEWS] }, label: 'receipts', disposition: 'keep', proposal })).status).toBe(200);
    expect((await me.call('GET', '/api/suggestions')).body).toMatchObject({ proposals: [] });
    expect(await rulesOf(me)).toMatchObject([{ match: { from: [NEWS] }, disposition: 'keep' }]);
  });

  it('cannot be dismissed by someone else', async () => {
    const { sift, me, proposal } = await proposed();
    const other = await sift.settled(OTHER);
    expect((await other.call('POST', '/api/proposals', { id: proposal })).status).toBe(409);
    expect((await me.call('GET', '/api/suggestions')).body).toMatchObject({ proposals: [{ id: proposal }] });
  });
});

it('shows and changes no rule of someone else’s', async () => {
  const { sift, box, me } = await waiting();
  await me.call('POST', '/api/active', { active: true });
  const { id } = (await me.call('POST', '/api/rules', { match: { from: [NEWS] }, label: 'receipts' })).body as { id: string };
  await me.call('POST', '/api/rules/filter', { id, on: true });
  const other = await sift.settled(OTHER);
  await other.call('POST', '/api/active', { active: true });

  expect(await rulesOf(other)).toEqual([]);
  expect((await other.call('GET', `/api/rules/inbox?id=${id}`)).status).toBe(404);
  expect(await waitingOn(other, id)).toMatchObject({ total: 0, messages: [] });
  expect((await other.call('GET', `/api/rules/usage?id=${id}`)).body).toMatchObject({ saved: { messages: 0 } });
  expect((await other.call('POST', '/api/rules/edit', { id, match: { from: [NEWS] }, disposition: 'spam' })).status).toBe(409);
  expect((await other.call('POST', '/api/rules/apply', { id })).status).toBe(400);
  await other.call('POST', '/api/rules/filter', { id, on: false });
  await other.call('POST', '/api/rules/remove', { id });
  expect(await rulesOf(me)).toMatchObject([{ id, labelId: 'receipts', disposition: 'archive' }]);
  expect(box.filters).toHaveLength(1);
});

everyRouteAnswered('rules');
