import { undo } from '../actions/executor.ts';
import type { Mailbox } from '../actions/mailbox.ts';
import type { GmailApi } from '../gmail/api.ts';
import { toFacts } from '../gmail/sync.ts';
import { recordFound } from '../store/accounts.ts';
import { lastStandingChange } from '../store/actions.ts';
import { isOwnDigest } from '../store/digests.ts';
import { currentDecision, recordDecision } from '../store/decisions.ts';
import { listLabels } from '../store/labels.ts';
import { REACH } from '../store/inbox.ts';
import { getFacts, markApplying } from '../store/messages.ts';
import { countRuleHit, listRules } from '../store/rules.ts';
import { cachedCorrespondent } from '../store/senders.ts';
import type { Sql } from '../store/sql.ts';
import { type RuleMatch, priorRule, rulesStage, settle } from '../triage/stages/rules.ts';
import type { Decision, MessageFacts } from '../triage/types.ts';
import { Refusal } from '../refusal.ts';
import { reportError } from '../telemetry.ts';

/** How many of the newest the preview checks the rule on, to say about how many it would decide. */
const SAMPLE = 20;
/** The newest of those the preview shows. */
export const EXAMPLES = 5;

/**
 * What the rule would do to one message: decide it now, or wait for a model to say what it is. `replaces`: Sift's
 * own change to it stands in Gmail, and is taken back first.
 */
type Plan = { decide: Decision; again: boolean; replaces: boolean } | { read: true };

interface InboxMatch {
  messageId: string;
  subject: string;
  receivedAt: number;
}

/** What applying a rule to the inbox would do, from its newest matches. */
export interface InboxSample {
  examples: InboxMatch[];
  /** How many it would decide, or about how many when only some were checked; at most what one press goes through. */
  messages: number;
  /** Of `messages`, how many a model must read first. */
  reading: number;
  exact: boolean;
  /** How many one press goes through, when more match than that. */
  most: number | null;
}

// The values go into a Gmail search, so anything that could change its meaning is left out, which only widens it.
const PLAIN = /^[\w.@+-]+$/;

/** A Gmail search for the inbox mail a rule could match. It only narrows: the rule itself is checked on each message found. */
export function inboxQuery(match: RuleMatch): string {
  const terms: string[] = [];
  // Several values are alternatives; one that cannot be searched for leaves the whole condition out.
  const add = (operator: string, values: readonly string[]) => {
    if (values.length === 0 || !values.every((v) => PLAIN.test(v))) return;
    terms.push(`${operator}:${values.length === 1 ? values[0] : `(${values.join(' OR ')})`}`);
  };
  add('from', [...(match.from ?? []), ...(match.fromDomain ?? [])]);
  add('to', match.to ?? []);
  add('list', match.listId ?? []);
  // Not the subject: Gmail matches whole words, and the rule part of one ("order conf" in "Order confirmation").
  return terms.join(' ');
}

/** The person's rules and labels, with `ruleId` among them, to apply in one of their mailboxes; null once it has been removed. */
export async function rulesWith(db: Sql, accountId: string, ruleId: string) {
  const rules = await listRules(db);
  const rule = rules.find((r) => r.id === ruleId);
  return rule ? { accountId, rule, rules, labels: await listLabels(db) } : null;
}
type Given = NonNullable<Awaited<ReturnType<typeof rulesWith>>>;

/**
 * What `ruleId` does to one message, as the rules stand: null when it does nothing (another rule decides
 * it, the user has had their say, a decision waits to be carried out, or Sift already made the same change).
 * Mail Sift decided and changed while on is decided again, its change replaced. A rule that needs a model
 * applies at once to mail a tier already placed, and otherwise waits for the model.
 */
async function planFor(db: Sql, given: Given, ruleId: string, facts: MessageFacts, now: number): Promise<Plan | null> {
  const current = await currentDecision(db, facts.accountId, facts.messageId);
  if (current && (current.answered || (current.carryOut && current.outcome === null))) return null;
  // What Sift carried out stands in Gmail, as a change or as leaving the mail alone.
  const standing = current?.carryOut && (current.outcome === 'done' || current.outcome === 'none') ? current.decision : null;
  const written = await cachedCorrespondent(db, facts.accountId, facts.from.address, now);
  const options = { hasWritten: () => written };
  const plan = (decide: Decision, again: boolean): Plan | null =>
    standing && sameChange(standing, decide) ? null : { decide, again, replaces: current?.outcome === 'done' };
  // A rule that waits for a label was applied to its tier's decision when the rule was made.
  if (current?.decision.ruleId === ruleId) return current.carryOut ? null : plan(current.decision, true);
  const decided = await rulesStage(given.rules, given.labels, { ...options, judged: true }).decide(facts);
  if (decided?.ruleId === ruleId) return plan(decided, false);
  if (current) {
    // A rule made since Sift carried out its tier's label had no say in what followed from it.
    const settled = current.carryOut ? settle(given.rules, given.labels, facts, current.decision, options) : null;
    return settled?.ruleId === ruleId ? plan(settled, false) : null;
  }
  return priorRule(given.rules, given.labels, facts, options)?.rule.id === ruleId ? { read: true } : null;
}

const sameChange = (a: Decision, b: Decision) =>
  a.disposition === b.disposition && (a.labelId ?? null) === (b.labelId ?? null) && Boolean(a.markRead) === Boolean(b.markRead);

/**
 * Recorded facts, or for mail Sift never saw, Gmail's, recorded as they are read so no look reads them again. Null when it has
 * gone, has left the inbox, or is Sift's own digest.
 */
async function factsOf(db: Sql, api: Pick<GmailApi, 'getMetadata'>, accountId: string, messageId: string, now: number) {
  const stored = await getFacts(db, accountId, messageId);
  if (stored) return stored;
  const raw = await api.getMetadata(messageId);
  const facts = raw ? toFacts(accountId, raw) : null;
  if (!facts?.labelIds.includes('INBOX') || (await isOwnDigest(db, facts.headers))) return null;
  await recordFound(db, accountId, [facts], now);
  return facts;
}

/**
 * What applying a rule to the inbox would do, found by searching Gmail and checking the rule on the newest
 * `SAMPLE`: exact when that is all there is, and otherwise scaled to Gmail's estimate of how many match the
 * search, which is rough. Nothing is decided or changed; mail Sift had never seen is recorded, out of the triage queue.
 */
export async function ruleInbox(
  db: Sql,
  api: Pick<GmailApi, 'searchInbox' | 'getMetadata'>,
  accountId: string,
  ruleId: string,
  now: number = Date.now(),
): Promise<InboxSample> {
  const given = await rulesWith(db, accountId, ruleId);
  if (!given) throw new Refusal('That rule no longer exists.');
  const page = await api.searchInbox(inboxQuery(given.rule.match));
  const found = page.nextPageToken ? Math.max(page.estimate ?? 0, page.ids.length) : page.ids.length;
  const sample = page.ids.slice(0, SAMPLE);
  const checked = await Promise.all(
    sample.map(async (id) => {
      const facts = await factsOf(db, api, accountId, id, now);
      const plan = facts && (await planFor(db, given, ruleId, facts, now));
      return facts && plan ? { facts, reads: 'read' in plan } : null;
    }),
  );
  const matched = checked.filter((m) => m !== null);
  const exact = sample.length === found;
  const scale = exact || sample.length === 0 ? 1 : Math.min(found, REACH.inbox) / sample.length;
  return {
    examples: matched.slice(0, EXAMPLES).map(({ facts }) => ({ messageId: facts.messageId, subject: facts.subject, receivedAt: facts.receivedAt })),
    messages: Math.round(matched.length * scale),
    reading: Math.round(matched.filter((m) => m.reads).length * scale),
    exact,
    most: found > REACH.inbox ? REACH.inbox : null,
  };
}

/**
 * Apply a rule to one message in the inbox, as the user's press: what it decides is recorded to be carried out
 * on the next pass whether Sift is on or off. Sift's own change from before is taken back first, so a retry
 * finds nothing left of it. Mail that needs a model first is recorded and marked, so the pass carries out what
 * the rule decides once the model has spoken. Null when the rule does nothing to it.
 */
export async function applyTo(
  db: Sql,
  gmail: { api: Pick<GmailApi, 'getMetadata'>; mailbox: Mailbox },
  given: Given,
  messageId: string,
  now: () => number,
): Promise<'deciding' | 'reading' | null> {
  const { accountId, rule } = given;
  const ruleId = rule.id;
  const found = await factsOf(db, gmail.api, accountId, messageId, now());
  if (!found) return null;
  const first = await planFor(db, given, ruleId, found, now());
  if (!first) return null;
  if ('decide' in first && first.replaces && !(await takeBack(db, gmail.mailbox, accountId, messageId, now))) return null;
  return await db.transaction(async (tx) => {
    const plan = await planFor(tx, given, ruleId, found, now());
    if (!plan) return null;
    if ('read' in plan) {
      await markApplying(tx, accountId, messageId, ruleId);
      return 'reading';
    }
    await recordDecision(tx, accountId, messageId, plan.decide, { carryOut: true, byUser: true, now: now() });
    if (!plan.again) await countRuleHit(tx, ruleId);
    return 'deciding';
  });
}

/** Take back Sift's last change to a message. False when it could not be: the rule then leaves the message as it is. */
async function takeBack(db: Sql, mailbox: Mailbox, accountId: string, messageId: string, now: () => number): Promise<boolean> {
  const last = await lastStandingChange(db, accountId, messageId);
  if (!last) return true;
  try {
    const outcome = await undo({ db, mailbox, now }, last.id);
    if (outcome.status === 'done' || outcome.status === 'skipped') return true;
    reportError(new Error(`Applying a rule could not take back change #${last.id}: ${outcome.reason}`));
  } catch (error) {
    // Gone or in the trash since the search found it.
    if (!(error instanceof Refusal)) throw error;
  }
  return false;
}
