import type { Sql } from '../src/store/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { RETENTION_DAYS, pruneOld } from '../src/work/retention.ts';
import { READ_KEEP_DAYS } from '../src/store/kept.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { type RunOptions, type Work, dueWork, runWork, upkeep } from '../src/work/run.ts';
import { applyFeedback, pendingSuggestions } from '../src/learn/feedback.ts';
import { recordSync } from '../src/store/accounts.ts';
import { type ActionType, finishAction, insertPendingAction, unsubscribedAt } from '../src/store/actions.ts';
import { recordDecision, settleDecision } from '../src/store/decisions.ts';
import { deleteExamples } from '../src/store/examples.ts';
import { listUndecided } from '../src/store/messages.ts';
import { addRule } from '../src/store/rules.ts';
import { MAX_ATTEMPTS, startRun } from '../src/store/runs.ts';
import type { Decision } from '../src/triage/types.ts';
import { modelRun, raw, onePerson, superuser } from './fixtures.ts';
import { ACCOUNT, DAY, facts, workDue } from './helpers.ts';
import type { Store } from '../src/store/store.ts';

const OLD = 10 * DAY;
const NOW = OLD + (RETENTION_DAYS + 1) * DAY;
const RECENT = NOW - 10 * DAY;

let db: Sql;
let store: Store;

const archive: Decision = { disposition: 'archive', subscription: 'preserve', labelId: 'newsletter', stage: 'model', reason: 'test' };

async function message(id: string, at = OLD, from = `${id}@example.com`): Promise<void> {
  await recordSync(db, ACCOUNT, [facts({ messageId: id, receivedAt: at, from: { address: from, domain: 'example.com' } })], '1', at);
}

/** A message sift decided and changed long ago. */
async function acted(id: string, type: ActionType = 'archive'): Promise<{ decisionId: number; actionId: number }> {
  await message(id);
  const decisionId = await recordDecision(db, ACCOUNT, id, archive, { carryOut: true, now: OLD });
  await settleDecision(db, decisionId, 'done');
  const actionId = await insertPendingAction(
    db,
    { accountId: ACCOUNT, messageId: id, type, payload: { add: [], remove: ['INBOX'] }, originalLabels: ['INBOX'], decisionId },
    OLD,
  );
  await finishAction(db, actionId, 'done', [], null, OLD);
  return { decisionId, actionId };
}

const left = async (table: string, column = 'message_id') =>
  (await raw(db).all<{ id: string }>(`SELECT ${column} AS id FROM ${table} ORDER BY 1`)).map((r) => r.id);

beforeEach(async () => {
  ({ store, db } = await onePerson(ACCOUNT));
});

describe('pruneOld', () => {
  it('forgets an old message with its decisions, changes and model runs', async () => {
    await acted('gone');
    await modelRun(db, { messageId: 'gone', model: 'p/m', at: OLD });
    await raw(db).run(`INSERT INTO mail_bodies (account_id, message_id, body_text, fetched_at) VALUES (?, 'gone', 'Text.', ?)`, ACCOUNT, OLD);
    await acted('fresh');
    await message('new', RECENT);
    await recordDecision(db, ACCOUNT, 'new', archive, { carryOut: true, now: RECENT });
    await raw(db).run(`UPDATE actions SET created_at = ? WHERE message_id = 'fresh'`, RECENT);

    expect(await pruneOld(db, NOW)).toBe(1);
    expect(await left('messages', 'id')).toEqual(['fresh', 'new']);
    expect(await left('decisions')).toEqual(['fresh', 'new']);
    expect(await left('actions')).toEqual(['fresh']);
    expect(await left('model_runs')).toEqual([]);
    expect(await left('mail_bodies')).toEqual([]);
    expect(await pruneOld(db, NOW)).toBe(0);
  });

  it('spares a suggestion still waiting for a year from its decision, and no longer, whatever it would do', async () => {
    await message('waiting');
    await recordDecision(db, ACCOUNT, 'waiting', archive, { now: RECENT });
    await message('forgotten');
    await recordDecision(db, ACCOUNT, 'forgotten', archive, { now: OLD });
    await message('kept');
    await recordDecision(db, ACCOUNT, 'kept', { ...archive, disposition: 'keep', labelId: 'personal' }, { now: OLD });
    await message('told');
    const ruleId = await addRule(db, { match: { from: ['told@example.com'] }, labelId: 'newsletter' }, 'user');
    await recordDecision(db, ACCOUNT, 'told', { ...archive, stage: 'rules', ruleId }, { now: OLD });
    expect((await pendingSuggestions(db)).map((s) => s.messageId).toSorted()).toEqual(['forgotten', 'kept', 'waiting']);

    expect(await pruneOld(db, NOW)).toBe(3);
    expect(await left('messages', 'id')).toEqual(['waiting']);
  });

  it('keeps a message the user answered while its example is kept, then forgets it with the answer', async () => {
    await message('answered');
    await recordDecision(db, ACCOUNT, 'answered', archive, { now: OLD });
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'answered@example.com', label: 'newsletter', messageId: 'answered', carryOut: true }, OLD);
    await raw(db).run(`UPDATE decisions SET outcome = 'done' WHERE carry_out`);

    expect(await pruneOld(db, NOW)).toBe(0);
    expect(await left('examples')).toEqual(['answered']);
    expect(await left('feedback', 'decision_id')).toHaveLength(1);

    await deleteExamples(db, ACCOUNT, 'answered');
    expect(await pruneOld(db, NOW)).toBe(1);
    for (const table of ['messages', 'decisions', 'feedback', 'actions', 'model_runs'])
      expect(await left(table, table === 'messages' ? 'id' : 'user_id'), table).toEqual([]);
  });

  it('keeps a message that is undecided, not yet carried out, or changed without confirmation', async () => {
    await message('undecided');
    await message('unsettled');
    await recordDecision(db, ACCOUNT, 'unsettled', archive, { carryOut: true, now: OLD });
    const { actionId } = await acted('unconfirmed');
    await finishAction(db, actionId, 'unknown', null, 'timeout', OLD);

    expect(await pruneOld(db, NOW)).toBe(0);
    expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.facts.messageId)).toEqual(['undecided']);
  });

  it('forgets mail the model could never judge that nobody answered, once its last try is as old', async () => {
    await message('stuck');
    await message('tried lately');
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await startRun(db, { accountId: ACCOUNT, messageId: 'stuck', model: 'p/m', now: OLD });
      await startRun(db, { accountId: ACCOUNT, messageId: 'tried lately', model: 'p/m', now: i === 0 ? RECENT : OLD });
    }
    await message('answered');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await startRun(db, { accountId: ACCOUNT, messageId: 'answered', model: 'p/m', now: OLD });
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'answered@example.com', label: 'newsletter', messageId: 'answered' }, OLD);

    expect(await pruneOld(db, NOW)).toBe(1);
    expect(await left('messages', 'id')).toEqual(['answered', 'tried lately']);
    expect(await left('model_runs')).not.toContain('stuck');
  });

  it('keeps the record of an unsubscribe, so the sender is not asked twice', async () => {
    await acted('list', 'unsubscribe');
    expect(await pruneOld(db, NOW)).toBe(0);
    expect(await unsubscribedAt(db, ACCOUNT, 'list@example.com')).toBe(OLD);
  });
});

describe('daily upkeep', () => {
  it('deletes the text Sift read 30 days after reading it, for everyone, whether or not Gmail can be reached', async () => {
    await message('old');
    await message('young');
    await raw(db).run(
      `INSERT INTO read_bodies (account_id, message_id, body_text, fetched_at) VALUES (?, 'old', 'Old text.', ?), (?, 'young', 'Young text.', ?)`,
      ACCOUNT,
      NOW - (READ_KEEP_DAYS + 1) * DAY,
      ACCOUNT,
      NOW - DAY,
    );
    await upkeep(db, { log: () => {}, now: () => NOW });
    expect(await left('read_bodies')).toEqual(['young']);
  });
});

describe('retention', () => {
  it('runs on the first tick of a day', async () => {
    const logs: string[] = [];
    const ephemeral = memoryEphemeral();
    const at = (now: number): RunOptions => ({
      ephemeral,
      connect: () => {
        throw new Error('not connected');
      },
      log: (line) => logs.push(line),
      now: () => now,
    });
    await acted('first');
    await workDue(store, at(NOW), Infinity);
    // Something else grows old after the first prune: it stays until the next day.
    await acted('second');
    await workDue(store, at(NOW), Infinity);
    expect(await left('messages', 'id')).toEqual(['second']);
    await workDue(store, at(NOW + DAY), Infinity);
    expect(logs.filter((line) => line.startsWith('Forgot'))).toEqual([
      'Forgot 1 message with nothing newer than 365 days',
      'Forgot 1 message with nothing newer than 365 days',
    ]);
    expect(await left('messages', 'id')).toEqual([]);
  });

  it('that fails is said in the log, and is due again at the next tick', async () => {
    const logs: string[] = [];
    const options: RunOptions = {
      ephemeral: memoryEphemeral(),
      connect: () => Promise.reject(new Error('not connected')),
      log: (line) => logs.push(line),
      now: () => NOW,
    };
    const pg = await superuser();
    await pg.exec('REVOKE DELETE ON examples FROM sift_app');
    try {
      await runWork(store, { kind: 'upkeep', person: db.person! }, options, Infinity);
    } finally {
      await pg.exec('GRANT DELETE ON examples TO sift_app');
    }
    expect(logs).toEqual([expect.stringMatching(/^Deleting old records failed, will retry: permission denied/)]);
    expect((await dueWork(store, options)).filter((work) => work.kind === 'upkeep')).toHaveLength(1);
  });

  it('is done once a day, however many runs begin it', async () => {
    const options: RunOptions = { ephemeral: memoryEphemeral(), connect: () => Promise.reject(new Error('not connected')), log: () => {}, now: () => NOW };
    const piece: Work = { kind: 'upkeep', person: db.person! };
    await acted('first');
    await runWork(store, piece, options, Infinity);
    await acted('second');
    // Two ticks can each find it due before either run starts it.
    await runWork(store, piece, options, Infinity);
    expect(await left('messages', 'id')).toEqual(['second']);
  });

  it('is due again when it was found due and never run', async () => {
    const options: RunOptions = { ephemeral: memoryEphemeral(), connect: () => Promise.reject(new Error('not connected')), log: () => {}, now: () => NOW };
    const upkeepDue = async () => (await dueWork(store, options)).filter((work) => work.kind === 'upkeep');
    expect(await upkeepDue()).toHaveLength(1);
    expect(await upkeepDue()).toHaveLength(1);
    await workDue(store, options, Infinity);
    expect(await upkeepDue()).toEqual([]);
  });
});
