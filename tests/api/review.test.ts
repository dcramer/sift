import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Browser, fakeGoogle, startSift } from '../fixtures.ts';
import { everyRouteAnswered } from './areas.ts';

const fake = fakeGoogle();
const ME = 'me@example.org';
const OTHER = 'other@example.com';
const SHOP = 'shop@example.com';
const NEWS = 'news@example.com';
const AT = Date.UTC(2026, 10, 18, 12);

beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'], now: AT, shouldAdvanceTime: true }));
afterEach(() => void vi.useRealTimers());

type Item = { messageId: string; decisionId: number; sender: string; labelId: string; disposition: string };
type Row = {
  id: number;
  messageId: string;
  stage: string;
  labelId: string | null;
  carryOut: boolean;
  byUser: boolean;
  actionId: number | null;
  actionStatus: string | null;
};
const itemsOf = async (b: Browser, query = '') => (await b.call('GET', `/api/suggestions${query}`)).body['items'] as Item[];
const rowsOf = async (b: Browser, query = '') => (await b.call('GET', `/api/decisions${query}`)).body['rows'] as Row[];

/** Signed in, with a receipt from `SHOP` and a newsletter from `NEWS`, which the model read as Receipts and Leave in inbox. */
async function waiting() {
  const sift = await startSift(fake.google);
  const box = fake.google.mailbox(ME);
  const me = await sift.settled(ME);
  const receipt = box.deliver({ from: `Shop <${SHOP}>`, subject: 'Your receipt', text: 'Thanks for your order.' });
  const news = box.deliver({ from: `News <${NEWS}>`, subject: 'This week', headers: { 'List-Id': '<weekly.example.com>' } });
  await me.call('POST', '/api/check', {});
  await sift.work();
  const decision = await sift.judged(ME, receipt, 'receipts');
  await sift.judged(ME, news, 'everything_else', 'keep');
  return { sift, box, me, receipt, news, decision };
}

describe('For review', () => {
  it('lists what the model would move, with what it would keep when asked, by sender and by what the mail is', async () => {
    const { me, receipt, news, decision } = await waiting();
    expect(await itemsOf(me)).toMatchObject([{ messageId: receipt, decisionId: decision, sender: SHOP, labelId: 'receipts', disposition: 'archive' }]);
    expect((await me.call('GET', '/api/suggestions')).body).toMatchObject({ waiting: 1, active: false });
    expect((await itemsOf(me, '?kept=1')).map((i) => i.messageId).toSorted()).toEqual([receipt, news].toSorted());
    expect((await itemsOf(me, '?kept=1&fact=list')).map((i) => i.messageId)).toEqual([news]);

    expect((await me.call('GET', `/api/suggestion?sender=${SHOP}`)).body).toMatchObject({
      messages: [{ messageId: receipt, decisionId: decision, labelId: 'receipts' }],
    });
    expect((await me.call('GET', `/api/suggestion?sender=${NEWS}`)).body).toMatchObject({ messages: [{ messageId: news }] });
  });

  it('shows nobody else any of it', async () => {
    const { sift } = await waiting();
    const other = await sift.settled(OTHER);
    expect(await itemsOf(other, '?kept=1')).toEqual([]);
    expect((await other.call('GET', `/api/suggestion?sender=${SHOP}`)).body).toEqual({ messages: [] });
    expect(await rowsOf(other)).toEqual([]);
  });
});

describe('an answer', () => {
  it('that agrees is carried out in Gmail, Sift on or off, and its message kept as an example', async () => {
    const { sift, box, me, receipt, decision } = await waiting();
    const answered = await me.call('POST', '/api/feedback', { accountId: ME, sender: SHOP, label: 'receipts', decisionId: decision, messageId: receipt });
    expect(answered).toMatchObject({ status: 200, body: { notFixed: null } });
    await sift.work();
    expect(box.message(receipt)!.labelIds).toEqual(['UNREAD', box.labelId('sift/receipts'), box.labelId('sift/did/archived')]);
    expect(await itemsOf(me)).toEqual([]);
    expect((await rowsOf(me))[0]).toMatchObject({ messageId: receipt, byUser: true, carryOut: true, actionStatus: 'done' });
    expect((await me.call('GET', '/api/examples')).body).toMatchObject({
      examples: [{ messageId: receipt, labelId: 'receipts', status: 'captured' }],
      held: { [ME]: 1 },
    });
  });

  it('that corrects what Sift did takes its change back in Gmail', async () => {
    const { sift, box, me } = await waiting();
    await me.call('POST', '/api/active', { active: true });
    await me.call('POST', '/api/rules', { match: { from: ['deals@example.com'] }, label: 'receipts' });
    const deal = box.deliver({ from: 'deals@example.com', subject: 'A deal' });
    await me.call('POST', '/api/check', {});
    await sift.work();
    expect(box.message(deal)!.labelIds).not.toContain('INBOX');

    expect((await me.call('POST', '/api/feedback', { accountId: ME, sender: 'deals@example.com', label: 'everything_else', messageId: deal })).body).toEqual({
      notFixed: null,
    });
    await sift.work();
    expect(box.message(deal)!.labelIds).toEqual(['UNREAD', 'INBOX']);
    expect(await rowsOf(me, '?status=undone')).toMatchObject([{ messageId: deal, stage: 'rules' }]);
  });

  it('says so when Gmail refuses to take Sift’s change back, keeping the answer', async () => {
    const { sift, box, me } = await waiting();
    await me.call('POST', '/api/active', { active: true });
    await me.call('POST', '/api/rules', { match: { from: ['deals@example.com'] }, label: 'receipts' });
    const deal = box.deliver({ from: 'deals@example.com', subject: 'A deal' });
    await me.call('POST', '/api/check', {});
    await sift.work();
    box.fail('users.messages.modify', { status: 500, reason: 'Backend Error' });

    const answered = await me.call('POST', '/api/feedback', { accountId: ME, sender: 'deals@example.com', label: 'everything_else', messageId: deal });
    expect(answered).toMatchObject({ status: 200, body: { notFixed: expect.stringContaining('Backend Error') } });
    await sift.work();
    expect(box.message(deal)!.labelIds).not.toContain('INBOX');
    expect((await rowsOf(me))[0]).toMatchObject({ messageId: deal, byUser: true, labelId: 'everything_else' });
  });

  it('is refused for someone else’s mailbox', async () => {
    const { sift, me, receipt, decision } = await waiting();
    const other = await sift.settled(OTHER);
    expect(
      (await other.call('POST', '/api/feedback', { accountId: ME, sender: SHOP, label: 'receipts', decisionId: decision, messageId: receipt })).status,
    ).toBe(404);
    expect(await itemsOf(me)).toMatchObject([{ messageId: receipt }]);
  });
});

describe('Activity', () => {
  it('lists every decision newest first, narrowed by where it got to, the words in it and its label', async () => {
    const { me, receipt, news } = await waiting();
    expect((await rowsOf(me)).map((r) => r.messageId)).toEqual([news, receipt]);
    expect((await me.call('GET', '/api/decisions')).body).toMatchObject({ total: 2 });
    expect((await rowsOf(me, '?status=suggested')).map((r) => r.messageId)).toEqual([news, receipt]);
    expect(await rowsOf(me, '?status=done')).toEqual([]);
    expect((await rowsOf(me, '?label=receipts')).map((r) => r.messageId)).toEqual([receipt]);
    expect((await rowsOf(me, '?q=shop')).map((r) => r.messageId)).toEqual([receipt]);
    expect((await rowsOf(me, '?limit=1&offset=1')).map((r) => r.messageId)).toEqual([receipt]);
    expect((await me.call('GET', '/api/decisions?days=3')).status).toBe(400);
  });
});

describe('examples', () => {
  /** `waiting`, with both messages answered and the pass that carries the answers out done, so both are kept as examples. */
  async function answered() {
    const ready = await waiting();
    for (const [sender, label, messageId] of [
      [SHOP, 'receipts', ready.receipt],
      [NEWS, 'everything_else', ready.news],
    ] as const)
      await ready.me.call('POST', '/api/feedback', { accountId: ME, sender, label, messageId });
    await ready.sift.work();
    return ready;
  }

  it('are deleted one at a time or all at once', async () => {
    const { me, receipt, news } = await answered();
    const listed = async () => ((await me.call('GET', '/api/examples')).body['examples'] as { messageId: string }[]).map((e) => e.messageId).toSorted();
    expect(await listed()).toEqual([receipt, news].toSorted());

    expect(await me.call('POST', '/api/examples/delete', { accountId: ME, messageId: receipt })).toMatchObject({ status: 200, body: { deleted: 1 } });
    expect(await listed()).toEqual([news]);
    expect(await me.call('POST', '/api/examples/delete-all', { accountId: ME })).toMatchObject({ status: 200, body: { deleted: 1 } });
    expect((await me.call('GET', '/api/examples')).body).toEqual({ examples: [], held: {} });
  });

  it('are nobody else’s to see or delete', async () => {
    const { sift, me, receipt } = await answered();
    const other = await sift.settled(OTHER);
    expect((await other.call('GET', '/api/examples')).body).toEqual({ examples: [], held: {} });
    expect((await other.call('POST', '/api/examples/delete', { accountId: ME, messageId: receipt })).status).toBe(404);
    expect((await other.call('POST', '/api/examples/delete-all', { accountId: ME })).status).toBe(404);
    expect((await me.call('GET', '/api/examples')).body).toMatchObject({ held: { [ME]: 2 } });
  });

  it('are what a test run replays, on the person’s own model, which it refuses without one', async () => {
    const { sift, me } = await answered();
    expect((await me.call('GET', '/api/evals')).body).toMatchObject({ runs: [], examples: { [ME]: 2 } });
    expect(await me.call('POST', '/api/evals/run', { accountId: ME })).toMatchObject({ status: 409, body: { error: 'Choose a model first.' } });

    await me.call('POST', '/api/model/key', { provider: 'anthropic', key: 'sk-ant-test' });
    await me.call('POST', '/api/model', { model: 'anthropic/claude-sonnet-4-5' });
    const run = await me.call('POST', '/api/evals/run', { accountId: ME, fewShot: false, limit: 1 });
    expect(run).toMatchObject({ status: 200, body: { id: expect.any(Number) } });
    const { id } = run.body as { id: number };
    expect(sift.queued).toContainEqual({ kind: 'eval', person: 1, run: id });
    expect((await me.call('GET', '/api/evals')).body).toMatchObject({ runs: [{ id, accountId: ME, model: 'anthropic/claude-sonnet-4-5', fewShot: false }] });
    expect((await me.call('GET', `/api/eval?id=${id}`)).body).toMatchObject({ run: { id, total: 1 } });

    const other = await sift.settled(OTHER);
    expect((await other.call('GET', `/api/eval?id=${id}`)).status).toBe(404);
    expect((await other.call('GET', '/api/evals')).body).toMatchObject({ runs: [] });
    expect((await other.call('POST', '/api/evals/run', { accountId: ME })).status).toBe(404);
  });
});

everyRouteAnswered('review');
