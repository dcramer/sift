import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Browser, fakeGoogle, modelRun, startSift } from '../fixtures.ts';
import { DAY } from '../helpers.ts';
import { everyRouteAnswered } from './areas.ts';

const fake = fakeGoogle();
const ME = 'me@example.org';
const WORK = 'me@work.example.com';
const OTHER = 'other@example.com';
const SHOP = 'shop@example.com';
const AT = Date.UTC(2026, 10, 18, 12);

beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'], now: AT, shouldAdvanceTime: true }));
afterEach(() => void vi.useRealTimers());

const manage = async (b: Browser) => (await b.call('GET', '/api/manage')).body;

/** Signed in, with a rule that says mail from `SHOP` is a receipt. */
async function withRule() {
  const sift = await startSift(fake.google);
  const box = fake.google.mailbox(ME);
  const me = await sift.settled(ME);
  await me.call('POST', '/api/rules', { match: { from: [SHOP] }, label: 'receipts' });
  /** Mail from `SHOP`, as the next pass, begun by Check now, brings it. */
  const receipt = async () => {
    const id = box.deliver({ from: `Shop <${SHOP}>`, subject: 'Your receipt' });
    expect((await me.call('POST', '/api/check', {})).status).toBe(200);
    await sift.work();
    return id;
  };
  return { sift, box, me, receipt };
}

describe('Sift on and off', () => {
  it('only suggests while off, and carries out what it decides in Gmail once on', async () => {
    const { box, me, receipt } = await withRule();
    const suggested = await receipt();
    expect(box.message(suggested)!.labelIds).toEqual(['INBOX', 'UNREAD']);
    expect(box.asked('users.messages.modify')).toEqual([]);

    expect((await me.call('POST', '/api/active', { active: true })).status).toBe(200);
    expect(await manage(me)).toMatchObject({ active: true });
    const done = await receipt();
    expect(box.message(done)!.labelIds).toEqual(['UNREAD', box.labelId('sift/receipts'), box.labelId('sift/did/archived')]);
    expect(box.message(suggested)!.labelIds).toEqual(['INBOX', 'UNREAD']);

    await me.call('POST', '/api/active', { active: false });
    expect(box.message(await receipt())!.labelIds).toEqual(['INBOX', 'UNREAD']);
  });

  it('checks Gmail now when asked, and counts what was decided and what it saved', async () => {
    const { sift, box, me, receipt } = await withRule();
    await me.call('POST', '/api/active', { active: true });
    box.requests.length = 0;
    const id = await receipt();
    expect(box.asked('users.history.list')).not.toEqual([]);
    await modelRun(await sift.db(ME), { messageId: id, at: AT - 2 * DAY, usage: { model: 'p/m', inputTokens: 10, outputTokens: 5, costUsd: 0.25 } });

    const summary = (await me.call('GET', '/api/summary?days=7')).body;
    expect(summary).toMatchObject({
      days: 7,
      totals: { messages: 1, decided: 1, withoutInference: 1 },
      byDisposition: [{ disposition: 'archive', decisions: 1 }],
    });
    expect((summary['daily'] as { day: string; counts: { rules: number } }[]).at(-1)).toMatchObject({ day: '2026-11-18', counts: { rules: 1 } });
    const labelledToday = async (label: string) =>
      ((await me.call('GET', `/api/summary?days=7&label=${label}`)).body['daily'] as { labelled: number }[]).at(-1)!.labelled;
    expect(await labelledToday('receipts')).toBe(1);
    expect(await labelledToday('everything_else')).toBe(0);
    expect((await me.call('GET', '/api/summary?days=2')).status).toBe(400);

    const usage = (await me.call('GET', '/api/usage')).body;
    expect(usage).toMatchObject({ day: 0, week: 0.25, month: 0.25, saved: { day: { messages: 1 } } });
  });

  it('shows nobody else what it decided, or what it cost', async () => {
    const { sift, me, receipt } = await withRule();
    await modelRun(await sift.db(ME), { messageId: await receipt(), at: AT, usage: { model: 'p/m', inputTokens: 10, outputTokens: 5, costUsd: 0.25 } });
    expect((await me.call('GET', '/api/summary')).body).toMatchObject({ totals: { decided: 1 } });
    const other = await sift.settled(OTHER);
    expect((await other.call('GET', '/api/summary')).body).toMatchObject({ totals: { messages: 0, decided: 0 } });
    expect((await other.call('GET', '/api/usage')).body).toMatchObject({ day: 0, month: 0 });
    expect(await manage(other)).toMatchObject({ owner: false, accounts: [{ id: OTHER }] });
  });
});

describe('the digest', () => {
  it('arrives at the hour the person chose, in their zone', async () => {
    const { me } = await withRule();
    expect((await me.call('POST', '/api/digest', { hour: 18, timeZone: 'Europe/Paris' })).status).toBe(200);
    expect(await manage(me)).toMatchObject({ digest: { hour: 18, timeZone: 'Europe/Paris' } });
    expect((await me.call('POST', '/api/digest', { hour: 18, timeZone: 'Mars/Olympus' })).status).toBe(400);
    expect(await manage(me)).toMatchObject({ digest: { timeZone: 'Europe/Paris' } });
  });
});

describe('going through the inbox', () => {
  it('says what it would take from Gmail’s count, asked once a while', async () => {
    const sift = await startSift(fake.google);
    const box = fake.google.mailbox(ME);
    for (let i = 0; i < 3; i++) box.deliver({ from: `sender${i}@example.com` }, { quietly: true });
    box.deliver({ from: 'archived@example.com', labelIds: [] }, { quietly: true });
    const me = await sift.settled(ME);

    const estimate = await me.call('GET', '/api/inbox?reach=inbox');
    expect(estimate).toMatchObject({ status: 200, body: { messages: 3, model: 3, cost: null } });
    expect((await me.call('GET', '/api/inbox?reach=recent')).body).toEqual(estimate.body);
    expect(box.asked('users.labels.get')).toEqual([{ method: 'users.labels.get', id: 'INBOX' }]);
  });

  it('starts once, shows how far it has gone, and stops when asked', async () => {
    const { me } = await withRule();
    expect((await me.call('POST', '/api/inbox/start', { reach: 'recent' })).status).toBe(200);
    expect(await manage(me)).toMatchObject({ inbox: { going: { done: 0 } } });
    expect(await me.call('POST', '/api/inbox/start', { reach: 'recent' })).toMatchObject({
      status: 409,
      body: { error: 'Sift is already going through your inbox.' },
    });

    expect((await me.call('POST', '/api/inbox/stop', {})).status).toBe(200);
    expect(await manage(me)).toMatchObject({ inbox: { going: null, last: { stopped: true } } });
    expect((await me.call('POST', '/api/inbox/start', { reach: 'recent' })).status).toBe(200);
  });

  it('stops nobody else’s', async () => {
    const { sift, me } = await withRule();
    await me.call('POST', '/api/inbox/start', { reach: 'recent' });
    const other = await sift.settled(OTHER);
    await other.call('POST', '/api/inbox/stop', {});
    expect(await manage(me)).toMatchObject({ inbox: { going: { done: 0 } } });
  });
});

describe('mailboxes', () => {
  it('are added by signing in, made primary, and removed with their access revoked at Google', async () => {
    const sift = await startSift(fake.google);
    const me = await sift.settled(ME);
    await me.signIn(WORK, { add: true });
    expect((await manage(me))['accounts']).toMatchObject([
      { id: ME, primary: true },
      { id: WORK, primary: false },
    ]);

    expect((await me.call('POST', '/api/mailbox/primary', { address: WORK })).status).toBe(200);
    expect((await manage(me))['accounts']).toMatchObject([
      { id: ME, primary: false },
      { id: WORK, primary: true },
    ]);

    expect(fake.google.grantsFor(WORK)).toBe(1);
    expect(await me.call('POST', '/api/mailbox/remove', { address: WORK })).toMatchObject({ status: 200, body: { notRevoked: [], signedOut: false } });
    expect(fake.google.grantsFor(WORK)).toBe(0);
    expect((await manage(me))['accounts']).toMatchObject([{ id: ME, primary: true }]);
    expect(await me.call('POST', '/api/mailbox/remove', { address: ME })).toMatchObject({
      status: 409,
      body: { error: expect.stringContaining('only remaining mailbox') },
    });
  });

  it('are nobody else’s to change', async () => {
    const sift = await startSift(fake.google);
    const me = await sift.settled(ME);
    await me.signIn(WORK, { add: true });
    const other = await sift.settled(OTHER);
    expect((await other.call('POST', '/api/mailbox/primary', { address: WORK })).status).toBe(404);
    expect((await other.call('POST', '/api/mailbox/remove', { address: WORK })).status).toBe(404);
    expect(fake.google.grantsFor(WORK)).toBe(1);
    expect((await manage(me))['accounts']).toMatchObject([{ id: ME, primary: true }, { id: WORK }]);
  });
});

describe('deleting the account', () => {
  it('takes confirming with one of its addresses, revokes every mailbox at Google and ends the session', async () => {
    const sift = await startSift(fake.google);
    const me = await sift.settled(ME);
    await me.signIn(WORK, { add: true });
    expect(await me.call('POST', '/api/account/delete', { address: OTHER })).toMatchObject({ status: 409 });

    expect(await me.call('POST', '/api/account/delete', { address: WORK })).toMatchObject({ status: 200, body: { notRevoked: [], signedOut: true } });
    expect(fake.google.grantsFor(ME) + fake.google.grantsFor(WORK)).toBe(0);
    expect((await me.call('GET', '/api/manage')).status).toBe(401);

    const again = await sift.signedIn(ME);
    expect(await manage(again)).toMatchObject({ labels: [{ id: 'everything_else' }], accounts: [{ id: ME }] });
  });
});

everyRouteAnswered('settings');
