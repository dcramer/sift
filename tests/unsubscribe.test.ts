import type { Sql } from '../src/store/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { reconcile, undo } from '../src/actions/executor.ts';
import { RETRY_AFTER_MS, isPublicAddress, unsubscribe } from '../src/actions/unsubscribe.ts';
import { messageDetail } from '../src/dashboard/queries/messages.ts';
import { recordSync } from '../src/store/accounts.ts';
import { getAction, insertPendingAction } from '../src/store/actions.ts';
import { connectGmail, fakeGoogle, openUserDb, raw } from './fixtures.ts';
import { ACCOUNT, everything, facts } from './helpers.ts';

const fake = fakeGoogle();

const ONE_CLICK = {
  'list-unsubscribe': '<mailto:leave@example.com>, <https://lists.example.com/u/token123>',
  'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
};
const PROVEN = { 'authentication-results': 'mx.google.com; dkim=pass; dmarc=pass' };

let db: Sql;
let posts: { url: string; address: string }[];
let status: number | Error;
let resolves: Record<string, string[]>;
let clock: number;

const deps = () => ({
  db,
  now: () => clock,
  resolve: async (host: string) => {
    const found = resolves[host];
    if (!found) throw new Error('ENOTFOUND');
    return found;
  },
  post: async (url: URL, address: string) => {
    posts.push({ url: url.href, address });
    if (status instanceof Error) throw status;
    return status;
  },
});

async function message(id: string, headers: Record<string, string>, from = 'news@example.com') {
  await recordSync(db, ACCOUNT, [facts({ messageId: id, from: { address: from, domain: from.split('@')[1] ?? '' }, headers })], '2');
}

beforeEach(async () => {
  db = await openUserDb(ACCOUNT);
  posts = [];
  status = 200;
  clock = 500;
  resolves = { 'lists.example.com': ['203.0.113.7'] };
});

describe('unsubscribe', () => {
  it('makes one request to the address that was checked, records it, and says so afterwards', async () => {
    await message('m', { ...ONE_CLICK, ...PROVEN });
    expect((await messageDetail(db, await everything(db), 'm'))?.unsubscribe).toBe('available');
    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toEqual({ status: 'done', actionId: 1 });
    expect(posts).toEqual([{ url: 'https://lists.example.com/u/token123', address: '203.0.113.7' }]);
    // The host is recorded, not the token that identifies the subscriber.
    expect(await getAction(db, 1)).toMatchObject({ type: 'unsubscribe', status: 'done', payload: { unsubscribe: 'lists.example.com' } });
    expect((await messageDetail(db, await everything(db), 'm'))?.unsubscribe).toBe('done');
  });

  it('is never repeated for a sender, and cannot be undone', async () => {
    await message('m', { ...ONE_CLICK, ...PROVEN });
    await message('m2', { ...ONE_CLICK, ...PROVEN });
    await unsubscribe(deps(), ACCOUNT, 'm');
    expect(await unsubscribe(deps(), ACCOUNT, 'm2')).toEqual({ status: 'refused', reason: 'You have already unsubscribed from this sender.' });
    expect(posts).toHaveLength(1);
    await expect(undo({ db, mailbox: connectGmail(fake.google).mailbox }, 1)).rejects.toThrow('cannot be undone');
  });

  it('refuses a list that can only be left by email or a page, and a message that offers nothing', async () => {
    await message('mailto', { 'list-unsubscribe': '<mailto:leave@example.com>', ...PROVEN });
    await message('link', { 'list-unsubscribe': '<https://lists.example.com/u/t>', ...PROVEN });
    await message('none', PROVEN);
    expect(await unsubscribe(deps(), ACCOUNT, 'mailto')).toMatchObject({ status: 'refused', reason: expect.stringContaining('sending an email') });
    expect(await unsubscribe(deps(), ACCOUNT, 'link')).toMatchObject({ status: 'refused' });
    expect(await unsubscribe(deps(), ACCOUNT, 'none')).toEqual({ status: 'refused', reason: 'This message offers no way to unsubscribe.' });
    expect(await unsubscribe(deps(), ACCOUNT, 'missing')).toMatchObject({ status: 'refused' });
    expect((await messageDetail(db, await everything(db), 'mailto'))?.unsubscribe).toBe('manual');
    expect((await messageDetail(db, await everything(db), 'none'))?.unsubscribe).toBe('none');
    expect(posts).toEqual([]);
  });

  it('does not trust the address in a message that did not prove who sent it', async () => {
    await message('m', { ...ONE_CLICK, 'authentication-results': 'mx.google.com; dkim=pass; dmarc=fail' });
    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toMatchObject({ status: 'refused', reason: expect.stringContaining('did not prove who sent it') });
    expect((await messageDetail(db, await everything(db), 'm'))?.unsubscribe).toBe('manual');
    expect(posts).toEqual([]);
  });

  it("trusts only Gmail's own result, not one the sender wrote", async () => {
    for (const [id, results] of [
      ['forged', 'mail.example.com; dkim=pass; dmarc=pass'],
      ['lookalike', 'mx.google.com.example.com; dmarc=pass'],
      ['in-a-comment', '(mx.google.com) mail.example.com; dmarc=pass'],
    ] as const) {
      await message(id, { ...ONE_CLICK, 'authentication-results': results }, `${id}@example.com`);
      expect(await unsubscribe(deps(), ACCOUNT, id), results).toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('did not prove who sent it'),
      });
    }
    await message('versioned', { ...ONE_CLICK, 'authentication-results': ' (received) MX.Google.com 1; dkim=pass; dmarc=pass' }, 'v@example.com');
    expect(await unsubscribe(deps(), ACCOUNT, 'versioned')).toMatchObject({ status: 'done' });
  });

  it('cut short by sift stopping, is settled as unknown and waits a week like a failure, never taken as done', async () => {
    await message('m', { ...ONE_CLICK, ...PROVEN });
    const { mailbox, gmail } = connectGmail(fake.google);
    gmail.deliver({ id: 'm', from: 'news@example.com', labelIds: ['INBOX'] });
    // What unsubscribe() leaves behind when the process ends during the request.
    await insertPendingAction(
      db,
      { accountId: ACCOUNT, messageId: 'm', type: 'unsubscribe', payload: { add: [], remove: [], unsubscribe: 'lists.example.com' }, originalLabels: [] },
      clock,
    );
    expect(await reconcile({ db, mailbox, now: () => clock })).toBe(1);
    expect(await getAction(db, 1)).toMatchObject({ status: 'unknown' });
    expect(await reconcile({ db, mailbox }, { accountId: ACCOUNT, messageId: 'm' })).toBe(0);
    expect(await getAction(db, 1)).toMatchObject({ status: 'unknown' });

    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toMatchObject({ status: 'refused' });
    expect(posts).toHaveLength(0);
    clock += RETRY_AFTER_MS;
    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toMatchObject({ status: 'done' });
    expect(posts).toHaveLength(1);
  });

  it('will not be pointed at this machine or its network', async () => {
    const post = (target: string) => ({ 'list-unsubscribe': `<${target}>`, 'list-unsubscribe-post': 'List-Unsubscribe=One-Click', ...PROVEN });
    resolves = { 'inside.example.com': ['10.0.0.5'], 'mixed.example.com': ['203.0.113.7', '127.0.0.1'], 'lists.example.com': ['203.0.113.7'] };
    const targets = [
      'https://inside.example.com/u',
      'https://mixed.example.com/u',
      'https://127.0.0.1/u',
      'https://[::1]/u',
      'https://lists.example.com:8443/u',
      'https://user:pass@lists.example.com/u',
      'https://nowhere.example.com/u',
    ];
    for (const [index, target] of targets.entries()) {
      await message(`m${index}`, post(target), `s${index}@example.com`);
      expect(await unsubscribe(deps(), ACCOUNT, `m${index}`), target).toMatchObject({ status: 'refused' });
    }
    expect(posts).toEqual([]);
    expect(await raw(db).get('SELECT count(*) AS n FROM actions')).toEqual({ n: 0 });
  });

  it('records a redirect it did not follow, a refusal and a failed request, and leaves the sender alone for a week after each', async () => {
    await message('m', { ...ONE_CLICK, ...PROVEN });
    const later = () => (clock += RETRY_AFTER_MS + 1);
    status = 302;
    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toMatchObject({ status: 'failed', reason: expect.stringContaining('redirect') });
    // sift calls this for every message from the sender; it does not try a failing address again straight away.
    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toMatchObject({ status: 'refused', reason: expect.stringContaining('failed recently') });
    expect(posts).toHaveLength(1);

    later();
    status = 500;
    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toMatchObject({ status: 'failed', reason: expect.stringContaining('(500)') });
    later();
    status = new Error('socket hang up');
    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toMatchObject({ status: 'failed', reason: expect.stringContaining('not known whether it took') });
    expect(await raw(db).all('SELECT status, count(*) AS n FROM actions GROUP BY status')).toEqual([{ status: 'failed', n: 3 }]);
    later();
    status = 204;
    expect(await unsubscribe(deps(), ACCOUNT, 'm')).toMatchObject({ status: 'done' });
  });
});

describe('isPublicAddress', () => {
  it('accepts only addresses on the public internet', () => {
    for (const address of ['203.0.113.7', '8.8.8.8', '2001:4860:4860::8888']) expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '::ffff:10.0.0.1',
      'example.com',
    ])
      expect(isPublicAddress(address), address).toBe(false);
  });
});
