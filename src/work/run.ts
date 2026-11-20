import type { Sql } from '../store/sql.ts';
import { reconcile, reconcileDue } from '../actions/executor.ts';
import type { Mailbox } from '../actions/mailbox.ts';
import type { GmailApi } from '../gmail/api.ts';
import { READ_KEEP_DAYS, indexKept, purgeRead, searchDue } from '../store/kept.ts';
import type { FilterCheck } from '../actions/rule-filters.ts';
import type { UnsubscribeOutcome } from '../actions/unsubscribe.ts';
import type { Judge } from '../triage/stages/model.ts';
import type { Highlighter } from '../triage/digest.ts';
import type { Ephemeral } from '../ephemeral/ephemeral.ts';
import { type Account, lastSyncedAt, listAccounts, listUsers, mailboxesOf, signInEnded, signInHeld } from '../store/accounts.ts';
import type { Store } from '../store/store.ts';
import { EXAMPLE_KEEP_DAYS, pruneExamples } from '../store/examples.ts';
import { latestArrival, listUndecided } from '../store/messages.ts';
import { listUnsettledDecisions } from '../store/decisions.ts';
import { preferences } from '../store/preferences.ts';
import { bodiesDue, keepMailBodies, keepWaitingText, mailBodiesDue, readingOnce } from './bodies.ts';
import { captureExamples, examplesDue } from './examples.ts';
import { PRUNE_PER_RUN, RETENTION_DAYS, pruneOld } from './retention.ts';
import { continueEval, goingEvals } from '../learn/evals.ts';
import { hasOwnLabels } from '../store/labels.ts';
import { continueInboxRun, continueRuleRun } from './inbox.ts';
import { copyMail } from './copy.ts';
import { dropTextBefore, goingCopies } from '../store/copies.ts';
import { windowStart } from '../mail-window.ts';
import { goingInboxRun, goingInboxRuns } from '../store/inbox.ts';
import { checkFiltersWhenDue, filtersDue } from './filters.ts';
import { type PassStatus, lastPass, recordPassStatus } from './status.ts';
import { TICK_MS, lookGap } from './gap.ts';
import { type SyncReport, syncAccount, syncWants } from './sync.ts';
import { CHANGE_TRIES, type TriageReport, triageAccount } from './triage.ts';
import { digestsWanted, sendDigests } from './digest.ts';
import { identify, reportError, traced } from '../telemetry.ts';

export interface RunOptions {
  ephemeral: Ephemeral;
  /** Opens a provider connection for an account, with the sign-in kept in `db`, its person's database. */
  connect: (db: Sql, account: Account) => { api: GmailApi; mailbox: Mailbox } | Promise<{ api: GmailApi; mailbox: Mailbox }>;
  /** The inference tier of the person whose database `db` is: null when they have no model, or it cannot be reached. */
  model?: (db: Sql) => Promise<{ judge: Judge; highlight?: Highlighter; model: string } | null>;
  /** Leaves a mailing list, for decisions that say to. Without it sift never unsubscribes. */
  unsubscribe?: (db: Sql, accountId: string, messageId: string) => Promise<UnsubscribeOutcome>;
  log: (line: string) => void;
  /** Where the dashboard is reached from the person's own devices, for links in what Sift puts in their Gmail. */
  dashboard?: string;
  now?: () => number;
}

const DAY_MS = 86_400_000;
const today = (options: Pick<RunOptions, 'now'>) => Math.floor((options.now ?? Date.now)() / DAY_MS);
/** A person's upkeep done today. */
const upkeepKey = (person: number, day: number) => `upkeep:${person}:${day}`;

export interface PassResult {
  email: string;
  sync?: SyncReport;
  triage?: TriageReport;
  /** Marked messages whose full content was stored this pass. */
  captured?: number;
  /** Messages whose text was kept before there was a search index, indexed this pass. */
  indexed?: number;
  /** What a look at the account's Gmail filters found, on the passes that looked. */
  filters?: FilterCheck;
  error?: string;
  /** The error is Google refusing sift's sign-in for this account. Retrying will not help; signing in again will. */
  expired?: true;
  /** Stopped at its time limit with work left. */
  unfinished?: true;
}

/**
 * Text kept before there was a search index, indexed by each pass: about 3 seconds of a pass, so 100,000 messages take
 * 100 passes, which the look begins one a minute while any is left (`searchDue`).
 */
const INDEX_PER_PASS = 1_000;

/** Whether a person is still there: one deleted while a pass ran is skipped, not reported. */
const stillThere = async (store: Store, id: number) => (await listUsers(store.central)).some((u) => u.id === id);

/** One pass over each mailbox in one person's database, one after another, with no time limit. */
export async function runOnce(db: Sql, options: RunOptions): Promise<PassResult[]> {
  const results: PassResult[] = [];
  for (const account of await listAccounts(db)) {
    const result = await passMailbox(db, account, options, Infinity);
    if (result) results.push(result);
  }
  return results;
}

/**
 * A piece of work a tick found due: ids only, so it can be the argument of a Workflow run of its own
 * (`src/sift/flow.ts`), and whatever runs it opens everything it touches from them.
 */
export type Work =
  | { kind: 'pass'; person: number; mailbox: number }
  | { kind: 'upkeep'; person: number }
  | { kind: 'inbox'; person: number; mailbox: number; run: number }
  | { kind: 'copy'; person: number; mailbox: number }
  | { kind: 'eval'; person: number; run: number }
  | { kind: 'digest'; person: number };

/**
 * What is due, found in the record and the ephemeral store, so a tick needs nothing remembered from the last, and
 * work a tick left unfinished is simply due again. `people`: those who just asked, whose passes are begun
 * without looking. Without it, the timed tick: everyone, each mailbox's pass only when `passWanted`.
 */
export async function dueWork(store: Store, options: RunOptions, people?: readonly number[]): Promise<Work[]> {
  const day = today(options);
  const due: Work[] = [];
  for (const { id: person } of await listUsers(store.central)) {
    if (people && !people.includes(person)) continue;
    const db = await store.user(person);
    if ((await options.ephemeral.get(upkeepKey(person, day))) === null) due.push({ kind: 'upkeep', person });
    const runs = await goingInboxRuns(db);
    // Nothing is read from their Gmail until the person has said, with a label of their own, what they want of it.
    const reading = await hasOwnLabels(db);
    const evals = await goingEvals(db);
    const copies = (await preferences(db)).mail ? await goingCopies(db) : [];
    // Going through an inbox and a test run wait for a model, so the timed tick begins neither without one. Applying a rule needs none.
    const modelled = Boolean(people) || ((runs.some((run) => !run.ruleId) || evals.length > 0) && Boolean(options.model && (await options.model(db))));
    for (const account of await listAccounts(db)) {
      if (!reading) continue;
      if (people || (await passWanted(db, account, options))) due.push({ kind: 'pass', person, mailbox: account.number });
      // An expired sign-in fails a copy as it fails a pass.
      if (copies.some((c) => c.accountId === account.id) && (people || !(await lastPass(options.ephemeral, account.id))?.expired))
        due.push({ kind: 'copy', person, mailbox: account.number });
      const going = runs.filter((run) => run.accountId === account.id && (run.ruleId || modelled));
      // An expired sign-in fails a slice as it fails a pass; the look above finds when Gmail answers again.
      if (going.length === 0 || (!people && (await lastPass(options.ephemeral, account.id))?.expired)) continue;
      for (const run of going) due.push({ kind: 'inbox', person, mailbox: account.number, run: run.id });
    }
    if (modelled) for (const run of evals) due.push({ kind: 'eval', person, run });
    if (reading && (await digestsWanted(db, (options.now ?? Date.now)()))) due.push({ kind: 'digest', person });
  }
  return due;
}

export const describeWork = (work: Work) =>
  work.kind === 'pass'
    ? `Mailbox ${work.mailbox}: pass`
    : work.kind === 'inbox'
      ? `Mailbox ${work.mailbox}: inbox run ${work.run}`
      : work.kind === 'copy'
        ? `Mailbox ${work.mailbox}: copying mail for Inbox`
        : work.kind === 'eval'
          ? 'A test run'
          : work.kind === 'digest'
            ? 'Daily digests'
            : 'Deleting old records';

/**
 * Run one piece of due work, starting nothing after `until`. Everything it touches is opened here from the
 * piece's ids. A failure is logged; the piece is due again at the next tick. One piece at a time is the caller's
 * to hold to: a Workflow run's key (`src/sift/flow.ts`).
 */
export const runWork = (store: Store, work: Work, options: RunOptions, until: number): Promise<PassResult | null> =>
  traced('sift.work', work.kind, {}, async (span) => {
    try {
      identify({ id: work.person });
      if (!(await stillThere(store, work.person))) return null;
      const db = await store.user(work.person);
      const account = 'mailbox' in work ? (await listAccounts(db)).find((a) => a.number === work.mailbox) : undefined;
      if (account) identify({ id: work.person, email: account.email });
      switch (work.kind) {
        case 'upkeep': {
          // Held for the day once it starts, not once it is found due, so one that fails is due again at the next tick.
          const key = upkeepKey(work.person, today(options));
          const token = await options.ephemeral.claim(key, 2 * DAY_MS);
          if (token === null) return null;
          try {
            await upkeep(db, options);
          } catch (error) {
            await options.ephemeral.release(key, token);
            throw error;
          }
          return null;
        }
        case 'pass':
          return account ? await passMailbox(db, account, options, until) : null;
        case 'inbox':
          if (account) await goThroughInbox(db, account, work.run, options, until);
          return null;
        case 'copy':
          if (account) {
            const copied = await copyMail(
              { db, api: (await options.connect(db, account)).api, until, ...(options.now ? { now: options.now } : {}) },
              account.id,
            );
            if (copied) options.log(`${account.email}: copied ${copied} message${copied === 1 ? '' : 's'} for Inbox`);
          }
          return null;
        case 'eval': {
          const tier = options.model ? await options.model(db) : null;
          if (tier) await continueEval({ db, judge: tier.judge, model: tier.model, ...(options.now ? { now: options.now } : {}) }, work.run, until);
          return null;
        }
        case 'digest': {
          await digests(store, db, work.person, options, until);
          return null;
        }
      }
    } catch (error) {
      // A person deleted meanwhile has nothing left to report.
      if (await stillThere(store, work.person)) {
        span.fail();
        reportError(error);
        options.log(`${describeWork(work)} failed, will retry: ${error instanceof Error ? error.message : String(error)}`);
      }
      return null;
    }
  });

/** A person's digests due, each into their primary mailbox, with what their model picks as worth a look. */
async function digests(store: Store, db: Sql, person: number, options: RunOptions, until: number): Promise<void> {
  const accounts = await listAccounts(db);
  const primary = (await mailboxesOf(store.central, person)).find((m) => m.primary)?.id ?? accounts[0]?.id;
  if (!primary) return;
  const tier = options.model ? await options.model(db) : null;
  const sent = await sendDigests({
    db,
    primary,
    mailbox: async (accountId) => {
      const account = accounts.find((a) => a.id === accountId);
      if (!account) throw new Error('The digest’s mailbox is no longer connected.');
      return (await options.connect(db, account)).mailbox;
    },
    highlight: tier?.highlight ? { highlight: tier.highlight, model: tier.model } : null,
    until,
    ...(options.dashboard ? { dashboard: options.dashboard } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  if (sent > 0) options.log(`${primary}: put ${sent} digest${sent === 1 ? '' : 's'} in the inbox`);
}

/**
 * Go on with an inbox run over one mailbox. Applying a rule needs no model: it takes back what Sift did to the
 * mail it replaces, and the pass carries out what it records. Going through the inbox uses what a pass would:
 * its model, Gmail read once per message, and the mailbox only while Sift is on. Without a model it waits; deciding only what rules cover would leave the rest behind it.
 */
async function goThroughInbox(db: Sql, account: Account, run: number, options: RunOptions, until: number): Promise<void> {
  if ((await goingInboxRun(db, run))?.ruleId) {
    const { api, mailbox } = await options.connect(db, account);
    const went = await continueRuleRun({ db, api, mailbox, until, ...(options.now ? { now: options.now } : {}) }, run);
    if (went && went.to > went.from) options.log(`${account.email}: applied a rule to ${went.to} of ${went.of} in the inbox`);
    return;
  }
  const tier = options.model ? await options.model(db) : null;
  if (!tier) return;
  const { active } = await preferences(db);
  const leave = options.unsubscribe;
  const { api: gmail, mailbox } = await options.connect(db, account);
  const api = { ...gmail, ...readingOnce(db, account.id, gmail, options.now) };
  const went = await continueInboxRun(
    {
      db,
      api,
      mailbox: active ? mailbox : null,
      answers: mailbox,
      ...(leave ? { unsubscribe: (accountId: string, messageId: string) => leave(db, accountId, messageId) } : {}),
      sources: { api, mailbox },
      model: { judge: tier.judge, model: tier.model },
      until,
      ...(options.now ? { now: options.now } : {}),
    },
    account,
    run,
  );
  if (went && went.to > went.from) options.log(`${account.email}: went through ${went.to} of ${went.of} in the inbox`);
}

/** One pass, its outcome kept for the dashboard. Null when the mailbox was removed while it ran. */
async function passMailbox(db: Sql, account: Account, options: RunOptions, until: number): Promise<PassResult | null> {
  const began = (options.now ?? Date.now)();
  const result = await runMailbox(db, account, options, until);
  if (result)
    await recordPassStatus(options.ephemeral, account.id, {
      at: began,
      ...(result.error ? { error: result.error } : {}),
      ...(result.expired ? { expired: true } : {}),
      ...(result.unfinished ? { unfinished: true } : {}),
    });
  return result;
}

/**
 * Whether a pass over this mailbox would do anything: the record first, then, once the mailbox's look gap has passed,
 * Gmail's history since the cursor. Each condition is something `runMailbox` does on a pass, so the two change together.
 * What it cannot tell is a yes. A no is kept as a pass that found nothing would keep it, so "Last checked" stays true.
 */
async function passWanted(db: Sql, account: Account, options: RunOptions): Promise<boolean> {
  const now = (options.now ?? Date.now)();
  const last = await lastPass(options.ephemeral, account.id);
  try {
    // An expired sign-in fails every pass alike until the person signs in again, which only Gmail answering shows.
    if (!last?.expired && (await recordWants(db, account, options, now, last))) return true;
    // Looked at once the next tick would be past the gap, so a minute's gap is every tick however long the last pass took.
    const arrived = await latestArrival(db, account.id, now);
    if (last && now - last.at <= lookGap(arrived === null ? null : now - arrived) - TICK_MS) return false;
    const { api } = await options.connect(db, account);
    const wanted = await syncWants(db, api, account);
    await signInHeld(db, account.id, now);
    if (last?.expired || wanted) return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Any other error the pass meets too, and reports.
    if (!message.includes('invalid_grant')) return true;
    await signInEnded(db, account.id, now);
    if (!last?.expired) options.log(`${account.email}: Google sign-in has expired. Sign in to the dashboard again.`);
    await recordPassStatus(options.ephemeral, account.id, { at: now, error: message, expired: true });
    return false;
  }
  await recordPassStatus(options.ephemeral, account.id, { at: now });
  return false;
}

async function recordWants(db: Sql, account: Account, options: RunOptions, now: number, last: PassStatus | null): Promise<boolean> {
  // Not passed since this ephemeral store began, failed, or out of time: what it left is not all in the record.
  if (!last || last.error || last.unfinished) return true;
  const synced = await lastSyncedAt(db, account.id);
  // The day's first sync reads the mailbox's other addresses again.
  if (synced === null || Math.floor(synced / DAY_MS) !== Math.floor(now / DAY_MS)) return true;
  const { active } = await preferences(db);
  if (active && (await reconcileDue(db, account.id))) return true;
  if ((await listUnsettledDecisions(db, account.id, active ? {} : { byUserOnly: true })).length > 0) return true;
  if (await bodiesDue(db, account.id, now)) return true;
  if (await mailBodiesDue(db, account.id)) return true;
  if (await searchDue(db, account.id)) return true;
  if (await examplesDue(db, account.id)) return true;
  if (await filtersDue(db, account.id, active, now)) return true;
  // With no model, what no rule covers waits for one and a pass leaves it be. A rule added since decides it at the next
  // pass begun for anything else: new mail, a press, the day's first sync.
  return (await listUndecided(db, account.id, 1)).length > 0 && Boolean(options.model && (await options.model(db)));
}

/**
 * One pass over one mailbox, changing Gmail only if its person has sift on: settle unconfirmed actions,
 * sync, triage. A failure is reported; the next pass picks up where this one stopped.
 */
async function runMailbox(db: Sql, account: Account, options: RunOptions, until: number): Promise<PassResult | null> {
  const leave = options.unsubscribe;
  const over = () => (options.now ?? Date.now)() >= until;
  const { active } = await preferences(db);
  const tier = options.model ? await options.model(db) : null;
  const result: PassResult = { email: account.email };
  try {
    const { api: gmail, mailbox } = await options.connect(db, account);
    // Every read of a message's text in the pass goes through this, so each is read from Gmail once and kept.
    const api = { ...gmail, ...readingOnce(db, account.id, gmail, options.now) };
    const deps = { db, mailbox, ...(options.now ? { now: options.now } : {}) };
    if (active) await reconcile(deps, { accountId: account.id });
    result.sync = await syncAccount(db, api, account, options.now, until);
    if (result.sync.unfinished) return finish(result, active, options, true);
    // Before triage, which takes every pass there is while a backlog lasts: read only after it, mail left waiting would never get its text.
    if (!over()) await keepWaitingText(db, api, account.id, options.now);
    result.triage = await triageAccount(
      {
        ...deps,
        mailbox: active ? mailbox : null,
        answers: mailbox,
        ...(leave ? { unsubscribe: (accountId: string, messageId: string) => leave(db, accountId, messageId) } : {}),
        sources: { api, mailbox },
        ...(tier ? { model: { judge: tier.judge, model: tier.model } } : {}),
        until,
      },
      account,
    );
    if (result.triage.unfinished || over()) return finish(result, active, options, true);
    await keepWaitingText(db, api, account.id, options.now);
    // After triage, unlike waiting mail's: Inbox shows mail as it is, so classifying comes first.
    await keepMailBodies(db, api, account.id, options.now);
    if (over()) return finish(result, active, options, true);
    result.indexed = await indexKept(db, account.id, INDEX_PER_PASS, over);
    if (over()) return finish(result, active, options, true);
    result.captured = await captureExamples(db, api, account.id);
    try {
      const filters = await checkFiltersWhenDue(deps, account.id, active);
      if (filters) result.filters = filters;
    } catch (error) {
      // The mail was still triaged; the filters are looked at again next pass.
      reportError(error);
      options.log(`${account.email}: could not check Gmail filters: ${error instanceof Error ? error.message : String(error)}`);
    }
    return finish(result, active, options, false);
  } catch (error) {
    // Removed while the pass ran: there is nothing left to report about.
    if (!(await listAccounts(db)).some((a) => a.id === account.id)) return null;
    result.error = error instanceof Error ? error.message : String(error);
    // Google's answer when a refresh token is no longer good; an app left in Testing does this every 7 days.
    if (result.error.includes('invalid_grant')) {
      result.expired = true;
      await signInEnded(db, account.id, (options.now ?? Date.now)());
      options.log(`${account.email}: Google sign-in has expired. Sign in to the dashboard again.`);
    } else {
      reportError(error);
      options.log(`${account.email}: pass failed, will retry: ${result.error}`);
    }
  }
  return result;
}

function finish(result: PassResult, active: boolean, options: RunOptions, unfinished: boolean): PassResult {
  if (unfinished) result.unfinished = true;
  const line = describe(result, active);
  if (line) options.log(`${result.email}: ${line}`);
  return result;
}

/** A one-line summary of a pass, or null when nothing happened. */
function describe(result: PassResult, active: boolean): string | null {
  const parts: string[] = [];
  const { sync, triage } = result;
  if (sync?.mode === 'recovery') parts.push('history cursor had expired, searched the last 7 days');
  if (sync && sync.added.length > 0) parts.push(`${sync.added.length} new`);
  if (sync?.kept) parts.push(`${sync.kept} more kept for Inbox`);
  if (sync?.corrections) parts.push(`learned from ${sync.corrections} message${sync.corrections === 1 ? '' : 's'} you moved or relabelled in Gmail`);
  if (triage) {
    const decided = Object.entries(triage.decided).filter(([, n]) => n > 0);
    if (decided.length > 0) parts.push(`${active ? 'decided' : 'would'} ${decided.map(([d, n]) => `${d} ${n}`).join(', ')}`);
    if (triage.acted > 0) parts.push(`${triage.acted} changed`);
    if (triage.skipped > 0) parts.push(`${triage.skipped} skipped`);
    if (triage.unsubscribed > 0) parts.push(`unsubscribed from ${triage.unsubscribed} sender${triage.unsubscribed === 1 ? '' : 's'}`);
    if (triage.blocked > 0) parts.push(`blocked ${triage.blocked} sender${triage.blocked === 1 ? '' : 's'}`);
    if (triage.unjudged > 0) parts.push(`the model failed on ${triage.unjudged}: ${triage.failure}`);
    if (triage.retrying > 0) parts.push(`${triage.retrying} change${triage.retrying === 1 ? '' : 's'} to try again`);
    if (triage.troubled > 0) parts.push(`${triage.troubled} change${triage.troubled === 1 ? '' : 's'} not made after ${CHANGE_TRIES} tries`);
  }
  if (result.indexed) parts.push(`indexed ${result.indexed} kept message${result.indexed === 1 ? '' : 's'} for search`);
  if (result.captured) parts.push(`stored ${result.captured} marked message${result.captured === 1 ? '' : 's'} as examples`);
  if (result.unfinished) parts.push('out of time, carrying on');
  const { filters } = result;
  if (filters?.gone) parts.push(`${filters.gone} filter${filters.gone === 1 ? '' : 's'} deleted in Gmail`);
  if (filters?.changed) parts.push(`${filters.changed} filter${filters.changed === 1 ? '' : 's'} changed in Gmail`);
  if (filters?.outdated)
    parts.push(`${filters.outdated} filter${filters.outdated === 1 ? '' : 's'} ${active ? 'brought into line with' : 'no longer match'} their rules`);
  return parts.length > 0 ? parts.join('; ') : null;
}

/** One person's upkeep, done by the first tick of each day: old examples, message text and messages go. */
export async function upkeep(db: Sql, options: Pick<RunOptions, 'log' | 'now'>): Promise<void> {
  const now = (options.now ?? Date.now)();
  const dropped = await pruneExamples(db, now);
  if (dropped > 0) options.log(`Deleted ${dropped} example${dropped === 1 ? '' : 's'} older than ${EXAMPLE_KEEP_DAYS} days`);
  await purgeRead(db, now - READ_KEEP_DAYS * DAY_MS);
  let pruned: number;
  do {
    pruned = await pruneOld(db, now);
    if (pruned > 0) options.log(`Forgot ${pruned} message${pruned === 1 ? '' : 's'} with nothing newer than ${RETENTION_DAYS} days`);
  } while (pruned >= PRUNE_PER_RUN);
  // A record that a recent decision or change keeps past Inbox's window keeps no text.
  const { mail, mailWindow } = await preferences(db);
  const since = mail ? windowStart(mailWindow, now) : null;
  if (since !== null) await dropTextBefore(db, since);
}
