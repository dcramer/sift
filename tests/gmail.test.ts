import { describe, expect, it } from 'vitest';
import { syncAccount, syncWants } from '../src/work/sync.ts';
import { type GmailApi, HistoryExpiredError, type HistoryPage, type RawMessage } from '../src/gmail/api.ts';
import { pullChanges, toFacts } from '../src/gmail/sync.ts';
import { addMailbox, setMailboxAliases } from '../src/store/accounts.ts';
import { firstAccount, openUserDb, raw } from './fixtures.ts';
import { ACCOUNT, DAY, rawMessage } from './helpers.ts';
import { parseAddressList } from '../src/triage/features.ts';

interface Fake {
  historyId?: string;
  pages?: Record<string, HistoryPage>;
  expired?: boolean;
  /** History pages, by page token, that fail as an expired cursor would. */
  expiredAt?: string[];
  search?: string[];
  searchPages?: Record<string, { ids: string[]; nextPageToken?: string }>;
  messages?: Record<string, RawMessage>;
  /** What `listSendAs` answers, or how it fails. */
  sendAs?: string[] | Error;
}

function fakeApi(fake: Fake): GmailApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getProfile() {
      calls.push('profile');
      return { emailAddress: ACCOUNT, historyId: fake.historyId ?? '900' };
    },
    async listHistory(start, pageToken) {
      calls.push(`history:${start}:${pageToken ?? ''}`);
      if (fake.expired || fake.expiredAt?.includes(pageToken ?? '')) throw new HistoryExpiredError();
      const page = fake.pages?.[pageToken ?? ''];
      if (!page) throw new Error('unexpected page');
      return page;
    },
    async searchInbox(query, pageToken) {
      calls.push(`search:${query}${pageToken ? `:${pageToken}` : ''}`);
      return fake.searchPages?.[pageToken ?? ''] ?? { ids: fake.search ?? [] };
    },
    async inboxSize() {
      return fake.search?.length ?? 0;
    },
    async searchMail() {
      return { ids: [] };
    },
    async mailboxSize() {
      return 0;
    },
    async getMessage() {
      return null;
    },
    async getMetadata(id) {
      return fake.messages?.[id] ?? null;
    },
    async getLabelIds(id) {
      return fake.messages?.[id]?.labelIds ?? null;
    },
    async listLabels() {
      return [];
    },
    async getContent() {
      return null;
    },
    async getThread() {
      return null;
    },
    async listSendAs() {
      if (fake.sendAs instanceof Error) throw fake.sendAs;
      return fake.sendAs ?? [ACCOUNT];
    },
  };
}

describe('pullChanges', () => {
  it('only records the current position on first run', async () => {
    const api = fakeApi({ historyId: '500' });
    expect(await pullChanges(api, null)).toEqual({ messageIds: [], labelChanges: [], strays: [], elsewhere: [], deleted: [], historyId: '500', mode: 'start' });
    expect(api.calls).toEqual(['profile']);
  });

  it('pages through history, keeps inbox arrivals and deduplicates, and keeps mail added elsewhere apart', async () => {
    const api = fakeApi({
      pages: {
        '': {
          additions: [
            { id: 'a', labelIds: ['INBOX'] },
            { id: 'sent', labelIds: ['SENT'] },
          ],
          historyId: '510',
          nextPageToken: 'p2',
        },
        p2: {
          additions: [
            { id: 'a', labelIds: ['INBOX'] },
            { id: 'b', labelIds: ['INBOX', 'UNREAD'] },
          ],
          deleted: ['old'],
          historyId: '520',
        },
      },
    });
    expect(await pullChanges(api, '500')).toEqual({
      messageIds: ['a', 'b'],
      labelChanges: [],
      strays: [],
      elsewhere: ['sent'],
      deleted: ['old'],
      historyId: '520',
      mode: 'incremental',
    });
    expect(api.calls).toEqual(['history:500:', 'history:500:p2']);
  });

  it('keeps as strays what a record names without saying it arrived, and what was put in the inbox', async () => {
    const labelChanges = [
      { messageId: 'back', added: ['INBOX'], removed: [] },
      { messageId: 'opened', added: [], removed: ['UNREAD'] },
      { messageId: 'a', added: ['INBOX'], removed: [] },
    ];
    const api = fakeApi({ pages: { '': { additions: [{ id: 'a', labelIds: ['INBOX'] }], labelChanges, unexplained: ['quiet', 'quiet'], historyId: '510' } } });
    expect(await pullChanges(api, '500')).toEqual({
      messageIds: ['a'],
      labelChanges,
      strays: ['quiet', 'back'],
      elsewhere: [],
      deleted: [],
      historyId: '510',
      mode: 'incremental',
    });
  });

  it('falls back to a bounded search when the cursor has expired, reading the new cursor first', async () => {
    const api = fakeApi({ expired: true, historyId: '900', search: ['new', 'old'] });
    expect(await pullChanges(api, '1')).toEqual({
      messageIds: ['old', 'new'],
      labelChanges: [],
      strays: [],
      elsewhere: [],
      deleted: [],
      historyId: '900',
      mode: 'recovery',
    });
    expect(api.calls).toEqual(['history:1:', 'profile', 'search:newer_than:7d']);
  });

  it('takes the cursor from the last of many pages', async () => {
    const pages: Record<string, HistoryPage> = {};
    for (let n = 0; n < 5; n++) {
      pages[n === 0 ? '' : `p${n}`] = {
        additions: Array.from({ length: 100 }, (_, i) => ({ id: `m${n * 100 + i}`, labelIds: ['INBOX'] })),
        historyId: String(600 + n),
        ...(n < 4 ? { nextPageToken: `p${n + 1}` } : {}),
      };
    }
    const api = fakeApi({ pages });
    const pull = await pullChanges(api, '500');
    expect(pull.messageIds).toHaveLength(500);
    expect(pull.messageIds[0]).toBe('m0');
    expect(pull.messageIds.at(-1)).toBe('m499');
    expect(pull.historyId).toBe('604');
    expect(api.calls).toEqual(['history:500:', 'history:500:p1', 'history:500:p2', 'history:500:p3', 'history:500:p4']);
  });

  it('recovers when the cursor expires part-way through the pages, and pages through the search', async () => {
    const api = fakeApi({
      pages: { '': { additions: [{ id: 'from-history', labelIds: ['INBOX'] }], historyId: '510', nextPageToken: 'p2' } },
      expiredAt: ['p2'],
      historyId: '900',
      searchPages: { '': { ids: ['d', 'c'], nextPageToken: 's2' }, s2: { ids: ['c', 'b', 'a'] } },
    });
    // What the first history page said is dropped: the search covers it, and the cursor is the profile's.
    expect(await pullChanges(api, '500')).toEqual({
      messageIds: ['a', 'b', 'c', 'd'],
      labelChanges: [],
      strays: [],
      elsewhere: [],
      deleted: [],
      historyId: '900',
      mode: 'recovery',
    });
    expect(api.calls).toEqual(['history:500:', 'history:500:p2', 'profile', 'search:newer_than:7d', 'search:newer_than:7d:s2']);
  });

  it('propagates other errors without moving the cursor', async () => {
    const api = fakeApi({});
    await expect(pullChanges(api, '1')).rejects.toThrow('unexpected page');
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

const page = (ids: string[], historyId: string): Record<string, HistoryPage> => ({
  '': { additions: ids.map((id) => ({ id, labelIds: ['INBOX'] })), historyId },
});

const HOUR = 3_600_000;

/** The person's database, its mailbox's cursor at 500. */
async function synced() {
  const db = await openUserDb(ACCOUNT);
  await addMailbox(db, ACCOUNT, '500');
  return db;
}

describe('syncAccount', () => {
  it('records new inbox mail and advances the cursor', async () => {
    const db = await synced();
    const api = fakeApi({
      pages: page(['a', 'archived', 'gone', 'nosender'], '520'),
      messages: { a: rawMessage('a'), archived: rawMessage('archived', { labelIds: ['UNREAD'] }), nosender: rawMessage('nosender', { headers: [] }) },
    });

    const report = await syncAccount(db, api, await firstAccount(db));
    expect(report.added.map((m) => m.messageId)).toEqual(['a']);
    expect(report.skipped).toBe(3);
    expect((await firstAccount(db)).historyId).toBe('520');
    expect(await raw(db).all('SELECT id, domain_hash FROM messages')).toEqual([{ id: 'a', domain_hash: 'example.com' }]);
  });

  // Gmail has been seen to name a new message in a history record without listing it as added.
  it('records a stray that is in the inbox and came since the last sync, but not one that left it or older mail put back', async () => {
    const db = await synced();
    await syncAccount(db, fakeApi({ pages: page([], '510') }), await firstAccount(db), () => 10 * HOUR);
    const pages = {
      '': { additions: [], labelChanges: [{ messageId: 'old', added: ['INBOX'], removed: [] }], unexplained: ['group', 'sent'], historyId: '520' },
    };
    const messages = {
      group: rawMessage('group', { internalDate: 10 * HOUR + 1000 }),
      sent: rawMessage('sent', { labelIds: ['SENT'], internalDate: 10 * HOUR + 2000 }),
      old: rawMessage('old', { internalDate: 2 * HOUR }),
    };
    expect(await syncWants(db, fakeApi({ pages, messages }), await firstAccount(db))).toBe(true);

    const report = await syncAccount(db, fakeApi({ pages, messages }), await firstAccount(db), () => 11 * HOUR);
    expect(report.added.map((m) => m.messageId)).toEqual(['group']);
    expect(report.skipped).toBe(0);
  });

  it('looks no further for a stray it has recorded', async () => {
    const db = await synced();
    await syncAccount(db, fakeApi({ pages: page(['a'], '510'), messages: { a: rawMessage('a') } }), await firstAccount(db));
    const pages = { '': { additions: [], unexplained: ['a'], historyId: '520' } };
    expect(await syncWants(db, fakeApi({ pages }), await firstAccount(db))).toBe(false);
  });

  it('does not report a redelivered message as new', async () => {
    const db = await synced();
    const fake = { pages: page(['a'], '520'), messages: { a: rawMessage('a') } };
    await syncAccount(db, fakeApi(fake), await firstAccount(db));
    const again = await syncAccount(db, fakeApi(fake), await firstAccount(db));
    expect(again.added).toEqual([]);
    expect(await raw(db).get('SELECT count(*) AS n FROM messages')).toEqual({ n: 1 });
  });

  it('records every page of a busy day in one pass and leaves the cursor alone if a later page fails', async () => {
    const db = await synced();
    const pages: Record<string, HistoryPage> = {
      '': { additions: [{ id: 'a', labelIds: ['INBOX'] }], historyId: '510', nextPageToken: 'p2' },
      p2: { additions: [{ id: 'b', labelIds: ['INBOX'] }], historyId: '520', nextPageToken: 'p3' },
    };
    const messages = { a: rawMessage('a'), b: rawMessage('b'), c: rawMessage('c') };
    await expect(syncAccount(db, fakeApi({ pages, messages }), await firstAccount(db))).rejects.toThrow('unexpected page');
    expect((await firstAccount(db)).historyId).toBe('500');
    expect(await raw(db).get('SELECT count(*) AS n FROM messages')).toEqual({ n: 0 });

    pages['p3'] = { additions: [{ id: 'c', labelIds: ['INBOX'] }], historyId: '530' };
    const report = await syncAccount(db, fakeApi({ pages, messages }), await firstAccount(db));
    expect(report.added.map((m) => m.messageId)).toEqual(['a', 'b', 'c']);
    expect((await firstAccount(db)).historyId).toBe('530');
  });

  it('after an expired cursor, records what the search finds, skips what it already had, and carries on from the new cursor', async () => {
    const db = await synced();
    const messages = { a: rawMessage('a'), b: rawMessage('b'), c: rawMessage('c') };
    await syncAccount(db, fakeApi({ pages: page(['a'], '520'), messages }), await firstAccount(db));

    const recovering = fakeApi({ expired: true, historyId: '900', search: ['b', 'a'], messages });
    const recovered = await syncAccount(db, recovering, await firstAccount(db));
    expect(recovered.mode).toBe('recovery');
    expect(recovered.added.map((m) => m.messageId)).toEqual(['b']);
    expect(recovering.calls).toEqual(['history:520:', 'profile', 'search:newer_than:7d']);
    expect((await firstAccount(db)).historyId).toBe('900');

    const next = fakeApi({ pages: page(['c'], '910'), messages });
    const after = await syncAccount(db, next, await firstAccount(db));
    expect(after.mode).toBe('incremental');
    expect(after.added.map((m) => m.messageId)).toEqual(['c']);
    expect(next.calls).toEqual(['history:900:']);
  });

  it('keeps what it fetched before a failure, and fetches only the rest next time', async () => {
    const db = await synced();
    const ids = Array.from({ length: 120 }, (_, i) => `m${i}`);
    const messages = Object.fromEntries(ids.map((id) => [id, rawMessage(id)]));
    const failing = fakeApi({ pages: page(ids, '520'), messages });
    let reads = 0;
    failing.getMetadata = async (id) => {
      if (++reads > 110) throw new Error('rate limited');
      return messages[id] ?? null;
    };
    await expect(syncAccount(db, failing, await firstAccount(db))).rejects.toThrow('rate limited');
    expect((await firstAccount(db)).historyId).toBe('500');
    expect(await raw(db).get('SELECT count(*) AS n FROM messages')).toEqual({ n: 100 });

    const read: string[] = [];
    const next = fakeApi({ pages: page(ids, '520'), messages });
    next.getMetadata = async (id) => (read.push(id), messages[id] ?? null);
    const report = await syncAccount(db, next, await firstAccount(db));
    expect(read).toEqual(ids.slice(100));
    expect(report.added.map((m) => m.messageId)).toEqual(ids.slice(100));
    expect((await firstAccount(db)).historyId).toBe('520');
  });

  it('stops at its time limit with what it fetched recorded and the cursor where it was', async () => {
    const db = await synced();
    const messages = { a: rawMessage('a'), b: rawMessage('b'), c: rawMessage('c') };
    let clock = 0;
    const api = fakeApi({ pages: page(['a', 'b', 'c'], '520'), messages });
    api.getMetadata = async (id) => ((clock += 1000), messages[id as 'a'] ?? null);
    const report = await syncAccount(db, api, await firstAccount(db), () => clock, 1500);
    expect(report).toMatchObject({ unfinished: true });
    expect(report.added.map((m) => m.messageId)).toEqual(['a', 'b']);
    expect((await firstAccount(db)).historyId).toBe('500');
    expect(await raw(db).all('SELECT id FROM messages ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('leaves the cursor alone when the search after an expired cursor fails', async () => {
    const db = await synced();
    const api = fakeApi({ expired: true, historyId: '900' });
    api.searchInbox = async () => {
      throw new Error('network');
    };
    await expect(syncAccount(db, api, await firstAccount(db))).rejects.toThrow('network');
    expect((await firstAccount(db)).historyId).toBe('500');
  });

  it('records that the user opened a message, once, whichever page or pass says so', async () => {
    const db = await synced();
    const messages = { a: rawMessage('a'), b: rawMessage('b', { labelIds: ['INBOX'] }) };
    await syncAccount(db, fakeApi({ pages: page(['a'], '510'), messages }), await firstAccount(db), () => 1000);

    // `a` is opened, `b` arrives and is opened before sift has seen it, and a message sift never recorded is opened.
    const pages: Record<string, HistoryPage> = {
      '': { additions: [], labelChanges: [{ messageId: 'a', added: [], removed: ['UNREAD'] }], historyId: '520', nextPageToken: 'p2' },
      p2: {
        additions: [{ id: 'b', labelIds: ['INBOX', 'UNREAD'] }],
        labelChanges: [
          { messageId: 'b', added: [], removed: ['UNREAD'] },
          { messageId: 'elsewhere', added: [], removed: ['UNREAD'] },
          { messageId: 'a', added: ['STARRED'], removed: [] },
        ],
        historyId: '530',
      },
    };
    const reads = async () => await raw(db).all('SELECT id, read_at FROM messages ORDER BY id');
    await syncAccount(db, fakeApi({ pages, messages }), await firstAccount(db), () => 2000);
    expect(await reads()).toEqual([
      { id: 'a', read_at: 2000 },
      { id: 'b', read_at: 2000 },
    ]);

    // The same history again, as after a crash before the cursor moved, and the user marking it unread and reading it again.
    await syncAccount(db, fakeApi({ pages, messages }), await firstAccount(db), () => 3000);
    expect(await reads()).toEqual([
      { id: 'a', read_at: 2000 },
      { id: 'b', read_at: 2000 },
    ]);
  });

  it('learns nothing about reading from a search after an expired cursor', async () => {
    const db = await synced();
    const api = fakeApi({ expired: true, search: ['a'], messages: { a: rawMessage('a', { labelIds: ['INBOX'] }) } });
    await syncAccount(db, api, await firstAccount(db));
    expect(await raw(db).get('SELECT read_at FROM messages')).toEqual({ read_at: null });
  });

  it("records the owner's send-as addresses on the first sync of a day, and counts mail to them as the owner's", async () => {
    const db = await synced();
    const toAlias = (id: string) =>
      rawMessage(id, {
        headers: [
          { name: 'From', value: 'ada@example.com' },
          { name: 'To', value: 'Me <me@example.com>' },
        ],
      });
    const messages = { a: toAlias('a'), b: toAlias('b'), c: toAlias('c') };
    const addressed = async () => await raw(db).all("SELECT id, facts->>'addressed' AS addressed FROM messages ORDER BY id");
    const aliases = async () => (await raw(db).get<{ aliases: string[] }>('SELECT aliases FROM mailboxes'))!.aliases;

    await syncAccount(db, fakeApi({ pages: page(['a'], '510'), messages, sendAs: [ACCOUNT] }), await firstAccount(db), () => DAY);
    expect(await addressed()).toEqual([{ id: 'a', addressed: 'neither' }]);

    // Added the same day: not looked up again until the next.
    await syncAccount(db, fakeApi({ pages: page(['b'], '520'), messages, sendAs: [ACCOUNT, 'me@example.com'] }), await firstAccount(db), () => DAY + 1000);
    expect(await aliases()).toEqual([]);
    await syncAccount(db, fakeApi({ pages: page(['c'], '530'), messages, sendAs: [ACCOUNT, 'me@example.com'] }), await firstAccount(db), () => 2 * DAY);
    expect(await aliases()).toEqual(['me@example.com']);
    expect(await addressed()).toEqual([
      { id: 'a', addressed: 'neither' },
      { id: 'b', addressed: 'neither' },
      { id: 'c', addressed: 'to' },
    ]);
  });

  it('keeps the last send-as addresses and goes on syncing when they cannot be read', async () => {
    const db = await synced();
    await setMailboxAliases(db, ACCOUNT, ['me@example.com']);
    const messages = {
      a: rawMessage('a', {
        headers: [
          { name: 'From', value: 'ada@example.com' },
          { name: 'Cc', value: 'me@example.com' },
        ],
      }),
    };
    const report = await syncAccount(db, fakeApi({ pages: page(['a'], '520'), messages, sendAs: new Error('network') }), await firstAccount(db));
    expect(report.added.map((m) => m.messageId)).toEqual(['a']);
    expect((await firstAccount(db)).historyId).toBe('520');
    expect(await raw(db).get("SELECT aliases, facts->>'addressed' AS addressed FROM mailboxes, messages")).toEqual({
      aliases: ['me@example.com'],
      addressed: 'cc',
    });
  });

  it('leaves the cursor alone when a fetch fails', async () => {
    const db = await synced();
    const api = fakeApi({ pages: page(['a'], '520') });
    api.getMetadata = async () => {
      throw new Error('network');
    };
    await expect(syncAccount(db, api, await firstAccount(db))).rejects.toThrow('network');
    expect((await firstAccount(db)).historyId).toBe('500');
  });
});
