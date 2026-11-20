import { beforeEach, describe, expect, it } from 'vitest';
import { listThreads } from '../src/dashboard/queries/mail.ts';
import { scopeFor } from '../src/dashboard/scope.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { plain } from '../src/plain.ts';
import { indexTerms, matches, searchOf, wordsOf } from '../src/search.ts';
import { loadKeyring } from '../src/secrets.ts';
import { recordSync } from '../src/store/accounts.ts';
import { rekeyContent, sealPart } from '../src/store/content.ts';
import { dropTextBefore } from '../src/store/copies.ts';
import { indexKept, keepText, recordKept, searchDue } from '../src/store/kept.ts';
import { recordLabels } from '../src/store/messages.ts';
import { setMail } from '../src/store/preferences.ts';
import { mailBodies } from '../src/store/query.ts';
import { searchedWords } from '../src/store/search.ts';
import type { Sql } from '../src/store/sql.ts';
import { runOnce } from '../src/work/run.ts';
import { connectGmail, fakeGoogle, freshStore, personWith, raw } from './fixtures.ts';
import { ACCOUNT, facts } from './helpers.ts';

const A = loadKeyring({ SIFT_KEY: 'search-a' });
const B_AFTER_A = loadKeyring({ SIFT_KEY: 'search-b', SIFT_OLD_KEYS: 'search-a' });
const ada = { address: 'ada@example.org', domain: 'example.org', name: 'Ada Lovelace' };
const scope = scopeFor([ACCOUNT], true);
const read = { hasAttachments: false } as const;
const fake = fakeGoogle();

describe('the words search reads', () => {
  it('are runs of letters and digits, lowercased, with accents taken off', () => {
    expect(wordsOf('Café au LAIT, déjà-vu: order #1042 — Ünïcödé')).toEqual(['cafe', 'au', 'lait', 'deja', 'vu', 'order', '1042', 'unicode']);
    expect(wordsOf('ada@example.org')).toEqual(['ada', 'example', 'org']);
  });

  it('are indexed whole and by their starts, from three letters to six', () => {
    expect([...indexTerms(['roofing', 'on'])]).toEqual(['=roofing', '^roo', '^roof', '^roofi', '^roofin', '=on']);
  });
});

describe('a search', () => {
  const words = new Set(['the', 'roofing', 'invoice', 'from', 'march', 'cafe']);
  const found = (typed: string) => matches(words, searchOf(typed)!);

  it('needs every word, in any order, the last also as the start of one, case and accents aside', () => {
    expect(found('March INVOICE')).toBe(true);
    expect(found('invoice march')).toBe(true);
    expect(found('invoice april')).toBe(false);
    expect(found('roo')).toBe(true);
    expect(found('roofing inv')).toBe(true);
    expect(found('Café')).toBe(true);
  });

  it('matches every word but the last whole, and a word under three letters typed alone whole too', () => {
    expect(found('roof invoice')).toBe(false);
    expect(found('march fr')).toBe(true);
    expect(found('fr')).toBe(false);
    expect(found('from march')).toBe(true);
    expect(searchOf(' ,. ')).toBeNull();
  });
});

describe('Inbox’s search', () => {
  let db: Sql;

  beforeEach(async () => {
    ({ db } = await personWith(A, ACCOUNT));
    await setMail(db, true);
    await recordSync(
      db,
      ACCOUNT,
      [
        facts({ messageId: 'q', threadId: 'roof', subject: 'Quote', from: ada, receivedAt: 100, labelIds: ['INBOX'] }),
        facts({ messageId: 'r', threadId: 'roof', subject: 'Re: Quote', from: ada, receivedAt: 200, labelIds: ['INBOX'] }),
        facts({ messageId: 'news', threadId: 'news', subject: 'Widgets weekly', receivedAt: 300 }),
      ],
      '2',
    );
    await keepText(db, ACCOUNT, 'q', { text: 'Here is the quote for the roof.', html: null, read }, 100);
    await keepText(db, ACCOUNT, 'r', { text: 'The invoice is attached. Merci, Hélène', html: null, read }, 200);
    await keepText(db, ACCOUNT, 'news', { text: 'Five stories about widgets.', html: null, read }, 300);
  });

  const found = async (q: string, query: Partial<Parameters<typeof listThreads>[2]> = {}) =>
    plain(await listThreads(db, scope, { view: 'all', q, ...query })).threads.map((t) => [t.threadId, t.place]);

  it('finds words in a message’s text, its sender and its subject, every one in one message, newest conversation first', async () => {
    expect(await found('invoice')).toEqual([['roof', 'inbox']]);
    expect(await found('helene merci')).toEqual([['roof', 'inbox']]);
    expect(await found('lovelace')).toEqual([['roof', 'inbox']]);
    expect(await found('widgets')).toEqual([['news', 'inbox']]);
    expect(await found('the')).toEqual([['roof', 'inbox']]);
    expect(await found('roof invoice')).toEqual([]);
    expect(await found('wid')).toEqual([['news', 'inbox']]);
    expect(await found('example')).toEqual([
      ['news', 'inbox'],
      ['roof', 'inbox'],
    ]);
  });

  it('looks past the inbox, saying where the conversation is, but not into spam or trash', async () => {
    await recordLabels(db, ACCOUNT, 'q', []);
    await recordLabels(db, ACCOUNT, 'r', []);
    expect(await found('roof')).toEqual([['roof', 'archived']]);
    expect(plain(await listThreads(db, scope, { view: 'all' })).threads.map((t) => t.threadId)).toEqual(['news']);
    await recordLabels(db, ACCOUNT, 'q', ['SENT']);
    await recordLabels(db, ACCOUNT, 'r', ['SENT']);
    expect(await found('roof')).toEqual([['roof', 'sent']]);
    await recordLabels(db, ACCOUNT, 'news', ['SPAM']);
    expect(await found('widgets')).toEqual([]);
  });

  it('holds to the other filters, and finds nothing in a mailbox it may not read', async () => {
    expect(await found('example', { from: [ada.address] })).toEqual([['roof', 'inbox']]);
    expect(await found('example', { since: 250 })).toEqual([['news', 'inbox']]);
    expect(plain(await listThreads(db, scopeFor(['other@example.org'], false), { view: 'all', q: 'invoice' })).threads).toEqual([]);
  });

  it('drops a message its index lets through that does not have the words', async () => {
    await db.update(mailBodies).set({ search: new Uint8Array(128).fill(0xff) });
    expect(await found('quote')).toEqual([['roof', 'inbox']]);
    expect(await found('nowhere')).toEqual([]);
  });

  it('pages through what matches, newest first', async () => {
    for (let i = 0; i < 60; i++) {
      await recordKept(
        db,
        ACCOUNT,
        { facts: facts({ messageId: `m${i}`, threadId: `t${i}`, receivedAt: 1000 + i }), text: { text: 'Gutters too.', html: null, read } },
        0,
      );
    }
    const first = plain(await listThreads(db, scope, { view: 'all', q: 'gutters' }));
    expect(first.threads).toHaveLength(50);
    expect(first.threads[0]?.threadId).toBe('t59');
    const rest = plain(await listThreads(db, scope, { view: 'all', q: 'gutters', before: first.next! }));
    expect(rest.next).toBeNull();
    expect(new Set([...first.threads, ...rest.threads].map((t) => t.threadId)).size).toBe(60);
  });

  it('goes with the text: turning Inbox off, and the window letting it go', async () => {
    await recordLabels(db, ACCOUNT, 'q', []);
    await dropTextBefore(db, 150);
    expect(await found('roof')).toEqual([]);
    expect(await found('quote')).toEqual([['roof', 'inbox']]);
    expect(await raw(db).all('SELECT message_id FROM mail_bodies WHERE search IS NOT NULL ORDER BY 1')).toEqual([{ message_id: 'news' }, { message_id: 'r' }]);
    await setMail(db, false);
    expect(await raw(db).all('SELECT search FROM mail_bodies')).toEqual([]);
  });

  it('finds text kept before there was an index once a pass has indexed it, and a second pass changes nothing', async () => {
    await recordSync(db, ACCOUNT, [facts({ messageId: 'old', threadId: 'old', subject: 'Chimney', receivedAt: 50 })], '3');
    await db
      .insert(mailBodies)
      .values({ accountId: ACCOUNT, messageId: 'old', bodyText: sealPart(db, ACCOUNT, 'old', 'text', 'Soot everywhere.')!, fetchedAt: 0 });
    expect(await searchDue(db, ACCOUNT)).toBe(true);
    expect(await found('soot')).toEqual([]);
    const results = await runOnce(db, { ephemeral: memoryEphemeral(), connect: () => connectGmail(fake.google), log: () => {} });
    expect(results[0]).toMatchObject({ indexed: 1 });
    expect(await searchDue(db, ACCOUNT)).toBe(false);
    expect(await found('soot chimney')).toEqual([['old', 'inbox']]);
    expect(await indexKept(db, ACCOUNT, 10, () => false)).toBe(0);
  });

  it('is made again under a new key, and the old one finds nothing in it', async () => {
    const before = await raw(db).all<{ search: Uint8Array }>("SELECT search FROM mail_bodies WHERE message_id = 'r'");
    db = await (await freshStore(B_AFTER_A)).user(db.person!);
    await rekeyContent(db);
    const after = await raw(db).all<{ search: Uint8Array }>("SELECT search FROM mail_bodies WHERE message_id = 'r'");
    expect(Buffer.from(after[0]!.search).equals(Buffer.from(before[0]!.search))).toBe(false);
    expect(await found('invoice')).toEqual([['roof', 'inbox']]);
  });
});

describe('what a message is found by', () => {
  it('is its text, its sender’s name and address, and its subject', () => {
    expect([...searchedWords({ text: 'Hi.', fromName: 'Ada', fromAddress: 'ada@example.org', subject: 'Lunch' })]).toEqual([
      'ada',
      'example',
      'org',
      'lunch',
      'hi',
    ]);
  });
});
