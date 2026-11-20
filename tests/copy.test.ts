import { beforeEach, describe, expect, it } from 'vitest';
import type { GmailApi } from '../src/gmail/api.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { recordSync } from '../src/store/accounts.ts';
import { recordDecision } from '../src/store/decisions.ts';
import { keepText, recordKept } from '../src/store/kept.ts';
import { listUndecided } from '../src/store/messages.ts';
import { setMail } from '../src/store/preferences.ts';
import type { Sql } from '../src/store/sql.ts';
import type { Store } from '../src/store/store.ts';
import { copyMail, copyQuery } from '../src/work/copy.ts';
import { pruneOld } from '../src/work/retention.ts';
import { type RunOptions, dueWork, runOnce } from '../src/work/run.ts';
import { syncAccount, syncWants } from '../src/work/sync.ts';
import { firstAccount, onePerson, raw } from './fixtures.ts';
import { ACCOUNT, DAY, FakeMailbox, type HeldMail, facts, gmailOf, rawMessage, testModel } from './helpers.ts';

const NOW = 2000 * DAY;
const YEAR = 365 * DAY;

let store: Store;
let db: Sql;

const archived = (id: string, at: number, labelIds = ['CATEGORY_UPDATES']): HeldMail => rawMessage(id, { labelIds, internalDate: at });
const ids = async (table: string, column = 'message_id') =>
  (await raw(db).all<{ id: string }>(`SELECT ${column} AS id FROM ${table} ORDER BY 1`)).map((r) => r.id);
const copies = async () =>
  await raw(db).all<{ account_id: string; since: number | null; before: number; finished: boolean }>(
    'SELECT account_id, since, before, finished_at IS NOT NULL AS finished FROM mail_copies ORDER BY account_id',
  );
const copy = (api: Pick<GmailApi, 'searchMail' | 'getMessage' | 'getContent'>, more: { until?: number; now?: () => number } = {}) =>
  copyMail({ db, api, now: () => NOW, ...more }, ACCOUNT);

beforeEach(async () => {
  ({ store, db } = await onePerson(ACCOUNT));
});

describe('copying a mailbox for Inbox', () => {
  it('starts with Inbox, from as far back as it keeps, and lists what is in the inbox however old', async () => {
    await setMail(db, true, { now: NOW, window: 'year' });
    expect(await copies()).toEqual([{ account_id: ACCOUNT, since: NOW - YEAR, before: NOW, finished: false }]);
    const query = copyQuery({ since: NOW - YEAR, before: NOW });
    expect(query).toBe(`{in:inbox after:${(NOW - YEAR) / 1000}} before:${NOW / 1000 + 1} -in:drafts -in:chats`);
    expect(copyQuery({ since: null, before: NOW })).toBe(`before:${NOW / 1000 + 1} -in:drafts -in:chats`);
  });

  it('records each message newest first, a page at a time, with its text, and triages none of it', async () => {
    await setMail(db, true, { now: NOW });
    const mail = Array.from({ length: 150 }, (_, i) => archived(`m${String(i).padStart(3, '0')}`, NOW - (i + 1) * 60_000));
    const api = gmailOf([...mail, archived('junk', NOW - 1000, ['SPAM']), archived('draft', NOW - 2000, ['DRAFT'])]);
    expect(await copy(api)).toBe(152);
    expect(api.calls.filter((c) => c.startsWith('list:'))).toEqual(['list:', 'list:100']);
    expect(api.calls.filter((c) => c.startsWith('whole:'))).toHaveLength(152);
    expect(api.calls.some((c) => c.startsWith('meta:') || c.startsWith('text:'))).toBe(false);
    expect(await ids('mail_bodies')).toEqual(mail.map((m) => m.id));
    expect(await ids('messages', 'id')).toEqual(mail.map((m) => m.id));
    expect(await listUndecided(db, ACCOUNT, 500)).toEqual([]);
    expect(await copies()).toMatchObject([{ finished: true }]);
    expect(await copy(api)).toBeNull();
  });

  it('stops at its limit and goes on where it left off, reading no message twice', async () => {
    await setMail(db, true, { now: NOW });
    let clock = NOW;
    const held = gmailOf(Array.from({ length: 120 }, (_, i) => archived(`m${String(i).padStart(3, '0')}`, NOW - (i + 1) * 60_000)));
    const api = { ...held, getMessage: async (id: string) => ((clock += 1000), await held.getMessage(id)) };
    expect(await copy(api, { until: NOW + 30_000, now: () => clock })).toBe(30);
    expect(await copy(api, { now: () => clock })).toBe(90);
    const reads = held.calls.filter((c) => c.startsWith('whole:'));
    expect(new Set(reads).size).toBe(120);
    expect(reads).toHaveLength(120);
    expect(held.calls.filter((c) => c.startsWith('list:'))).toEqual(['list:', 'list:', 'list:100']);
    expect(await ids('mail_bodies')).toHaveLength(120);
  });

  it('leaves recorded inbox mail to the pass, and reads only the text of other recorded mail', async () => {
    await recordSync(db, ACCOUNT, [facts({ messageId: 'in' }), facts({ messageId: 'out', labelIds: [] })], '1', NOW);
    await setMail(db, true, { now: NOW });
    const api = gmailOf([rawMessage('in', { internalDate: NOW - 1000 }), archived('out', NOW - 2000)]);
    await copy(api);
    expect(api.calls).toEqual(['list:', 'text:out']);
    expect(await ids('mail_bodies')).toEqual(['out']);
  });

  it('turned off part-way, writes nothing after, and what it kept goes', async () => {
    await setMail(db, true, { now: NOW });
    const held = gmailOf(Array.from({ length: 5 }, (_, i) => archived(`m${i}`, NOW - (i + 1) * 60_000)));
    let reads = 0;
    const api = {
      ...held,
      getMessage: async (id: string) => {
        if (++reads === 3) await setMail(db, false);
        return await held.getMessage(id);
      },
    };
    await copy(api);
    expect(reads).toBe(3);
    expect(await ids('messages', 'id')).toEqual(['m0', 'm1']);
    expect(await ids('mail_bodies')).toEqual([]);
    expect(await copies()).toEqual([]);
  });

  it('is one a mailbox, each due as a piece of its own while Inbox is on', async () => {
    ({ store, db } = await onePerson(ACCOUNT, 'me@work.example.org'));
    const options: RunOptions = {
      ephemeral: memoryEphemeral(),
      connect: () => ({ api: gmailOf([]), mailbox: new FakeMailbox() }),
      log: () => {},
      now: () => NOW,
    };
    const copying = async () => (await dueWork(store, options, [db.person!])).filter((w) => w.kind === 'copy');
    expect(await copying()).toEqual([]);
    await setMail(db, true, { now: NOW });
    expect((await copies()).map((c) => c.account_id)).toEqual([ACCOUNT, 'me@work.example.org']);
    expect(await copying()).toHaveLength(2);
    await setMail(db, false);
    expect(await copying()).toEqual([]);
  });
});

describe('Inbox’s window', () => {
  it('widened, copies what it adds; narrowed, lets go of the text and then the records outside it, but not the inbox', async () => {
    await setMail(db, true, { now: NOW, window: 'year' });
    await copy(gmailOf([]));
    await setMail(db, true, { now: NOW, window: 'three_years' });
    expect(await copies()).toEqual([{ account_id: ACCOUNT, since: NOW - 3 * YEAR, before: NOW - YEAR, finished: false }]);
    const old = NOW - 2 * YEAR;
    await copy(gmailOf([archived('old-out', old), rawMessage('old-in', { internalDate: old })]));
    expect(await ids('mail_bodies')).toEqual(['old-in', 'old-out']);

    await setMail(db, true, { now: NOW, window: 'year' });
    expect(await ids('mail_bodies')).toEqual(['old-in']);
    expect(await pruneOld(db, NOW)).toBe(1);
    expect(await ids('messages', 'id')).toEqual(['old-in']);
  });

  it('narrowed while a copy goes on, stops it at the new start', async () => {
    await setMail(db, true, { now: NOW, window: 'all' });
    await setMail(db, true, { now: NOW, window: 'year' });
    expect(await copies()).toEqual([{ account_id: ACCOUNT, since: NOW - YEAR, before: NOW, finished: false }]);
  });
});

describe('retention while Inbox is on', () => {
  const kept = async (id: string, at: number, labelIds: string[]) =>
    await recordKept(
      db,
      ACCOUNT,
      { facts: facts({ messageId: id, receivedAt: at, labelIds }), text: { text: 'Text.', html: null, read: { hasAttachments: false } } },
      at,
    );

  it('keeps what is in the inbox and what is in its window, and once it is off, forgets what Inbox alone recorded after a year', async () => {
    const old = NOW - 2 * YEAR;
    await recordSync(db, ACCOUNT, [facts({ messageId: 'decided', receivedAt: old })], '1', old);
    await recordDecision(
      db,
      ACCOUNT,
      'decided',
      { disposition: 'keep', subscription: 'preserve', labelId: 'personal', stage: 'rules', reason: 'r' },
      { now: old },
    );
    await setMail(db, true, { now: old, window: 'all' });
    await kept('kept-old', old, ['CATEGORY_UPDATES']);
    await kept('kept-new', NOW - DAY, ['CATEGORY_UPDATES']);
    expect(await pruneOld(db, NOW)).toBe(0);

    await setMail(db, true, { now: NOW, window: 'year' });
    expect(await pruneOld(db, NOW)).toBe(1);
    expect(await ids('messages', 'id')).toEqual(['decided', 'kept-new']);

    await setMail(db, false);
    expect(await pruneOld(db, NOW)).toBe(1);
    expect(await ids('messages', 'id')).toEqual(['kept-new']);
  });
});

describe('sync while Inbox is on', () => {
  const added = () => [
    { id: 'new', labelIds: ['INBOX', 'UNREAD'] },
    { id: 'sent', labelIds: ['SENT'] },
    { id: 'filtered', labelIds: ['CATEGORY_PROMOTIONS'] },
    { id: 'draft', labelIds: ['DRAFT'] },
  ];
  const mail = () => added().map((a) => rawMessage(a.id, { labelIds: a.labelIds, internalDate: NOW, ...(a.id === 'sent' ? { from: ACCOUNT } : {}) }));

  it('records what arrived elsewhere and what the person sent, and the inbox’s, each with its text from one read, and triages only the inbox’s', async () => {
    await setMail(db, true, { now: NOW });
    const api = gmailOf(mail(), added());
    expect(await syncWants(db, gmailOf(mail(), added()), await firstAccount(db))).toBe(true);
    const report = await syncAccount(db, api, await firstAccount(db), () => NOW);
    expect(report.kept).toBe(2);
    expect(await ids('messages', 'id')).toEqual(['filtered', 'new', 'sent']);
    expect(await ids('mail_bodies')).toEqual(['filtered', 'new', 'sent']);
    expect(api.calls.toSorted()).toEqual(['whole:filtered', 'whole:new', 'whole:sent']);
    expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.facts.messageId)).toEqual(['new']);
  });

  it('records only the inbox’s while it is off', async () => {
    const api = gmailOf(mail(), added());
    await syncAccount(db, api, await firstAccount(db), () => NOW);
    expect(await ids('messages', 'id')).toEqual(['new']);
    expect(api.calls).toEqual(['meta:new']);
  });
});

describe('the model', () => {
  it('reads the text Inbox holds instead of Gmail', async () => {
    await setMail(db, true, { now: NOW });
    await recordSync(db, ACCOUNT, [facts({ messageId: 'held' })], '1', NOW);
    await keepText(db, ACCOUNT, 'held', { text: 'What Inbox holds.', html: null, read: { hasAttachments: true } }, NOW);
    const api = gmailOf([rawMessage('held')]);
    const bodies: (string | null)[] = [];
    const judge = testModel(async ({ evidence }) => (bodies.push(evidence.body), { label: 'unsure', reason: 'r', confidence: 0.2 }));
    await runOnce(db, {
      ephemeral: memoryEphemeral(),
      connect: () => ({ api, mailbox: new FakeMailbox() }),
      log: () => {},
      now: () => NOW,
      model: async () => judge,
    });
    expect(bodies).toEqual(['What Inbox holds.']);
    expect(api.calls.filter((c) => c === 'text:held' || c === 'whole:held')).toEqual([]);
  });
});
