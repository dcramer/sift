import { describe, expect, it } from 'vitest';
import { syncAccount, syncWants } from '../src/work/sync.ts';
import { pullChanges, toFacts } from '../src/gmail/sync.ts';
import { addMailbox, setMailboxAliases } from '../src/store/accounts.ts';
import { connectGmail, fakeGoogle, firstAccount, openUserDb, raw } from './fixtures.ts';
import type { FakeGmail, Mail } from './google.ts';
import { ACCOUNT, DAY, rawMessage } from './helpers.ts';
import { parseAddressList } from '../src/triage/features.ts';

const fake = fakeGoogle();

const HISTORY = 'users.history.list';
const PROFILE = 'users.getProfile';
const SEARCH = 'users.messages.list';
const READ = 'users.messages.get';
const LIMITED = { status: 403, reason: 'userRateLimitExceeded' };

/** Sift's Gmail client and its mailbox, with `arrive` for mail from `News <news@example.com>` unless it says. */
function gmail() {
  const connected = connectGmail(fake.google);
  const box = connected.gmail;
  const arrive = (id: string, mail: Partial<Mail> = {}, how: { quietly?: boolean } = {}) => box.deliver({ id, from: 'News <news@example.com>', ...mail }, how);
  /** Mail to Spam, which history lists and sync leaves alone: enough of it fills a page of history. */
  const spam = (n: number) => {
    for (let i = 0; i < n; i++) box.deliver({ from: 'spam@example.net', labelIds: ['SPAM'] });
  };
  /** What Sift asked of `methods` since the `from`th request, with the page and search each asked for. */
  const since = (from: number, ...methods: string[]) =>
    box.requests
      .slice(from)
      .filter((r) => methods.includes(r.method))
      .map((r) => ({ method: r.method, ...(r.pageToken ? { pageToken: r.pageToken } : {}), ...(r.q ? { q: r.q } : {}) }));
  return { ...connected, arrive, spam, since };
}

describe('pullChanges', () => {
  it('only records the current position on first run', async () => {
    const { api, gmail: box } = gmail();
    expect(await pullChanges(api, null)).toEqual({
      messageIds: [],
      labelChanges: [],
      strays: [],
      elsewhere: [],
      deleted: [],
      historyId: '1000',
      mode: 'start',
    });
    expect(box.requests.map((r) => r.method)).toEqual([PROFILE]);
  });

  it('pages through history, keeps inbox arrivals once each, and keeps mail added elsewhere apart', async () => {
    const { api, gmail: box, arrive, spam, since } = gmail();
    arrive('old', {}, { quietly: true });
    const cursor = box.cursor();
    arrive('a', { labelIds: ['INBOX'] });
    arrive('sent', { from: ACCOUNT, labelIds: ['SENT'] });
    spam(498);
    box.mention('a');
    arrive('b');
    box.delete('old');
    const asked = box.requests.length;
    const pull = await pullChanges(api, cursor);
    expect(since(asked, HISTORY)).toEqual([{ method: HISTORY }, { method: HISTORY, pageToken: '500' }]);
    expect(pull).toEqual({
      messageIds: ['a', 'b'],
      labelChanges: [],
      strays: [],
      elsewhere: ['sent'],
      deleted: ['old'],
      historyId: box.cursor(),
      mode: 'incremental',
    });
  });

  it('keeps as strays what a record names without saying it arrived, and what was put in the inbox', async () => {
    const { api, gmail: box, arrive } = gmail();
    const cursor = box.cursor();
    arrive('a', { labelIds: ['INBOX'] });
    arrive('back', { labelIds: [] }, { quietly: true });
    arrive('opened', {}, { quietly: true });
    arrive('quiet', {}, { quietly: true });
    box.change('back', { add: ['INBOX'] });
    box.change('opened', { remove: ['UNREAD'] });
    box.change('a', { remove: ['INBOX'] });
    box.change('a', { add: ['INBOX'] });
    box.mention('quiet');
    box.mention('quiet');
    expect(await pullChanges(api, cursor)).toEqual({
      messageIds: ['a'],
      labelChanges: [
        { messageId: 'back', added: ['INBOX'], removed: [] },
        { messageId: 'opened', added: [], removed: ['UNREAD'] },
        { messageId: 'a', added: [], removed: ['INBOX'] },
        { messageId: 'a', added: ['INBOX'], removed: [] },
      ],
      strays: ['quiet', 'back'],
      elsewhere: [],
      deleted: [],
      historyId: box.cursor(),
      mode: 'incremental',
    });
  });

  it('falls back to a bounded search when the cursor has expired, reading the new cursor first', async () => {
    const { api, gmail: box, arrive, since } = gmail();
    const cursor = box.cursor();
    arrive('ancient', { at: Date.now() - 30 * DAY }, { quietly: true });
    arrive('old', { at: Date.now() - 2 * DAY });
    arrive('new', { at: Date.now() - 3_600_000 });
    box.expireHistory();
    const asked = box.requests.length;
    const pull = await pullChanges(api, cursor);
    expect(since(asked, HISTORY, PROFILE, SEARCH)).toEqual([{ method: HISTORY }, { method: PROFILE }, { method: SEARCH, q: 'newer_than:7d' }]);
    expect(pull).toEqual({
      messageIds: ['old', 'new'],
      labelChanges: [],
      strays: [],
      elsewhere: [],
      deleted: [],
      historyId: box.cursor(),
      mode: 'recovery',
    });
  });

  it('takes the cursor from the last of many pages, which mail arriving meanwhile moved on', async () => {
    const { api, gmail: box, arrive, since } = gmail();
    const cursor = box.cursor();
    for (let i = 0; i < 1001; i++) arrive(`m${i}`);
    box.meanwhile(HISTORY, () => arrive('late'));
    const asked = box.requests.length;
    const pull = await pullChanges(api, cursor);
    expect(since(asked, HISTORY)).toEqual([{ method: HISTORY }, { method: HISTORY, pageToken: '500' }, { method: HISTORY, pageToken: '1000' }]);
    expect(pull.messageIds).toHaveLength(1002);
    expect(pull.messageIds[0]).toBe('m0');
    expect(pull.messageIds.at(-1)).toBe('late');
    expect(pull.historyId).toBe(box.cursor());
  });

  it('recovers when the cursor expires part-way through the pages, and pages through the search', async () => {
    const { api, gmail: box, arrive, since } = gmail();
    const cursor = box.cursor();
    arrive('from-history');
    box.change('from-history', { remove: ['INBOX'] });
    const at = Date.now() - DAY;
    const ids = Array.from({ length: 501 }, (_, i) => arrive(`d${i}`, { at: at + i * 1000 }));
    box.meanwhile(HISTORY, () => box.expireHistory());
    const asked = box.requests.length;
    const pull = await pullChanges(api, cursor);
    expect(since(asked, HISTORY, PROFILE, SEARCH)).toEqual([
      { method: HISTORY },
      { method: HISTORY, pageToken: '500' },
      { method: PROFILE },
      { method: SEARCH, q: 'newer_than:7d' },
      { method: SEARCH, q: 'newer_than:7d', pageToken: '500' },
    ]);
    // What the first history page said is dropped: the search covers it, and the cursor is the profile's.
    expect(pull).toEqual({
      messageIds: ids,
      labelChanges: [],
      strays: [],
      elsewhere: [],
      deleted: [],
      historyId: box.cursor(),
      mode: 'recovery',
    });
  });

  it('propagates other errors without moving the cursor', async () => {
    const { api, gmail: box, arrive } = gmail();
    const cursor = box.cursor();
    arrive('a');
    box.fail(HISTORY, LIMITED);
    await expect(pullChanges(api, cursor)).rejects.toMatchObject({ status: 403 });
  });
});

describe('toFacts', () => {
  it('lowercases header names and keeps the first of repeated headers', () => {
    const facts = toFacts(
      'acct',
      rawMessage('m', {
        headers: [
          { name: 'FROM', value: '"Ada, L" <Ada@Example.com>' },
          { name: 'To', value: '"Doe, J" <j@example.org>, k@example.org' },
          { name: 'Authentication-Results', value: 'mx.example.org; dkim=pass' },
          { name: 'Authentication-Results', value: 'forged.example; dkim=pass' },
          { name: 'List-ID', value: '<dev.lists.example.com>' },
        ],
      }),
    );
    expect(facts).toMatchObject({
      accountId: 'acct',
      messageId: 'm',
      from: { address: 'ada@example.com', domain: 'example.com', name: 'Ada, L' },
      subject: '',
      receivedAt: 1000,
    });
    expect(facts?.to.map((a) => a.address)).toEqual(['j@example.org', 'k@example.org']);
    expect(facts?.headers['authentication-results']).toBe('mx.example.org; dkim=pass');
    expect(facts?.headers['list-id']).toBe('<dev.lists.example.com>');
  });

  it('returns null without a usable sender', () => {
    expect(toFacts('acct', rawMessage('m', { headers: [{ name: 'Subject', value: 'x' }] }))).toBeNull();
  });
});

describe('parseAddressList', () => {
  it('handles empty input and drops junk', () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('undisclosed-recipients:;, a@example.com').map((a) => a.address)).toEqual(['a@example.com']);
  });
});

const HOUR = 3_600_000;

/** The person's database, its mailbox's cursor where Gmail's history is now. */
async function synced(box: FakeGmail) {
  const db = await openUserDb(ACCOUNT);
  await addMailbox(db, ACCOUNT, box.cursor());
  return db;
}

describe('syncAccount', () => {
  it('records new inbox mail and advances the cursor', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    arrive('a');
    arrive('archived');
    box.change('archived', { remove: ['INBOX'] });
    arrive('gone');
    box.delete('gone');
    arrive('nosender', { from: '' });

    const report = await syncAccount(db, api, await firstAccount(db));
    expect(report.added.map((m) => m.messageId)).toEqual(['a']);
    expect(report.skipped).toBe(3);
    expect((await firstAccount(db)).historyId).toBe(box.cursor());
    expect(await raw(db).all('SELECT id, domain_hash FROM messages')).toEqual([{ id: 'a', domain_hash: 'example.com' }]);
  });

  // Gmail has been seen to name a new message in a history record without listing it as added.
  it('records a stray that is in the inbox and came since the last sync, but not one that left it or older mail put back', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    arrive('old', { at: 2 * HOUR, labelIds: [] }, { quietly: true });
    await syncAccount(db, api, await firstAccount(db), () => 10 * HOUR);
    box.change('old', { add: ['INBOX'] });
    arrive('group', { at: 10 * HOUR + 1000 }, { quietly: true });
    box.mention('group');
    arrive('sent', { from: ACCOUNT, labelIds: ['SENT'], at: 10 * HOUR + 2000 }, { quietly: true });
    box.mention('sent');
    expect(await syncWants(db, api, await firstAccount(db))).toBe(true);

    const report = await syncAccount(db, api, await firstAccount(db), () => 11 * HOUR);
    expect(report.added.map((m) => m.messageId)).toEqual(['group']);
    expect(report.skipped).toBe(0);
  });

  it('looks no further for a stray it has recorded', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    arrive('a');
    await syncAccount(db, api, await firstAccount(db));
    box.mention('a');
    expect(await syncWants(db, api, await firstAccount(db))).toBe(false);
  });

  it('does not report a message as new when the same history names it again', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    arrive('a');
    const before = await firstAccount(db);
    await syncAccount(db, api, before);
    const again = await syncAccount(db, api, before);
    expect(again.added).toEqual([]);
    expect(await raw(db).get('SELECT count(*) AS n FROM messages')).toEqual({ n: 1 });
  });

  it('records every page of a busy day in one pass and leaves the cursor alone if a later page fails', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    const { historyId: cursor } = await firstAccount(db);
    const ids = Array.from({ length: 501 }, (_, i) => arrive(`m${i}`));
    box.failLater(HISTORY, 1, LIMITED);
    await expect(syncAccount(db, api, await firstAccount(db))).rejects.toMatchObject({ status: 403 });
    expect((await firstAccount(db)).historyId).toBe(cursor);
    expect(await raw(db).get('SELECT count(*) AS n FROM messages')).toEqual({ n: 0 });

    arrive('late');
    const report = await syncAccount(db, api, await firstAccount(db));
    expect(report.added.map((m) => m.messageId)).toEqual([...ids, 'late']);
    expect((await firstAccount(db)).historyId).toBe(box.cursor());
  });

  it('after an expired cursor, records what the search finds, skips what it already had, and carries on from the new cursor', async () => {
    const { api, gmail: box, arrive, since } = gmail();
    const db = await synced(box);
    arrive('a');
    await syncAccount(db, api, await firstAccount(db));

    arrive('b');
    box.expireHistory();
    const recovering = box.requests.length;
    const recovered = await syncAccount(db, api, await firstAccount(db));
    expect(recovered.mode).toBe('recovery');
    expect(recovered.added.map((m) => m.messageId)).toEqual(['b']);
    expect(since(recovering, HISTORY, PROFILE, SEARCH)).toEqual([{ method: HISTORY }, { method: PROFILE }, { method: SEARCH, q: 'newer_than:7d' }]);
    expect((await firstAccount(db)).historyId).toBe(box.cursor());

    arrive('c');
    const next = box.requests.length;
    const after = await syncAccount(db, api, await firstAccount(db));
    expect(after.mode).toBe('incremental');
    expect(after.added.map((m) => m.messageId)).toEqual(['c']);
    expect(since(next, HISTORY, PROFILE, SEARCH)).toEqual([{ method: HISTORY }]);
  });

  it('keeps what it fetched before a failure, and fetches only the rest next time', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    const { historyId: cursor } = await firstAccount(db);
    const ids = Array.from({ length: 120 }, (_, i) => arrive(`m${i}`));
    box.failLater(READ, 110, LIMITED);
    await expect(syncAccount(db, api, await firstAccount(db))).rejects.toMatchObject({ status: 403 });
    expect((await firstAccount(db)).historyId).toBe(cursor);
    expect(await raw(db).get('SELECT count(*) AS n FROM messages')).toEqual({ n: 100 });

    const asked = box.requests.length;
    const report = await syncAccount(db, api, await firstAccount(db));
    expect(box.requests.slice(asked).flatMap((r) => (r.method === READ ? [r.id] : []))).toEqual(ids.slice(100));
    expect(report.added.map((m) => m.messageId)).toEqual(ids.slice(100));
    expect((await firstAccount(db)).historyId).toBe(box.cursor());
  });

  it('stops at its time limit with what it fetched recorded and the cursor where it was', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    const { historyId: cursor } = await firstAccount(db);
    for (const id of ['a', 'b', 'c']) arrive(id);
    const clock = () => box.asked(READ).length * 1000;
    const report = await syncAccount(db, api, await firstAccount(db), clock, 1500);
    expect(report).toMatchObject({ unfinished: true });
    expect(report.added.map((m) => m.messageId)).toEqual(['a', 'b']);
    expect((await firstAccount(db)).historyId).toBe(cursor);
    expect(await raw(db).all('SELECT id FROM messages ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('leaves the cursor alone when the search after an expired cursor fails', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    const { historyId: cursor } = await firstAccount(db);
    arrive('a');
    box.expireHistory();
    box.fail(SEARCH, LIMITED);
    await expect(syncAccount(db, api, await firstAccount(db))).rejects.toMatchObject({ status: 403 });
    expect((await firstAccount(db)).historyId).toBe(cursor);
  });

  it('records that the user opened a message, once, whichever page or pass says so', async () => {
    const { api, gmail: box, arrive, spam } = gmail();
    const db = await synced(box);
    arrive('a');
    await syncAccount(db, api, await firstAccount(db), () => 1000);
    const before = await firstAccount(db);

    // `a` is opened, `b` arrives and is opened before sift has seen it, and a message sift never recorded is opened.
    arrive('elsewhere', { labelIds: ['UNREAD'] }, { quietly: true });
    box.change('a', { remove: ['UNREAD'] });
    spam(499);
    arrive('b');
    box.change('b', { remove: ['UNREAD'] });
    box.change('elsewhere', { remove: ['UNREAD'] });
    box.change('a', { add: ['STARRED'] });
    const reads = async () => await raw(db).all('SELECT id, read_at FROM messages ORDER BY id');
    await syncAccount(db, api, before, () => 2000);
    expect(box.asked(HISTORY).filter((r) => r.pageToken === '500')).toHaveLength(1);
    expect(await reads()).toEqual([
      { id: 'a', read_at: 2000 },
      { id: 'b', read_at: 2000 },
    ]);

    // The same history again, as after a crash before the cursor moved, and the user marking it unread and reading it again.
    box.change('a', { add: ['UNREAD'] });
    box.change('a', { remove: ['UNREAD'] });
    await syncAccount(db, api, before, () => 3000);
    expect(await reads()).toEqual([
      { id: 'a', read_at: 2000 },
      { id: 'b', read_at: 2000 },
    ]);
  });

  it('learns nothing about reading from a search after an expired cursor', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    arrive('a', { labelIds: ['INBOX'] });
    box.expireHistory();
    await syncAccount(db, api, await firstAccount(db));
    expect(await raw(db).get('SELECT read_at FROM messages')).toEqual({ read_at: null });
  });

  it("records the owner's send-as addresses on the first sync of a day, and counts mail to them as the owner's", async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    const toAlias = (id: string) => arrive(id, { from: 'ada@example.com', to: 'Me <me@example.com>' });
    const addressed = async () => await raw(db).all("SELECT id, facts->>'addressed' AS addressed FROM messages ORDER BY id");
    const aliases = async () => (await raw(db).get<{ aliases: string[] }>('SELECT aliases FROM mailboxes'))!.aliases;

    toAlias('a');
    await syncAccount(db, api, await firstAccount(db), () => DAY);
    expect(await addressed()).toEqual([{ id: 'a', addressed: 'neither' }]);

    // Added the same day: not looked up again until the next.
    box.sendAs = [{ email: 'me@example.com' }];
    toAlias('b');
    await syncAccount(db, api, await firstAccount(db), () => DAY + 1000);
    expect(await aliases()).toEqual([]);
    toAlias('c');
    await syncAccount(db, api, await firstAccount(db), () => 2 * DAY);
    expect(await aliases()).toEqual(['me@example.com']);
    expect(await addressed()).toEqual([
      { id: 'a', addressed: 'neither' },
      { id: 'b', addressed: 'neither' },
      { id: 'c', addressed: 'to' },
    ]);
  });

  it('keeps the last send-as addresses and goes on syncing when they cannot be read', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    await setMailboxAliases(db, ACCOUNT, ['me@example.com']);
    arrive('a', { from: 'ada@example.com', cc: 'me@example.com' });
    box.fail('users.settings.sendAs.list', LIMITED);
    const report = await syncAccount(db, api, await firstAccount(db));
    expect(report.added.map((m) => m.messageId)).toEqual(['a']);
    expect((await firstAccount(db)).historyId).toBe(box.cursor());
    expect(await raw(db).get("SELECT aliases, facts->>'addressed' AS addressed FROM mailboxes, messages")).toEqual({
      aliases: ['me@example.com'],
      addressed: 'cc',
    });
  });

  it('leaves the cursor alone when a fetch fails', async () => {
    const { api, gmail: box, arrive } = gmail();
    const db = await synced(box);
    const { historyId: cursor } = await firstAccount(db);
    arrive('a');
    box.fail(READ, LIMITED);
    await expect(syncAccount(db, api, await firstAccount(db))).rejects.toMatchObject({ status: 403 });
    expect((await firstAccount(db)).historyId).toBe(cursor);
  });
});
