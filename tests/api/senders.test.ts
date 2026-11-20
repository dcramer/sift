import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHARED, UNKNOWN } from '../../src/dashboard/api/shared/senders.ts';
import { type Browser, fakeGoogle, startSift } from '../fixtures.ts';
import { everyRouteAnswered } from './areas.ts';

const fake = fakeGoogle();
const ME = 'me@example.org';
const OTHER = 'other@example.com';
const ADA = 'ada@example.com';
const BO = 'bo@example.com';
const AT = Date.UTC(2026, 10, 18, 12);

beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'], now: AT, shouldAdvanceTime: true }));
afterEach(() => void vi.useRealTimers());

type Contact = { address: string; name: string | null; given: string | null; rules: number; recent: number };
const contactsOf = async (b: Browser, query = '') => (await b.call('GET', `/api/contacts${query}`)).body as { total: number; rows: Contact[] };

/** Signed in, with mail from Ada (twice) and Bo at example.com, and from a shop, recorded by a pass. */
async function withMail() {
  const sift = await startSift(fake.google);
  const box = fake.google.mailbox(ME);
  const me = await sift.settled(ME);
  box.deliver({ from: `Ada <${ADA}>`, subject: 'Lunch?', at: AT - 3_600_000 });
  box.deliver({ from: `Ada Lovelace <${ADA}>`, subject: 'Tea?', at: AT - 60_000 });
  box.deliver({ from: `Bo <${BO}>`, subject: 'Hello', at: AT - 7_200_000 });
  box.deliver({ from: 'Shop <orders@shop.example.org>', subject: 'Your receipt', at: AT - 10_800_000 });
  /** Mail that arrives now, brought by the next pass. */
  const arrives = async (from: string) => {
    const id = box.deliver({ from, subject: 'More' });
    await me.call('POST', '/api/check', {});
    await sift.work();
    return id;
  };
  await me.call('POST', '/api/check', {});
  await sift.work();
  return { sift, box, me, arrives };
}

describe('a sender’s page', () => {
  it('shows their mail newest first, under each name they used', async () => {
    const { me } = await withMail();
    const page = await me.call('GET', `/api/sender?address=${ADA.toUpperCase()}`);
    expect(page).toMatchObject({ status: 200, body: { kind: 'sender', name: 'Ada Lovelace', profile: { address: ADA, messages: 2, given: null } } });
    expect((page.body['names'] as { name: string; messages: number }[]).map((n) => [n.name, n.messages])).toEqual([
      ['Ada Lovelace', 1],
      ['Ada', 1],
    ]);
    expect(await me.call('GET', '/api/sender?address=nobody@example.com')).toMatchObject({ status: 404, body: { error: UNKNOWN } });
  });

  it('for a domain shows who writes from it, and has none for a domain anyone can get an address at', async () => {
    const { me } = await withMail();
    const page = await me.call('GET', '/api/domain?domain=example.com');
    expect(page).toMatchObject({ status: 200, body: { kind: 'domain', profile: { address: 'example.com', senders: 2 } } });
    expect((page.body['senders'] as { address: string }[]).map((s) => s.address)).toEqual([ADA, BO]);
    expect(await me.call('GET', '/api/domain?domain=gmail.com')).toMatchObject({ status: 404, body: { error: SHARED } });
  });

  it('shows nobody else anything of them', async () => {
    const { sift } = await withMail();
    const other = await sift.settled(OTHER);
    expect((await other.call('GET', `/api/sender?address=${ADA}`)).status).toBe(404);
    expect((await other.call('GET', '/api/domain?domain=example.com')).status).toBe(404);
    expect(await contactsOf(other)).toEqual({ total: 0, rows: [] });
  });
});

describe('contacts', () => {
  it('lists everyone with mail, newest first, a page at a time, and finds them by name or address', async () => {
    const { me } = await withMail();
    const all = await contactsOf(me);
    expect(all.total).toBe(3);
    expect(all.rows.map((r) => [r.address, r.name])).toEqual([
      [ADA, 'Ada Lovelace'],
      [BO, 'Bo'],
      ['orders@shop.example.org', 'Shop'],
    ]);
    expect((await contactsOf(me, '?limit=1&offset=1')).rows.map((r) => r.address)).toEqual([BO]);
    expect((await contactsOf(me, '?q=lovelace')).rows.map((r) => r.address)).toEqual([ADA]);
    expect((await contactsOf(me, '?q=shop')).rows.map((r) => r.address)).toEqual(['orders@shop.example.org']);
  });
});

describe('a standing', () => {
  it('is given in one press as their own rule, shown on their page and in contacts, and carried out on their next mail', async () => {
    const { box, me, arrives } = await withMail();
    await me.call('POST', '/api/active', { active: true });

    expect(await me.call('POST', '/api/standing', { address: BO, standing: 'unwanted' })).toMatchObject({
      status: 200,
      body: { id: expect.any(String), was: null },
    });
    expect((await me.call('GET', `/api/sender?address=${BO}`)).body).toMatchObject({ profile: { given: 'unwanted' } });
    expect((await contactsOf(me, '?standing=unwanted')).rows).toMatchObject([{ address: BO, given: 'unwanted', rules: 1 }]);
    expect((await me.call('GET', '/api/rules')).body).toMatchObject({ rules: [{ match: { from: [BO] }, disposition: 'archive' }] });
    expect(box.message(await arrives(`Bo <${BO}>`))!.labelIds).not.toContain('INBOX');

    expect(await me.call('POST', '/api/standing', { address: BO, standing: 'trusted' })).toMatchObject({ status: 200, body: { was: 'unwanted' } });
    expect((await me.call('GET', '/api/rules')).body['rules']).toHaveLength(1);
    expect(box.message(await arrives(`Bo <${BO}>`))!.labelIds).toContain('INBOX');
  });

  it('is given to a whole domain, and never replaces a rule of theirs that says more', async () => {
    const { me } = await withMail();
    expect((await me.call('POST', '/api/standing', { domain: 'Shop.Example.org', standing: 'unwanted' })).status).toBe(200);
    expect((await me.call('GET', '/api/domain?domain=shop.example.org')).body).toMatchObject({ profile: { given: 'unwanted' } });

    const { id } = (await me.call('POST', '/api/rules', { match: { from: [ADA] }, label: 'receipts' })).body as { id: string };
    expect(await me.call('POST', '/api/standing', { address: ADA, standing: 'blocked' })).toMatchObject({ status: 200, body: { theirs: id } });
    expect((await me.call('GET', '/api/rules')).body).toMatchObject({ rules: [{ match: { fromDomain: ['shop.example.org'] } }, { id, labelId: 'receipts' }] });
    expect((await me.call('POST', '/api/standing', { address: ADA, domain: 'example.com', standing: 'blocked' })).status).toBe(400);
  });

  it('is cleared, and with it the rule and its Gmail filter', async () => {
    const { box, me, arrives } = await withMail();
    await me.call('POST', '/api/active', { active: true });
    const { id } = (await me.call('POST', '/api/standing', { address: BO, standing: 'unwanted' })).body as { id: string };
    await me.call('POST', '/api/rules/filter', { id, on: true });
    expect(box.filters).toHaveLength(1);

    expect((await me.call('POST', '/api/standing/clear', { address: BO })).status).toBe(200);
    expect(box.filters).toEqual([]);
    expect((await me.call('GET', '/api/rules')).body).toEqual({ rules: [] });
    expect((await me.call('GET', `/api/sender?address=${BO}`)).body).toMatchObject({ profile: { given: null } });
    expect(box.message(await arrives(`Bo <${BO}>`))!.labelIds).toContain('INBOX');
    expect((await me.call('POST', '/api/standing/clear', { domain: 'example.com' })).status).toBe(200);
  });

  it('is each person’s own to give and clear', async () => {
    const { sift, me } = await withMail();
    await me.call('POST', '/api/standing', { address: BO, standing: 'unwanted' });
    const other = await sift.settled(OTHER);
    expect((await other.call('POST', '/api/standing/clear', { address: BO })).status).toBe(200);
    expect((await me.call('GET', `/api/sender?address=${BO}`)).body).toMatchObject({ profile: { given: 'unwanted' } });
    expect((await other.call('POST', '/api/standing', { address: BO, standing: 'trusted' })).body).toMatchObject({ was: null });
    expect((await me.call('GET', `/api/sender?address=${BO}`)).body).toMatchObject({ profile: { given: 'unwanted' } });
  });
});

everyRouteAnswered('senders');
