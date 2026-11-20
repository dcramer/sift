import type { Sql } from '../src/store/sql.ts';
import { describe, expect, it } from 'vitest';
import { execute } from '../src/actions/executor.ts';
import { listDecisions } from '../src/dashboard/queries/decisions.ts';
import { listRuleSummaries } from '../src/dashboard/queries/rules.ts';
import { summarize } from '../src/dashboard/queries/summary.ts';
import { usage } from '../src/dashboard/queries/usage.ts';
import type { SenderPage } from '../src/dashboard/types.ts';
import { people } from '../src/store/people.ts';
import { recordSync } from '../src/store/accounts.ts';
import { finishAction, insertPendingAction, setActionStatus } from '../src/store/actions.ts';
import { recordDecision, settleDecision } from '../src/store/decisions.ts';
import { firstAccount, modelRun, openUserDb, raw, startDashboard, onePerson, unmarked } from './fixtures.ts';
import type { Store } from '../src/store/store.ts';
import { addRule, countRuleHit, removeRule } from '../src/store/rules.ts';
import { ACCOUNT, DAY, codeSignIn, everything, facts, quietSources, testModel } from './helpers.ts';
import { conditionsHash } from '../src/store/content.ts';
import { triageAccount } from '../src/work/triage.ts';
import { applyFeedback } from '../src/learn/feedback.ts';
import { plain } from '../src/plain.ts';

const NOW = Date.UTC(2026, 5, 15, 12);

/** A model call two days ago that cost `costUsd`. */
const charged = async (db: Sql, messageId: string, costUsd: number, error?: string) =>
  await modelRun(db, {
    messageId,
    model: 'test-model',
    at: NOW - 2 * DAY,
    usage: { model: 'test-model', inputTokens: 900, outputTokens: 100, costUsd },
    error,
  });

async function seededStore(): Promise<{ store: Store; db: Sql }> {
  const { store, db } = await onePerson(ACCOUNT);
  await recordSync(
    db,
    ACCOUNT,
    [
      facts({
        messageId: 'a',
        subject: 'Weekly digest',
        receivedAt: NOW - DAY,
        from: { address: 'news@example.com', domain: 'example.com', name: 'Example News' },
      }),
      facts({ messageId: 'b', subject: 'Second digest', receivedAt: NOW - DAY }),
      facts({
        messageId: 'c',
        subject: '<img src=x onerror=alert(1)>',
        receivedAt: NOW - 2 * DAY,
        from: { address: 'cold@example.net', domain: 'example.net' },
      }),
      facts({ messageId: 'old', receivedAt: NOW - 40 * DAY }),
      facts({ messageId: 'waiting', receivedAt: NOW }),
    ],
    '2',
    NOW,
  );
  const base = { subscription: 'preserve', reason: 'test' } as const;
  await recordDecision(
    db,
    ACCOUNT,
    'a',
    { ...base, disposition: 'archive', stage: 'rules', ruleId: 'r1', labelId: 'newsletter', gmailLabel: 'sift/newsletters' },
    { now: NOW - DAY },
  );
  await recordDecision(db, ACCOUNT, 'b', { ...base, disposition: 'archive', stage: 'classifier' }, { now: NOW - DAY });
  await recordDecision(
    db,
    ACCOUNT,
    'c',
    { ...base, disposition: 'review', stage: 'model', confidence: 0.4 },
    { now: NOW - 2 * DAY, durationMs: 1500, runId: await charged(db, 'c', 0.02) },
  );
  // A call that failed costs too, and decided nothing.
  await charged(db, 'b', 0.01, 'failed');
  await recordDecision(db, ACCOUNT, 'old', { ...base, disposition: 'keep', stage: 'rules' }, { now: NOW - 40 * DAY });
  return { store, db };
}
const seeded = async () => (await seededStore()).db;

describe('tracking', () => {
  it('stores the headers with each message, and never a body', async () => {
    const db = await openUserDb(ACCOUNT);
    await recordSync(
      db,
      ACCOUNT,
      [facts({ messageId: 'a', headers: { 'list-id': '<dev.lists.example.com>' }, cc: [{ address: 'c@example.org', domain: 'example.org' }] })],
      '2',
      NOW,
    );
    const row = (await raw(db).get<{ headers: string }>('SELECT * FROM messages'))!;
    expect(row).toMatchObject({ synced_at: NOW, label_ids: ['INBOX', 'UNREAD'] });
    expect(JSON.parse(unmarked(row.headers))).toMatchObject({ subject: 'Weekly digest', cc: 'c@example.org', 'list-id': '<dev.lists.example.com>' });
    expect(Object.keys(row).some((k) => /body|snippet|content/.test(k))).toBe(false);
  });

  it('keeps every decision for a message, with its cost', async () => {
    const db = await seeded();
    await recordDecision(db, ACCOUNT, 'c', { disposition: 'keep', subscription: 'preserve', stage: 'rules', reason: 'user correction' }, { now: NOW });
    const rows = await raw(db).all(
      `SELECT d.stage, d.disposition, r.model, r.cost_usd, r.input_tokens, d.duration_ms FROM decisions d LEFT JOIN model_runs r ON r.id = d.run_id WHERE d.message_id = 'c' ORDER BY d.id`,
    );
    expect(rows).toEqual([
      { stage: 'model', disposition: 'review', model: 'test-model', cost_usd: 0.02, input_tokens: 900, duration_ms: 1500 },
      { stage: 'rules', disposition: 'keep', model: null, cost_usd: null, input_tokens: null, duration_ms: null },
    ]);
  });

  it('links an action to the decision it carried out', async () => {
    const db = await seeded();
    const labels = ['INBOX'];
    const mailbox = {
      getLabelIds: async () => [...labels],
      modifyLabels: async (_id: string, change: { add: string[]; remove: string[] }) => {
        labels.splice(0, labels.length, ...labels.filter((l) => !change.remove.includes(l)), ...change.add);
        return [...labels];
      },
      ensureLabel: async (name: string) => `L:${name}`,
      hasSentTo: async () => false,
      createFilter: async () => 'f',
      deleteFilter: async () => {},
      listFilters: async () => [],
      insertMessage: async () => ({ id: 'i', labelIds: [] }),
      findByMessageId: async () => null,
      send: async () => ({ id: 's', threadId: 's', labelIds: [] }),
    };
    await execute({ db, mailbox, now: () => NOW }, ACCOUNT, 'a', { type: 'archive' }, 1);
    expect(await raw(db).get('SELECT decision_id, status FROM actions')).toEqual({ decision_id: 1, status: 'done' });
    expect((await summarize(db, await everything(db), 7, NOW)).recent.find((r) => r.id === 1)).toMatchObject({
      actionId: 1,
      actionStatus: 'done',
    });
  });

  it('groups decisions by where they got to, and shows the mailbox change rather than an unsubscribe', async () => {
    const db = await seeded();
    const base = { subscription: 'preserve', reason: 'test', stage: 'rules' } as const;
    const done = await recordDecision(db, ACCOUNT, 'a', { ...base, disposition: 'archive' }, { carryOut: true, now: NOW });
    const archived = await insertPendingAction(
      db,
      { accountId: ACCOUNT, messageId: 'a', type: 'archive', payload: { add: [], remove: ['INBOX'] }, originalLabels: ['INBOX'], decisionId: done },
      NOW,
    );
    await finishAction(db, archived, 'done', [], null, NOW);
    const unsubscribed = await insertPendingAction(
      db,
      { accountId: ACCOUNT, messageId: 'a', type: 'unsubscribe', payload: { add: [], remove: [] }, originalLabels: [], decisionId: done },
      NOW,
    );
    await finishAction(db, unsubscribed, 'done', null, null, NOW);
    await settleDecision(db, done, 'done');
    const failed = await recordDecision(db, ACCOUNT, 'b', { ...base, disposition: 'archive' }, { carryOut: true, now: NOW });
    await settleDecision(db, failed, 'failed', 'Gmail answered 503');
    const ids = async (status: string) => (await listDecisions(db, await everything(db), { days: 7, status }, NOW)).rows.map((r) => r.id);

    expect(await ids('suggested')).toEqual([3, 2, 1]);
    expect(await ids('done')).toEqual([done]);
    expect(await ids('nonsense')).toEqual([]);
    expect((await listDecisions(db, await everything(db), { days: 7, status: 'done' }, NOW)).rows[0]).toMatchObject({ actionId: archived });

    await setActionStatus(db, archived, 'undone');
    expect(await ids('undone')).toEqual([done]);
    expect(await ids('done')).toEqual([]);
    // What changed in Gmail, or was tried: not the suggestions, which never touched it.
    expect(await ids('changed')).toEqual([failed, done]);

    // An answer waiting for the next pass is shown among the changes.
    const answer = await recordDecision(db, ACCOUNT, 'c', { ...base, disposition: 'archive' }, { carryOut: true, byUser: true, now: NOW });
    expect(await ids('changed')).toEqual([answer, failed, done]);
  });

  it('sums what the model cost over a day, a week and 30 days, failed calls included, and per day for the 30', async () => {
    const { db } = await onePerson(ACCOUNT);
    await recordSync(db, ACCOUNT, [facts({ messageId: 'a', receivedAt: NOW - 50 * DAY })], '1', NOW);
    for (const [ago, costUsd, error] of [
      [2 * 3_600_000, 0.01, false],
      [3 * DAY, 0.02, true],
      [20 * DAY, 0.04, false],
      [40 * DAY, 1, false],
    ] as const) {
      await modelRun(db, {
        messageId: 'a',
        model: 'test-model',
        at: NOW - ago,
        usage: { model: 'test-model', inputTokens: 1, outputTokens: 1, costUsd },
        error: error ? 'failed' : undefined,
      });
    }
    const used = await usage(db, await everything(db), NOW);
    expect(used.day).toBeCloseTo(0.01);
    expect(used.week).toBeCloseTo(0.03);
    expect(used.month).toBeCloseTo(0.07);
    expect(used.daily).toHaveLength(30);
    expect(used.daily.at(-1)).toBeCloseTo(0.01);
    expect(used.daily.at(-4)).toBeCloseTo(0.02);
    expect(used.daily.reduce((a, b) => a + b)).toBeCloseTo(0.07);
  });

  it('counts only the window and reports tiers, cost and backlog', async () => {
    const db = await seeded();
    const summary = await summarize(db, await everything(db), 7, NOW);
    expect(summary.totals).toEqual({ messages: 4, decided: 3, withoutInference: 2, judged: 2, costUsd: 0.03, awaitingTriage: 1 });
    expect(summary.byStage.map((s) => [s.stage, s.decisions])).toEqual([
      ['rules', 1],
      ['classifier', 1],
      ['model', 1],
      ['fallback', 0],
    ]);
    expect(summary.byStage.find((s) => s.stage === 'model')).toMatchObject({ costUsd: 0.02, tokens: 1000 });
    expect(summary.byDisposition).toEqual([
      { disposition: 'archive', decisions: 2 },
      { disposition: 'review', decisions: 1 },
    ]);
    expect(summary.accounts).toEqual([{ email: ACCOUNT, lastSyncedAt: NOW }]);
  });

  it('counts messages, not decisions: answers and decisions made again are the same message', async () => {
    const db = await seeded();
    const base = { subscription: 'preserve', reason: 'test' } as const;
    // The user answers 'a' and 'c'; a label change decides 'b' again.
    await recordDecision(db, ACCOUNT, 'a', { ...base, disposition: 'keep', stage: 'rules' }, { carryOut: true, byUser: true, now: NOW });
    await recordDecision(db, ACCOUNT, 'c', { ...base, disposition: 'archive', stage: 'rules' }, { carryOut: true, byUser: true, now: NOW });
    await recordDecision(db, ACCOUNT, 'b', { ...base, disposition: 'keep', stage: 'classifier' }, { now: NOW });
    // A message the model could not judge, answered by the user: no model decided it, but neither did sift.
    await recordSync(db, ACCOUNT, [facts({ messageId: 'failed', receivedAt: NOW })], '3', NOW);
    await charged(db, 'failed', 0.005, 'failed');
    await charged(db, 'failed', 0.005, 'failed');
    await recordDecision(db, ACCOUNT, 'failed', { ...base, disposition: 'archive', stage: 'rules' }, { carryOut: true, byUser: true, now: NOW });

    const summary = await summarize(db, await everything(db), 7, NOW);
    expect(summary.totals).toMatchObject({ decided: 3, withoutInference: 2, judged: 3, costUsd: expect.closeTo(0.04) });
    expect(summary.daily.reduce((sum, d) => sum + Object.values(d.counts).reduce((a, b) => a + b, 0), 0)).toBe(3);
    expect(summary.byStage.map((s) => s.decisions)).toEqual([1, 1, 1, 0]);
  });

  it('returns one entry per day, including empty days', async () => {
    const db = await seeded();
    const { daily } = await summarize(db, await everything(db), 7, NOW);
    expect(daily).toHaveLength(7);
    expect(daily.reduce((sum, d) => sum + Object.values(d.counts).reduce((a, b) => a + b, 0), 0)).toBe(3);
    expect(daily.at(-1)?.counts).toEqual({ rules: 0, classifier: 0, model: 0, fallback: 0 });
  });

  it('says per day how much of the mail was one label, only when asked', async () => {
    const db = await seeded();
    const labelled = async (label?: string) => (await summarize(db, await everything(db), 7, NOW, label)).daily.map((d) => d.labelled);
    expect((await labelled()).every((n) => n === undefined)).toBe(true);
    expect((await labelled('newsletter')).reduce((a = 0, b = 0) => a + b, 0)).toBe(1);
    expect((await labelled('nope')).every((n) => n === 0)).toBe(true);
  });

  it('says per day what was done in Gmail, what failed, and what the model cost', async () => {
    const db = await seeded();
    const base = { subscription: 'preserve', reason: 'test', stage: 'rules' } as const;
    const archived = await recordDecision(db, ACCOUNT, 'a', { ...base, disposition: 'archive' }, { carryOut: true, now: NOW });
    const change = await insertPendingAction(
      db,
      { accountId: ACCOUNT, messageId: 'a', type: 'archive', payload: { add: [], remove: ['INBOX'] }, originalLabels: ['INBOX'], decisionId: archived },
      NOW,
    );
    await finishAction(db, change, 'done', [], null, NOW);
    await settleDecision(db, archived, 'done');
    await settleDecision(
      db,
      await recordDecision(db, ACCOUNT, 'b', { ...base, disposition: 'spam' }, { carryOut: true, now: NOW }),
      'failed',
      'Gmail answered 503',
    );
    const { daily } = await summarize(db, await everything(db), 7, NOW);
    // A change that never landed changed nothing.
    expect(daily.at(-1)?.changes).toEqual({ archive: 1, spam: 0, keep: 0 });
    // Suggestions changed nothing, so the other days have no changes; the model's cost is on the day it was asked.
    expect(daily.slice(0, -1).every((d) => d.changes.archive + d.changes.spam + d.changes.keep === 0)).toBe(true);
    expect(daily.reduce((sum, d) => sum + d.costUsd, 0)).toBeCloseTo(0.03);
  });

  it('lists senders and recent decisions with their message', async () => {
    const db = await seeded();
    const summary = await summarize(db, await everything(db), 7, NOW);
    expect(summary.topSenders[0]).toEqual({ address: 'news@example.com', messages: 3, lastDisposition: 'keep' });
    expect(summary.recent.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(summary.recent[2]).toMatchObject({
      subject: 'Weekly digest',
      fromName: 'Example News',
      stage: 'rules',
      labelId: 'newsletter',
      gmailLabel: 'sift/newsletters',
      actionId: null,
    });
  });

  it('handles an empty database', async () => {
    const empty = await openUserDb();
    const summary = await summarize(empty, await everything(empty), 30, NOW);
    expect(summary.totals.decided).toBe(0);
    expect(summary.daily).toHaveLength(30);
    expect(summary.recent).toEqual([]);
  });
});

const get = async <T>(url: string) => (await (await fetch(url)).json()) as T;

describe('dashboard server', () => {
  /** The dashboard's address, over `store` or else a newly seeded one. */
  async function start(options: Parameters<typeof startDashboard>[1] = {}, store?: Store) {
    const over = store ?? (await seededStore()).store;
    return (await startDashboard(people(over), { now: () => NOW, ...options })).base;
  }

  it('serves the summary', async () => {
    const summary = await get<{ days: number; recent: unknown[] }>(`${await start()}/api/summary?days=90`);
    expect(summary.days).toBe(90);
    expect(summary.recent).toHaveLength(4);
  });

  it('lists decisions with filters, search and paging', async () => {
    const base = await start();
    type Page = { total: number; rows: { id: number; messageId: string; subject: string }[] };
    expect((await get<Page>(`${base}/api/decisions?days=7`)).rows.map((r) => r.id)).toEqual([3, 2, 1]);
    expect((await get<Page>(`${base}/api/decisions?days=7&q=EXAMPLE+news`)).rows.map((r) => r.messageId)).toEqual(['a']);
    expect((await get<Page>(`${base}/api/decisions?days=7&q=${encodeURIComponent('%')}`)).total).toBe(0);
    expect((await get<Page>(`${base}/api/decisions?days=7&status=${encodeURIComponent("x' OR 1=1 --")}`)).total).toBe(0);

    const paged = await get<Page>(`${base}/api/decisions?days=7&limit=1&offset=1`);
    expect(paged.total).toBe(3);
    expect(paged.rows.map((r) => r.id)).toEqual([2]);
  });

  it('narrows decisions by what sift recorded about each message', async () => {
    const { store, db } = await seededStore();
    await raw(db).run(`UPDATE messages SET facts = facts || '{"isReply": true, "listId": "dev.example.com", "dmarc": "pass"}'::jsonb WHERE id = 'a'`);
    await raw(db).run(`UPDATE messages SET facts = facts || '{"dmarc": "fail"}'::jsonb WHERE id = 'c'`);
    const base = await start({}, store);
    type Page = { total: number; rows: { messageId: string }[] };
    const ids = async (fact: string) => (await get<Page>(`${base}/api/decisions?days=7&fact=${fact}`)).rows.map((r) => r.messageId);
    expect(await ids('reply')).toEqual(['a']);
    expect(await ids('list')).toEqual(['a']);
    expect(await ids('unproven')).toEqual(['c', 'b']);
    // Not known until a model reads the message, so nothing matches yet.
    expect(await ids('attachments')).toEqual([]);
    expect(await ids(encodeURIComponent("reply' OR 1=1 --"))).toEqual([]);
  });

  it('narrows decisions to one label, Leave in inbox taking mail kept with no label', async () => {
    const { store, db } = await seededStore();
    await recordDecision(db, ACCOUNT, 'waiting', { disposition: 'keep', subscription: 'preserve', stage: 'rules', reason: 'r' }, { now: NOW });
    const base = await start({}, store);
    type Page = { rows: { messageId: string }[] };
    const ids = async (label: string) => (await get<Page>(`${base}/api/decisions?days=7&label=${label}`)).rows.map((r) => r.messageId);
    expect(await ids('newsletter')).toEqual(['a']);
    expect(await ids('everything_else')).toEqual(['waiting']);
    expect(await ids('nope')).toEqual([]);
  });

  it('returns one message with its decisions and actions', async () => {
    const base = await start();
    const detail = await get<{ subject: string; decisions: { stage: string; inputTokens: number; durationMs: number }[]; actions: unknown[] }>(
      `${base}/api/message?id=c`,
    );
    expect(detail.subject).toBe('<img src=x onerror=alert(1)>');
    expect(detail.decisions).toMatchObject([{ stage: 'model', inputTokens: 900, durationMs: 1500, answer: null }]);
    expect(detail.actions).toEqual([]);
    expect((await fetch(`${base}/api/message?id=nope`)).status).toBe(404);
  });

  it("carries the reader's answer on the decision it corrected, which every list shows instead", async () => {
    const { store, db } = await seededStore();
    const base = await start({}, store);
    type Detail = { fromAddress: string; decisions: { id: number; labelId: string | null; answer: { labelId: string | null; disposition: string } | null }[] };
    const before = await get<Detail>(`${base}/api/message?id=b`);
    await applyFeedback(db, { accountId: ACCOUNT, sender: before.fromAddress, messageId: 'b', decisionId: before.decisions[0]!.id, label: 'newsletter' }, NOW);
    const after = await get<Detail>(`${base}/api/message?id=b`);
    expect(after.decisions).toMatchObject([{ id: before.decisions[0]!.id, labelId: null, answer: { labelId: 'newsletter', disposition: 'archive' } }]);
  });

  it('lists rules with their hits', async () => {
    const db = await seeded();
    const id = await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'cold_outreach' }, 'user', NOW);
    await recordDecision(db, ACCOUNT, 'waiting', { disposition: 'archive', subscription: 'preserve', stage: 'rules', ruleId: id, reason: 'r' }, { now: NOW });
    expect(await listRuleSummaries(db, await everything(db), NOW)).toEqual([
      {
        id,
        match: { fromDomain: ['example.com'] },
        except: [],
        labelId: 'cold_outreach',
        labelName: 'Cold outreach',
        override: null,
        disposition: 'archive',
        markRead: false,
        unsubscribe: true,
        kind: 'label',
        name: null,
        whenLabel: null,
        when: null,
        source: 'user',
        hits: 0,
        lastHitAt: NOW,
        checks: 0,
        checkCost: 0,
        filterId: null,
        filter: {
          state: 'none',
          possible: true,
          reason: null,
          plan: { criteria: { from: '@example.com' }, gmailLabel: 'sift/cold-outreach', archive: true },
          differs: ['Mail the filter archives never reaches Sift: it is not recorded, counted or unsubscribed from.'],
          checkedAt: null,
          history: [],
        },
        createdAt: NOW,
      },
    ]);
  });

  it("counts every call that checked a rule's condition over 30 days, met or not, and what they cost", async () => {
    const { db } = await onePerson(ACCOUNT);
    const from = { address: 'deals@shop.example.com', domain: 'shop.example.com' };
    await recordSync(db, ACCOUNT, [facts({ messageId: 'sale', from }), facts({ messageId: 'receipt', from })], '1', NOW);
    const id = await addRule(db, { match: { fromDomain: ['shop.example.com'] }, labelId: 'newsletter', when: 'a sale' }, 'user', NOW);
    const usage = { model: 'test/model', inputTokens: 1, outputTokens: 1, costUsd: 0.03 };
    const model = testModel(async ({ evidence }) => ({ label: evidence.facts.messageId === 'sale' ? 'newsletter' : 'personal', reason: 'r', usage }));
    await triageAccount({ db, mailbox: null, model, sources: quietSources(), now: () => NOW }, await firstAccount(db));
    await modelRun(db, { messageId: 'sale', ruleId: id, at: NOW - 31 * DAY, usage: { ...usage, costUsd: 1 } });

    const [rule] = await listRuleSummaries(db, await everything(db), NOW);
    expect(rule).toMatchObject({ id, checks: 2 });
    expect(rule!.checkCost).toBeCloseTo(0.06);
  });

  it('breaks an address down by the names it writes under, and lists its mail under one name', async () => {
    const { store, db } = await seededStore();
    const from = (name: string) => ({ address: 'notifications@example.org', domain: 'example.org', name });
    await recordSync(
      db,
      ACCOUNT,
      [
        facts({ messageId: 'n1', subject: 'Bump zod', receivedAt: NOW - 1000, from: from('Dependabot') }),
        facts({ messageId: 'n2', subject: 'Bump vite', receivedAt: NOW - 2000, from: from(' dependabot  ') }),
        facts({ messageId: 'n3', subject: 'New SSH key', receivedAt: NOW - 3000, from: from('Security alerts') }),
        facts({ messageId: 'n4', subject: 'Weekly digest', receivedAt: NOW - 4000, from: from('Security alerts') }),
      ],
      '4',
      NOW,
    );
    const said = { subscription: 'preserve', reason: 'test', stage: 'model' } as const;
    await recordDecision(db, ACCOUNT, 'n1', { ...said, disposition: 'keep', labelId: 'notification' }, { now: NOW });
    await recordDecision(db, ACCOUNT, 'n2', { ...said, disposition: 'review' }, { now: NOW });
    await recordDecision(db, ACCOUNT, 'n3', { ...said, disposition: 'keep', labelId: 'security' }, { now: NOW });
    // An action rule's: no label, and not undecided.
    await recordDecision(db, ACCOUNT, 'n4', { ...said, disposition: 'archive', stage: 'rules' }, { now: NOW });
    const base = await start({}, store);
    const page = (name?: string) =>
      get<SenderPage>(`${base}/api/sender?address=notifications@example.org${name === undefined ? '' : `&name=${encodeURIComponent(name)}`}`);

    expect((await page()).names).toEqual([
      { name: 'Dependabot', messages: 2, lastSeenAt: NOW - 1000, labels: [{ id: 'notification', name: 'Notifications', messages: 1 }], actions: [] },
      {
        name: 'Security alerts',
        messages: 2,
        lastSeenAt: NOW - 3000,
        labels: [{ id: 'security', name: 'Account alerts', messages: 1 }],
        actions: [{ action: 'archive', messages: 1 }],
      },
    ]);
    expect((await page('DEPENDABOT')).decisions.map((d) => d.messageId).toSorted()).toEqual(['n1', 'n2']);
    // One name, on some of their mail, is not several.
    expect((await get<SenderPage>(`${base}/api/sender?address=news@example.com`)).names).toEqual([]);
  });

  it("shows a sender's and a domain's mail from every one of the person's mailboxes", async () => {
    const work = 'me@example.net';
    const { store, db } = await onePerson(ACCOUNT, work);
    const from = { address: 'media@example.org', domain: 'example.org', name: 'Group' };
    await recordSync(db, ACCOUNT, [facts({ messageId: 'home', from, receivedAt: NOW - 2000 })], '1', NOW);
    await recordSync(db, work, [facts({ accountId: work, messageId: 'work', from, receivedAt: NOW - 1000 })], '1', NOW);
    for (const [account, id] of [
      [ACCOUNT, 'home'],
      [work, 'work'],
    ] as const)
      await recordDecision(db, account, id, { disposition: 'archive', subscription: 'preserve', stage: 'rules', reason: 'test' }, { now: NOW });
    const base = await start({}, store);

    const sender = await get<SenderPage>(`${base}/api/sender?address=media@example.org`);
    expect(sender.profile).toMatchObject({ messages: 2, contact: null });
    expect(sender.decisions.map((d) => [d.accountId, d.messageId])).toEqual([
      [work, 'work'],
      [ACCOUNT, 'home'],
    ]);
    const domain = await get<SenderPage>(`${base}/api/domain?domain=example.org`);
    expect(domain.senders).toMatchObject([{ address: 'media@example.org', messages: 2 }]);

    // Nothing from them and no rule about them: nothing to show but what was asked.
    expect((await fetch(`${base}/api/sender?address=nobody@example.org`)).status).toBe(404);
    await addRule(db, { match: { from: ['nobody@example.org'] }, disposition: 'archive' }, 'user', NOW);
    expect((await get<SenderPage>(`${base}/api/sender?address=nobody@example.org`)).profile).toMatchObject({
      messages: 0,
      rules: [{ disposition: 'archive' }],
    });
  });

  it('serves a sender and a domain, whose given standing is a rule made in the dialog and taken back in one press', async () => {
    const { store, db } = await seededStore();
    const base = await start({}, store);
    const sender = (await (await fetch(`${base}/api/sender?address=news@example.com`)).json()) as SenderPage;
    expect(sender).toMatchObject({ kind: 'sender', name: 'Example News', profile: { address: 'news@example.com', messages: 4, contact: null, given: null } });
    expect(sender.profile.domain).toMatchObject({ name: 'example.com', contact: null });
    expect(sender.decisions.every((d) => plain(d.fromAddress) === 'news@example.com')).toBe(true);
    expect(sender.decisions.map((d) => d.messageId)).toContain('a');

    const write = (path: string, body: object) =>
      fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, 'x-sift': '1' },
        body: JSON.stringify(body),
      });
    const theirs = async () =>
      (await listRuleSummaries(db, await everything(db), Date.now())).filter((r) => plain(r.match['from']?.[0]) === 'news@example.com');
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    // Trust is given in the rule dialog, as what Trust starts it on: a rule for exactly them that only keeps their mail, which is Leave in inbox. It replaces the rule for exactly them.
    // It says it replaced one, so the page offers no Undo: removing it would not bring the old rule back.
    const replacing = await write('/api/rules', { match: { from: ['news@example.com'] }, disposition: 'keep' });
    expect(replacing.status).toBe(200);
    expect(await replacing.json()).toMatchObject({ replaced: true });
    expect(await theirs()).toMatchObject([{ kind: 'label', labelId: 'everything_else', source: 'user' }]);
    const trusted = (await (await fetch(`${base}/api/sender?address=news@example.com`)).json()) as SenderPage;
    expect(trusted.profile).toMatchObject({ given: 'trusted' });

    const fresh = await write('/api/rules', { match: { fromDomain: ['example.net'] }, disposition: 'spam' });
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toMatchObject({ replaced: false });
    const domain = (await (await fetch(`${base}/api/domain?domain=example.net`)).json()) as SenderPage;
    expect(domain).toMatchObject({ kind: 'domain', profile: { given: 'blocked' }, senders: [{ address: 'cold@example.net', contact: 'new' }] });

    // Taking it back is one press.
    expect((await write('/api/standing/clear', { address: 'news@example.com' })).status).toBe(200);
    expect(await theirs()).toEqual([]);

    // A rule naming them among others is on their page but is not their standing, and taking a standing back leaves it.
    await addRule(db, { match: { from: ['news@example.com', 'other@example.org'] }, disposition: 'archive' }, 'user');
    const among = (await (await fetch(`${base}/api/sender?address=news@example.com`)).json()) as SenderPage;
    expect(among.profile).toMatchObject({ given: null, rules: [{ match: { from: ['news@example.com', 'other@example.org'] } }] });
    expect((await write('/api/standing/clear', { address: 'news@example.com' })).status).toBe(200);
    expect(await theirs()).toHaveLength(1);

    expect((await write('/api/standing/clear', { address: 'news@example.com', domain: 'example.com' })).status).toBe(400);
    expect((await write('/api/standing/clear', { address: 'not an address' })).status).toBe(400);
    expect((await fetch(`${base}/api/domain?domain=gmail.com`)).status).toBe(404);
  });

  it('gives a standing in one press, replacing only another standing, and says which so Undo can give it back', async () => {
    const { store, db } = await seededStore();
    const base = await start({}, store);
    const give = async (body: object) => {
      const response = await fetch(`${base}/api/standing`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, 'x-sift': '1' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    const theirs = async () =>
      (await listRuleSummaries(db, await everything(db), Date.now())).filter((r) => plain(r.match['from']?.[0]) === 'news@example.com');

    const fresh = await give({ address: 'News@example.com', standing: 'trusted' });
    expect(fresh).toEqual({ status: 200, body: { id: expect.any(String), was: null } });
    const { id } = fresh.body as { id: string };
    expect(await theirs()).toMatchObject([{ id, kind: 'label', labelId: 'everything_else', source: 'user' }]);
    expect((await give({ address: 'news@example.com', standing: 'blocked' })).body).toEqual({ id, was: 'trusted' });
    expect(await theirs()).toMatchObject([{ id, disposition: 'spam' }]);
    const page = (await (await fetch(`${base}/api/sender?address=news@example.com`)).json()) as SenderPage;
    expect(page.profile).toMatchObject({ given: 'blocked' });
    // Undo gives back the standing it replaced.
    expect((await give({ address: 'news@example.com', standing: 'trusted' })).body).toEqual({ id, was: 'blocked' });

    // A rule for exactly them that says more than what happens to their mail is theirs to change in the dialog: nothing is written.
    await removeRule(db, id);
    const labelled = await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    expect((await give({ address: 'news@example.com', standing: 'blocked' })).body).toEqual({ theirs: labelled });
    expect(await theirs()).toMatchObject([{ id: labelled, labelId: 'newsletter' }]);
    const reading = await addRule(db, { match: { fromDomain: ['example.net'] }, disposition: 'archive', markRead: true }, 'user');
    expect((await give({ domain: 'example.net', standing: 'unwanted' })).body).toEqual({ theirs: reading });

    expect((await give({ domain: 'example.org', standing: 'unwanted' })).body).toEqual({ id: expect.any(String), was: null });
    expect((await give({ address: 'news@example.com', domain: 'example.com', standing: 'blocked' })).status).toBe(400);
    expect((await give({ address: 'news@example.com', standing: 'known' })).status).toBe(400);
  });

  it('makes a proposed rule only as the user left it in the dialog, which resolves the proposal', async () => {
    const { store, db } = await seededStore();
    const base = await start({}, store);
    const { id: proposal } = (await raw(db).get<{ id: number }>(
      `INSERT INTO proposals (account_id, match, conditions, label_id, disposition, agreed, created_at) VALUES (?, '{"from":["news@example.com"]}', ?, 'newsletter', 'keep', 2, 1) RETURNING id`,
      ACCOUNT,
      conditionsHash(db, { from: ['news@example.com'] }),
    ))!;
    const post = (path: string, body: object) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-sift': '1' }, body: JSON.stringify(body) });
    const open = async () => ((await (await fetch(`${base}/api/suggestions`)).json()) as { proposals: { id: number }[] }).proposals.map((p) => p.id);
    const fromNews = async () =>
      (await listRuleSummaries(db, await everything(db), Date.now())).filter((r) => plain(r.match['fromDomain']?.[0]) === 'example.com');

    // Accepting it without a rule in hand is not a way to make one.
    expect((await post('/api/proposals', { id: proposal, accept: true })).status).toBe(400);
    // A rule made some other way, or the dialog closed, leaves it open.
    expect((await post('/api/rules', { match: { from: ['other@example.com'] }, label: 'newsletter' })).status).toBe(200);
    expect(await open()).toEqual([proposal]);
    // Edited in the dialog: everyone at the domain, as Receipts, not the sender as Newsletters.
    const made = await post('/api/rules', { match: { fromDomain: ['example.com'] }, label: 'transactional', proposal });
    expect(made.status).toBe(200);
    expect(await fromNews()).toMatchObject([{ labelId: 'transactional', source: 'user' }]);
    expect((await listRuleSummaries(db, await everything(db), Date.now())).filter((r) => plain(r.match['from']?.[0]) === 'news@example.com')).toEqual([]);
    expect(await open()).toEqual([]);
    expect(await raw(db).get('SELECT status FROM proposals WHERE id = ?', proposal)).toEqual({ status: 'accepted' });
    // Made once: the same proposal again makes no second rule.
    expect((await post('/api/rules', { match: { fromDomain: ['example.org'] }, label: 'transactional', proposal })).status).toBe(409);
    expect((await listRuleSummaries(db, await everything(db), Date.now())).filter((r) => plain(r.match['fromDomain']?.[0]) === 'example.org')).toEqual([]);
  });

  it('changes a rule in place, keeping its place, exceptions and count, and never into a twin of another', async () => {
    const { store, db } = await seededStore();
    const base = await start({}, store);
    const post = (path: string, body: object) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-sift': '1' }, body: JSON.stringify(body) });
    const summaries = async () => await listRuleSummaries(db, await everything(db), Date.now());
    const id = await addRule(db, { match: { from: ['cold@example.net'] }, except: [{ subjectContains: ['invoice'] }], labelId: 'newsletter' }, 'learned');
    await countRuleHit(db, id);
    const before = (await summaries()).map((r) => r.id);

    const edited = await post('/api/rules/edit', { id, match: { fromDomain: ['example.net'] }, disposition: 'archive', markRead: true, name: 'Cold mail' });
    expect(edited.status).toBe(200);
    const rule = (await summaries()).find((r) => r.id === id)!;
    expect(plain(rule.match)).toEqual({ fromDomain: ['example.net'] });
    expect(plain(rule.except)).toEqual([{ subjectContains: ['invoice'] }]);
    // Its one hit kept, and one more: the seed's mail from example.net waiting in the inbox, decided again.
    expect(rule).toMatchObject({ kind: 'action', labelId: null, disposition: 'archive', markRead: true, hits: 2, source: 'user' });
    expect(plain(rule.name)).toBe('Cold mail');
    expect((await summaries()).map((r) => r.id)).toEqual(before);

    // Another rule's exact conditions would leave which one decides to their order.
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    const other = await addRule(db, { match: { from: ['other@example.com'] }, labelId: 'newsletter' }, 'user');
    const twin = await post('/api/rules/edit', { id: other, match: { from: ['news@example.com'] }, label: 'transactional' });
    expect(twin.status).toBe(409);
    expect(((await twin.json()) as { error: string }).error).toMatch(/Another rule already has exactly these conditions/);
    // Waiting for a label, it is a different rule for the same sender.
    expect((await post('/api/rules/edit', { id: other, match: { from: ['news@example.com'] }, whenLabel: 'newsletter', disposition: 'archive' })).status).toBe(
      200,
    );
    expect((await post('/api/rules/edit', { id: 'r-gone', match: { from: ['x@example.com'] }, disposition: 'archive' })).status).toBe(409);
  });

  it("tells the page only that something failed when it is Sift's own error, and logs why", async () => {
    const { store, db } = await seededStore();
    await raw(db).run("UPDATE messages SET headers = 'sift-secret:v1:deadbeef:x:y' WHERE id = 'c'");
    const logged: string[] = [];
    const base = await start({ log: (line) => logged.push(line) }, store);
    const reply = await fetch(`${base}/api/message?id=c`);
    expect([reply.status, await reply.json()]).toEqual([500, { error: 'Sift could not do that. Why is in its log.' }]);
    expect(logged).toEqual([expect.stringMatching(/^GET \/api\/message: .*SIFT_KEY/)]);
  });

  it('lets someone sign in behind tailscale serve, which tells this machine the browser used HTTPS', async () => {
    const { store } = await seededStore();
    const dashboard = await startDashboard(people(store), { signIn: codeSignIn, sessionSecret: 'secret', allowedHosts: ['devbox.tail1234.ts.net'] });
    const session = async (headers: Record<string, string>) =>
      (await dashboard.call('GET', '/api/session', undefined, { host: 'devbox.tail1234.ts.net', ...headers })).body;
    expect(await session({})).toMatchObject({ canSignIn: false, reason: 'address' });
    expect(await session({ 'x-forwarded-proto': 'https' })).toMatchObject({ canSignIn: true, reason: null });
    // Listening beyond loopback, anyone could say it.
    const anywhere = await startDashboard(people(store), {
      signIn: codeSignIn,
      sessionSecret: 'secret',
      allowedHosts: ['devbox.tail1234.ts.net'],
      forwarded: false,
    });
    const claimed = await anywhere.call('GET', '/api/session', undefined, { host: 'devbox.tail1234.ts.net', 'x-forwarded-proto': 'https' });
    expect(claimed.body).toMatchObject({ canSignIn: false, reason: 'address' });
  });

  it('rejects bad input, other methods and unknown paths', async () => {
    const base = await start();
    expect((await fetch(`${base}/api/summary?days=5000`)).status).toBe(400);
    expect((await fetch(`${base}/api/summary`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it('answers only to localhost and to hosts the user configured', async () => {
    const { request } = await import('node:http');
    const statusFor = (base: string, host: string) =>
      new Promise<number>((resolve, reject) => {
        const req = request(`${base}/api/summary`, { headers: { host } }, (res) => resolve(res.statusCode ?? 0));
        req.on('error', reject);
        req.end();
      });

    const { store } = await seededStore();
    const base = await start({}, store);
    expect(await statusFor(base, 'evil.example')).toBe(403);
    expect(await statusFor(base, '100.64.0.7:8787')).toBe(403);

    const configured = await start({ allowedHosts: ['Box.example.ts.net', '100.64.0.7'] }, store);
    expect(await statusFor(configured, 'box.example.ts.net:8787')).toBe(200);
    expect(await statusFor(configured, '100.64.0.7')).toBe(200);
    expect(await statusFor(configured, 'localhost:1')).toBe(200);
    expect(await statusFor(configured, 'evil.example')).toBe(403);
  });
});
