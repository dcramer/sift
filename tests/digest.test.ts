import { beforeEach, describe, expect, it } from 'vitest';
import type { GmailApi, RawMessage } from '../src/gmail/api.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { finishAction, insertPendingAction, setActionStatus } from '../src/store/actions.ts';
import { recordSync } from '../src/store/accounts.ts';
import { recordDecision, settleDecision } from '../src/store/decisions.ts';
import { updateLabel } from '../src/store/labels.ts';
import { setActive } from '../src/store/preferences.ts';
import { addRule } from '../src/store/rules.ts';
import type { Sql } from '../src/store/sql.ts';
import type { Store } from '../src/store/store.ts';
import type { Highlighter } from '../src/triage/digest.ts';
import { type RunOptions, type Work, dueWork, runOnce, runWork } from '../src/work/run.ts';
import { syncAccount, syncWants } from '../src/work/sync.ts';
import { onePerson, raw } from './fixtures.ts';
import { ACCOUNT, FakeMailbox, UNSURE, facts, rawMessage } from './helpers.ts';

const WORK = 'work@example.com';
const HOUR = 3_600_000;
/** 07:00 UTC, the default digest hour with no zone said. */
const SEVEN = Date.UTC(2026, 10, 18, 7);
const DIGEST: Work = { kind: 'digest', person: 1 };

let store: Store;
let db: Sql;
let mailboxes: Map<string, FakeMailbox>;
let inboxes: Map<string, RawMessage[]>;
let clock: number;
let logs: string[];
let asked: number;
let highlight: Highlighter;

const build = (id: string, subject: string): RawMessage =>
  rawMessage(id, { from: 'Builds <builds@ci.example.org>', subject, internalDate: clock, labelIds: ['INBOX', 'UNREAD'] });

/** A Gmail for one mailbox: each history read hands its new mail over once. */
function api(account: string): GmailApi {
  let cursor = 1;
  const inbox = () => inboxes.get(account) ?? [];
  return {
    getProfile: async () => ({ emailAddress: account, historyId: String(cursor) }),
    listHistory: async () => ({
      additions: inbox()
        .splice(0)
        .map((m) => ({ id: m.id, labelIds: m.labelIds })),
      labelChanges: [],
      historyId: String(++cursor),
    }),
    searchInbox: async () => ({ ids: [] }),
    inboxSize: async () => 0,
    searchMail: async () => ({ ids: [] }),
    mailboxSize: async () => 0,
    getMessage: async () => null,
    getMetadata: async () => null,
    getLabelIds: async (id) => mailboxes.get(account)!.labels.get(id) ?? null,
    listLabels: async () => [],
    getThread: async () => null,
    listSendAs: async () => [account],
    getContent: async () => null,
  };
}

const options = (): RunOptions => ({
  ephemeral: memoryEphemeral(),
  connect: (_db, account) => {
    const gmail = api(account.id);
    const held = [...(inboxes.get(account.id) ?? [])];
    return { api: { ...gmail, getMetadata: async (id) => held.find((m) => m.id === id) ?? null }, mailbox: mailboxes.get(account.id)! };
  },
  model: async () => ({
    judge: async () => UNSURE,
    highlight: async (input) => {
      asked++;
      return await highlight(input);
    },
    model: 'test/model',
  }),
  log: (line) => logs.push(line),
  now: () => clock,
});

/** New mail from the build server arriving in `account`, and a pass over it. */
async function arrive(account: string, ...mail: [id: string, subject: string][]) {
  const raws = mail.map(([id, subject]) => build(id, subject));
  for (const m of raws) mailboxes.get(account)!.labels.set(m.id, [...m.labelIds]);
  inboxes.set(account, raws);
  await runOnce(db, options());
}

const digestsDue = async () => (await dueWork(store, options())).filter((w) => w.kind === 'digest');

/** The digests put into a mailbox, read as Gmail would show them. */
function delivered(account = ACCOUNT): { subject: string; text: string }[] {
  const decode = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\r\n/g, '')), (c) => c.charCodeAt(0)));
  return [...mailboxes.get(account)!.inserted.values()].map((raw) => ({
    subject: decode(/Subject: =\?UTF-8\?B\?([^?]+)\?=/.exec(raw)![1]!),
    text: decode(raw.split('Content-Transfer-Encoding: base64\r\n\r\n')[1]!.split('\r\n--')[0]!),
  }));
}

beforeEach(async () => {
  ({ store, db } = await onePerson(ACCOUNT, WORK));
  mailboxes = new Map([
    [ACCOUNT, new FakeMailbox()],
    [WORK, new FakeMailbox()],
  ]);
  inboxes = new Map();
  clock = SEVEN - 4 * HOUR;
  logs = [];
  asked = 0;
  highlight = async () => ({ picks: [] });
  await setActive(db, true);
  await updateLabel(db, 'notification', { digest: true });
  await addRule(db, { match: { from: ['builds@ci.example.org'] }, labelId: 'notification' }, 'user');
});

describe('a daily digest', () => {
  it('archives the label’s mail as it arrives, and puts it in the inbox once a day, from every mailbox', async () => {
    await arrive(ACCOUNT, ['b1', 'Run 1 passed']);
    clock += HOUR;
    await arrive(WORK, ['w1', 'Run 2 failed']);
    expect(mailboxes.get(ACCOUNT)!.labels.get('b1')).not.toContain('INBOX');
    expect(mailboxes.get(WORK)!.labels.get('w1')).not.toContain('INBOX');

    clock = SEVEN + 6 * 60_000;
    expect(await digestsDue()).toEqual([DIGEST]);
    await runWork(store, DIGEST, options(), clock + 60_000);
    const [digest] = delivered();
    expect(digest?.subject).toBe('Notifications digest for Wed, Nov 18: 2 messages');
    expect(digest?.text).toContain('Run 2 failed');
    expect(digest?.text).toContain('https://mail.google.com/mail/u/work%40example.com/#all/w1');
    expect(digest?.text).toContain('2 messages Sift archived since Tue, Nov 17, 7:00\u00a0AM');
    expect(delivered(WORK)).toEqual([]);
    expect([...mailboxes.get(ACCOUNT)!.labels.get('inserted-1')!]).toEqual(['INBOX', 'UNREAD', 'L:sift/digest']);
    expect(await raw(db).all('SELECT label_id, account_id, since, until, count, gmail_id FROM digests')).toEqual([
      { label_id: 'notification', account_id: ACCOUNT, since: SEVEN - 24 * HOUR, until: SEVEN, count: 2, gmail_id: 'inserted-1' },
    ]);
    expect(await raw(db).all("SELECT account_id, message_id, status FROM actions WHERE type = 'digest'")).toEqual([
      { account_id: ACCOUNT, message_id: null, status: 'done' },
    ]);
    expect(logs.at(-1)).toBe(`${ACCOUNT}: put 1 digest in the inbox`);
    expect(await digestsDue()).toEqual([]);

    // The next covers what came after this one, and nothing again.
    clock += HOUR;
    await arrive(ACCOUNT, ['b2', 'Run 3 passed']);
    clock = SEVEN + 24 * HOUR + 5 * 60_000;
    await runWork(store, DIGEST, options(), clock + 60_000);
    expect(delivered().map((d) => d.subject)).toEqual(['Notifications digest for Wed, Nov 18: 2 messages', 'Notifications digest for Thu, Nov 19: 1 message']);
    expect(delivered()[1]!.text).not.toContain('Run 1');
  });

  it('links back to the dashboard where the host says it is reached', async () => {
    await arrive(ACCOUNT, ['b1', 'Run 1 passed']);
    clock = SEVEN + 6 * 60_000;
    await runWork(store, DIGEST, { ...options(), dashboard: 'https://sift.example.com' }, clock + 60_000);
    expect(delivered()[0]!.text).toContain('See them in Sift: https://sift.example.com/activity?label=notification');
  });

  it('is due at the hour of the person’s own day, five minutes on, and only with something in it', async () => {
    await raw(db).run("UPDATE preferences SET digest_hour = 6, time_zone = 'America/Los_Angeles'");
    clock = Date.UTC(2026, 10, 18, 9);
    await arrive(ACCOUNT, ['b1', 'Run 1 passed']);
    // 6:00 in Los Angeles is 14:00 UTC.
    clock = Date.UTC(2026, 10, 18, 13, 59);
    expect(await digestsDue()).toEqual([]);
    clock = Date.UTC(2026, 10, 18, 14, 4);
    expect(await digestsDue()).toEqual([]);
    clock = Date.UTC(2026, 10, 18, 14, 5);
    expect(await digestsDue()).toEqual([DIGEST]);

    // An empty day begins nothing, and its window stays open for the next.
    await runWork(store, DIGEST, options(), clock + 60_000);
    clock += 24 * HOUR;
    expect(await digestsDue()).toEqual([]);
    clock += HOUR;
    await arrive(ACCOUNT, ['b2', 'Run 2 passed']);
    clock += 24 * HOUR;
    await runWork(store, DIGEST, options(), clock + 60_000);
    // The second waited two days for mail, and says so.
    expect(delivered().map((d) => d.subject)).toEqual([
      'Notifications digest for Wed, Nov 18: 1 message',
      'Notifications digest for Nov 18\u2009–\u200920: 1 message',
    ]);
    expect(await raw(db).all('SELECT since, until FROM digests ORDER BY id')).toEqual([
      { since: Date.UTC(2026, 10, 17, 14), until: Date.UTC(2026, 10, 18, 14) },
      { since: Date.UTC(2026, 10, 18, 14), until: Date.UTC(2026, 10, 20, 14) },
    ]);
  });

  it('waits while Sift is off', async () => {
    await arrive(ACCOUNT, ['b1', 'Run 1 passed']);
    await setActive(db, false);
    clock = SEVEN + HOUR;
    expect(await digestsDue()).toEqual([]);
  });

  it('lists only what Sift archived for the label by itself and that is still archived', async () => {
    const T = SEVEN - 2 * HOUR;
    /** A message of the label's, decided as `decision` says and archived at `at`. */
    const archived = async (id: string, decision: { digest?: boolean; byUser?: boolean } = {}, at = T) => {
      await recordSync(db, ACCOUNT, [facts({ messageId: id, subject: `Subject ${id}` })], '2', at);
      const decided = await recordDecision(
        db,
        ACCOUNT,
        id,
        {
          disposition: 'archive',
          subscription: 'preserve',
          labelId: 'notification',
          stage: 'rules',
          reason: 'r',
          ...(decision.digest === false ? {} : { digest: true }),
        },
        { carryOut: true, byUser: decision.byUser ?? false, now: at },
      );
      const action = await insertPendingAction(
        db,
        { accountId: ACCOUNT, messageId: id, type: 'archive', payload: { add: [], remove: ['INBOX'] }, originalLabels: ['INBOX'], decisionId: decided },
        at,
      );
      await finishAction(db, action, 'done', [], null, at);
      await settleDecision(db, decided, 'done');
      return action;
    };
    await archived('in');
    await archived('answered', { byUser: true });
    await archived('kept-as-archive', { digest: false });
    await setActionStatus(db, await archived('undone'), 'undone');
    await archived('later', {}, SEVEN + 60_000);
    await archived('then-answered');
    await recordDecision(
      db,
      ACCOUNT,
      'then-answered',
      { disposition: 'keep', subscription: 'preserve', labelId: 'notification', stage: 'rules', reason: 'you said' },
      { byUser: true, now: T },
    );

    clock = SEVEN + 5 * 60_000;
    await runWork(store, DIGEST, options(), clock + 60_000);
    const [digest] = delivered();
    expect(digest?.subject).toBe('Notifications digest for Wed, Nov 18: 1 message');
    expect(digest?.text).toContain('Subject in\n');
    for (const out of ['answered', 'kept-as-archive', 'undone', 'later', 'then-answered']) expect(digest?.text).not.toContain(`Subject ${out}\n`);
  });

  it('puts each digest in once, however often its step is run', async () => {
    await arrive(ACCOUNT, ['b1', 'Run 1 passed']);
    clock = SEVEN + 5 * 60_000;
    const box = mailboxes.get(ACCOUNT)!;

    // Gmail took it, but its answer was lost: the next run finds it rather than putting it in again.
    box.failInsert = 'after';
    await runWork(store, DIGEST, options(), clock + 60_000);
    expect(logs.at(-1)).toMatch(/Daily digests failed, will retry/);
    expect(await digestsDue()).toEqual([DIGEST]);
    box.failInsert = null;
    await runWork(store, DIGEST, options(), clock + 60_000);
    expect(box.inserted.size).toBe(1);
    expect(await raw(db).all('SELECT gmail_id FROM digests')).toEqual([{ gmail_id: 'inserted-1' }]);
    expect(await raw(db).all("SELECT status FROM actions WHERE type = 'digest' ORDER BY id")).toEqual([{ status: 'done' }]);
    expect(asked).toBe(1);
    expect(await digestsDue()).toEqual([]);

    // Gmail never took it: the next run puts it in, as it was written.
    await arrive(ACCOUNT, ['b2', 'Run 2 passed']);
    clock += 24 * HOUR;
    box.failInsert = 'before';
    await runWork(store, DIGEST, options(), clock + 60_000);
    box.failInsert = null;
    await runWork(store, DIGEST, options(), clock + 60_000);
    expect(box.inserted.size).toBe(2);
    expect(await raw(db).all("SELECT status FROM actions WHERE type = 'digest' ORDER BY id")).toEqual([
      { status: 'done' },
      { status: 'failed' },
      { status: 'done' },
    ]);
    expect(asked).toBe(2);
  });

  it('keeps track of a digest Gmail took, even once its mail has all been answered', async () => {
    await arrive(ACCOUNT, ['b1', 'Run 1 passed']);
    clock = SEVEN + 5 * 60_000;
    const box = mailboxes.get(ACCOUNT)!;
    box.failInsert = 'after';
    await runWork(store, DIGEST, options(), clock + 60_000);
    box.failInsert = null;
    await recordDecision(
      db,
      ACCOUNT,
      'b1',
      { disposition: 'keep', subscription: 'preserve', labelId: 'notification', stage: 'rules', reason: 'you said' },
      { byUser: true, now: clock },
    );

    await runWork(store, DIGEST, options(), clock + 60_000);
    expect(box.inserted.size).toBe(1);
    expect(await raw(db).all('SELECT gmail_id FROM digests')).toEqual([{ gmail_id: 'inserted-1' }]);
    expect(await raw(db).all("SELECT status FROM actions WHERE type = 'digest'")).toEqual([{ status: 'done' }]);
    expect(await digestsDue()).toEqual([]);
  });

  it('heads the digest with what the model picks, and goes without when it fails', async () => {
    await arrive(ACCOUNT, ['b1', 'Run 1 passed'], ['b2', 'Run 2 failed'], ['b3', 'Run 3 passed']);
    let shown = '';
    highlight = async (input) => {
      shown = JSON.stringify(input);
      return {
        picks: [{ item: input.lines.findIndex((l) => l.subject === 'Run 2 failed') + 1, why: 'The only failure.' }],
        usage: { model: 'test/model', inputTokens: 900, outputTokens: 20, costUsd: 0.002 },
      };
    };
    clock = SEVEN + 5 * 60_000;
    await runWork(store, DIGEST, options(), clock + 60_000);
    expect(shown).not.toContain('Body');
    expect(delivered()[0]).toMatchObject({ subject: 'Notifications digest for Wed, Nov 18: 3 messages, 1 worth a look' });
    expect(delivered()[0]!.text).toMatch(/WORTH A LOOK\n\nBuilds: Run 2 failed\n {2}The only failure\./);
    expect(await raw(db).get('SELECT model, error, input_tokens, cost_usd FROM digests')).toEqual({
      model: 'test/model',
      error: null,
      input_tokens: 900,
      cost_usd: 0.002,
    });

    await arrive(ACCOUNT, ['b4', 'Run 4 passed']);
    highlight = async () => ({ failed: 'timeout' });
    clock += 24 * HOUR;
    await runWork(store, DIGEST, options(), clock + 60_000);
    expect(delivered()[1]).toMatchObject({ subject: 'Notifications digest for Thu, Nov 19: 1 message' });
    expect(await raw(db).all('SELECT error FROM digests ORDER BY id')).toEqual([{ error: null }, { error: 'timeout' }]);
    expect(asked).toBe(2);
  });

  it('is never taken for mail when it arrives', async () => {
    await arrive(ACCOUNT, ['b1', 'Run 1 passed']);
    clock = SEVEN + 5 * 60_000;
    await runWork(store, DIGEST, options(), clock + 60_000);
    const box = mailboxes.get(ACCOUNT)!;
    const [[id, text]] = [...box.inserted] as [[string, string]];
    const asGmail = rawMessage(id, {
      labelIds: ['INBOX', 'UNREAD'],
      headers: [
        { name: 'From', value: `Sift <${ACCOUNT}>` },
        { name: 'To', value: ACCOUNT },
        { name: 'Subject', value: 'Notifications digest for Wed, Nov 18: 1 message' },
        { name: 'Message-ID', value: /Message-ID: (\S+)/.exec(text)![1]! },
      ],
    });
    const account = { id: ACCOUNT, number: 1, email: ACCOUNT, historyId: '1' };
    const gmail = (ids: string[], read: string[] = []): GmailApi => ({
      ...api(ACCOUNT),
      listHistory: async () => ({
        additions: ids.map((i) => ({ id: i, labelIds: ['INBOX'] })),
        labelChanges: read.map((i) => ({ messageId: i, added: [], removed: ['UNREAD'] })),
        historyId: '9',
      }),
      getMetadata: async (i) => (i === id ? asGmail : null),
    });
    // By Gmail's id, without reading it, arriving or read; and by its Message-ID before Sift has that.
    expect(await syncWants(db, gmail([id]), account)).toBe(false);
    expect(await syncWants(db, gmail([], [id]), account)).toBe(false);
    expect(await syncWants(db, gmail([], ['b1']), account)).toBe(true);
    expect(await syncAccount(db, gmail([id]), account, () => clock)).toMatchObject({ added: [], skipped: 0 });
    await raw(db).run('UPDATE digests SET gmail_id = NULL');
    expect(await syncAccount(db, gmail([id]), account, () => clock)).toMatchObject({ added: [], skipped: 1 });
    expect(await raw(db).get('SELECT count(*) AS n FROM messages WHERE id = ?', id)).toEqual({ n: 0 });
  });
});
