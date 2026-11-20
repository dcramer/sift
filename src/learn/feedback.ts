import {
  type SQL,
  type VERDICTS,
  alias,
  and,
  asc,
  count,
  decisions,
  desc,
  eq,
  examples,
  feedback,
  gte,
  inArray,
  isNotNull,
  labels,
  max,
  messages,
  min,
  ne,
  not,
  notExists,
  or,
  rules,
  sql,
} from '../store/query.ts';
import type { Sql } from '../store/sql.ts';
import { exampleKeysOf, hashOf, openEnvelope } from '../store/content.ts';
import { listLabels } from '../store/labels.ts';
import { recordDecision } from '../store/decisions.ts';
import { exampleText } from '../store/kept.ts';
import { proposeFromCorrections } from '../store/proposals.ts';
import type { RuleFacts } from '../triage/facts.ts';
import { factsWhere } from '../store/messages.ts';
import { type DecidedDisposition, type Decision, type Disposition, LEAVE_IN_INBOX, type StageName, labelled } from '../triage/types.ts';
import { Refusal } from '../refusal.ts';
import { plain } from '../plain.ts';
import type { Confidential } from '../confidential.ts';

/** A decision sift only suggested, that the user has not yet confirmed or corrected. */
export interface Suggestion {
  decisionId: number;
  accountId: string;
  messageId: string;
  stage: StageName;
  disposition: Disposition;
  /** With `spam`: sift would also block the sender. */
  block: boolean;
  /** With `archive`: sift would list it in its label's digest. */
  digest: boolean;
  /** The label sift gave it, or null if it could not place it. */
  labelId: string | null;
  /** Carried out: Sift was on, so it is in Gmail with the review label, asked about there. */
  carriedOut: boolean;
  confidence: number | null;
  decidedAt: number;
  receivedAt: number;
  fromAddress: Confidential;
  fromName: Confidential | null;
  subject: Confidential;
}

const x = alias(decisions, 'x');

const SUGGESTION = {
  decisionId: decisions.id,
  accountId: decisions.accountId,
  messageId: decisions.messageId,
  stage: decisions.stage,
  disposition: decisions.disposition,
  block: decisions.block,
  digest: decisions.digest,
  labelId: decisions.labelId,
  carriedOut: decisions.carryOut,
  confidence: decisions.confidence,
  decidedAt: decisions.decidedAt,
  receivedAt: messages.receivedAt,
  headers: messages.headers,
};

const toSuggestion = (db: Sql, r: Omit<Suggestion, 'fromAddress' | 'fromName' | 'subject'> & { headers: string }): Suggestion =>
  openEnvelope(db, r.accountId, r.messageId, r);

/**
 * Suggestions waiting on the user, newest first: the current decision for a message, recorded as
 * a suggestion or, while Sift was on, left for the user to say, with no answer yet. Decisions that only
 * repeat what the user already told sift (their answers, and rules they wrote or made by correcting it)
 * are not suggestions and are left out; ones from a rule sift learned are.
 */
export async function pendingSuggestions(
  db: Sql,
  filter: { accountId?: string; accounts?: readonly string[]; sender?: string; facts?: RuleFacts; since?: number; limit?: number } = {},
): Promise<Suggestion[]> {
  const rows = await db
    .select(SUGGESTION)
    .from(decisions)
    .innerJoin(messages, and(eq(messages.accountId, decisions.accountId), eq(messages.id, decisions.messageId)))
    .leftJoin(rules, eq(rules.id, decisions.ruleId))
    .where(waiting(db, filter))
    .orderBy(desc(decisions.decidedAt), desc(decisions.id))
    .limit(filter.limit ?? 5000);
  return rows.map((r) => toSuggestion(db, r));
}

/** How many of `pendingSuggestions` would leave the mail where it is not: what For review counts in the masthead. Nothing is decrypted. */
export async function waitingCount(db: Sql, accounts: readonly string[]): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(decisions)
    .innerJoin(messages, and(eq(messages.accountId, decisions.accountId), eq(messages.id, decisions.messageId)))
    .leftJoin(rules, eq(rules.id, decisions.ruleId))
    .where(and(waiting(db, { accounts }), ne(decisions.disposition, 'keep')));
  return row?.n ?? 0;
}

const waiting = (db: Sql, filter: { accountId?: string; accounts?: readonly string[]; sender?: string; facts?: RuleFacts; since?: number }) =>
  and(
    eq(
      decisions.id,
      db
        .select({ id: max(x.id) })
        .from(x)
        .where(and(eq(x.accountId, decisions.accountId), eq(x.messageId, decisions.messageId))),
    ),
    // Mail Sift asked about while on is waiting on the user as much as what it would have done while off.
    or(eq(decisions.carryOut, false), eq(decisions.disposition, 'review')),
    eq(decisions.byUser, false),
    notExists(
      db
        .select({ one: sql`1` })
        .from(feedback)
        .where(eq(feedback.decisionId, decisions.id)),
    ),
    not(and(isNotNull(decisions.ruleId), ne(sql`coalesce(${rules.source}, 'user')`, 'learned'))!),
    filter.accounts === undefined ? undefined : inArray(decisions.accountId, filter.accounts),
    filter.accountId === undefined ? undefined : eq(decisions.accountId, filter.accountId),
    filter.sender === undefined ? undefined : eq(messages.senderHash, hashOf(db, filter.sender)),
    filter.facts === undefined ? undefined : factsWhere(filter.facts),
    filter.since === undefined ? undefined : gte(decisions.decidedAt, filter.since),
  );

/** A message sift never decided (the model could not judge it), with who sent it, or null. */
async function undecided(db: Sql, accountId: string, messageId: string): Promise<{ fromAddress: string } | null> {
  const [row] = await db
    .select({ headers: messages.headers })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        eq(messages.id, messageId),
        notExists(
          db
            .select({ one: sql`1` })
            .from(decisions)
            .where(and(eq(decisions.accountId, messages.accountId), eq(decisions.messageId, messages.id))),
        ),
      ),
    );
  return row ? plain(openEnvelope(db, accountId, messageId, row)) : null;
}

/** The decision that currently stands for a message, in the shape of a suggestion, or null if it has none. */
async function currentDecision(db: Sql, accountId: string, messageId: string): Promise<Suggestion | null> {
  const [row] = await db
    .select(SUGGESTION)
    .from(decisions)
    .innerJoin(messages, and(eq(messages.accountId, decisions.accountId), eq(messages.id, decisions.messageId)))
    .where(and(eq(decisions.accountId, accountId), eq(decisions.messageId, messageId)))
    .orderBy(desc(decisions.id))
    .limit(1);
  return row ? toSuggestion(db, row) : null;
}

export interface FeedbackInput {
  accountId: string;
  sender: string;
  /** What the mail is: a label's id. */
  label: string;
  /** What should happen to it. Left out: what the label does. */
  disposition?: DecidedDisposition;
  /** The decision the answer was given on, when the message had one: an answer to one since replaced corrects the new one. */
  decisionId?: number;
  /**
   * The one message the answer is about; the sender's other waiting mail is left alone. It need not be
   * waiting: this is how a decision sift already made, or mail it kept, is corrected, and how mail the
   * model could not judge is answered. Either gets a new decision.
   */
  messageId: string;
  /**
   * Each message the answer settles gets it as a decision of its own, carried out in Gmail on the next
   * pass even while sift is off. Without it (an answer read from Gmail, where the mail already is) only
   * the corrected message's decision is recorded, and nothing is carried out.
   */
  carryOut?: boolean;
  /** Where the answer was given. Default: the dashboard. */
  via?: 'dashboard' | 'gmail';
}

interface FeedbackResult {
  /** The message whose earlier decision was replaced, so the caller can put it right in the mailbox. */
  corrected: string | null;
  /** How many messages now have the answer waiting to be carried out in Gmail. */
  carrying: number;
  /** Messages this answer settled that Sift had marked for review in Gmail, so the caller can take that mark back. */
  asked: string[];
}

const DO: Record<DecidedDisposition, string> = { keep: 'keep it', archive: 'archive it', spam: 'mark it as spam' };

/**
 * Record the user's answer about what a message is. It makes no rule: the message is kept as an example
 * for the model, and nothing is tied to the sender until the user adds a rule in the rule dialog.
 *
 * Throws if the label does not exist, or the answer refers to nothing that is waiting.
 */
export async function applyFeedback(db: Sql, input: FeedbackInput, now: number = Date.now()): Promise<FeedbackResult> {
  const label = (await listLabels(db)).find((l) => l.id === input.label);
  if (!label) throw new Refusal(`There is no label "${input.label}".`);
  const outcome = input.disposition ?? label.disposition;
  if (label.id === LEAVE_IN_INBOX && outcome !== 'keep') throw new Refusal('Mail left in your inbox stays there. Choose the label for mail to move.');
  // A label set to "leave it for me" keeps the mail in the inbox.
  const wanted: DecidedDisposition = outcome === 'review' ? 'keep' : outcome;

  const waiting = await pendingSuggestions(db, { accountId: input.accountId, sender: input.sender });
  const targets = waiting.filter((s) => s.messageId === input.messageId && (input.decisionId === undefined || s.decisionId === input.decisionId));
  // A message that is not waiting (sift already acted on it, a rule decided it, or it was answered before)
  // is corrected through its current decision.
  const given = targets.length === 0 ? await currentDecision(db, input.accountId, input.messageId) : null;
  // Mail sift never decided has nothing to correct: the answer is its first decision, with no suggestion before it.
  const fresh = targets.length === 0 && !given ? await undecided(db, input.accountId, input.messageId) : null;
  const from = given?.fromAddress ?? fresh?.fromAddress;
  if (from !== undefined && from !== input.sender) throw new Refusal('That message is not from that sender.');
  if (targets.length === 0 && !given && !fresh) throw new Refusal('That message is no longer waiting for review.');

  // Agreeing with a decision that already stands changes nothing about the message itself.
  const changes = given !== null && (given.labelId !== label.id || given.disposition !== outcome);
  // sift having no suggestion is not sift being wrong.
  const verdictFor = (target: Pick<Suggestion, 'labelId'>): (typeof VERDICTS)[number] =>
    target.labelId === null ? 'answered' : target.labelId === label.id ? 'right' : 'wrong';
  // Pressed in the dashboard: what the user said is done to each waiting message it settled.
  const answer: Decision = {
    ...labelled(label, wanted === label.disposition ? undefined : wanted),
    stage: 'rules',
    reason:
      label.id === LEAVE_IN_INBOX
        ? 'you said to leave it in your inbox'
        : input.disposition !== undefined && input.disposition !== label.disposition
          ? `you said this is ${label.name}, and to ${DO[wanted]}`
          : `you said this is ${label.name}`,
  };
  await db.transaction(async (tx) => {
    const settled: Pick<Suggestion, 'accountId' | 'decisionId' | 'messageId' | 'labelId'>[] = given ? [...targets, given] : [...targets];
    const carried = { carryOut: input.carryOut ?? false, byUser: true, now };
    if (fresh) {
      const decisionId = await recordDecision(tx, input.accountId, input.messageId, answer, carried);
      settled.push({ accountId: input.accountId, decisionId, messageId: input.messageId, labelId: null });
    }
    for (const target of settled) {
      const answered = { verdict: verdictFor(target), disposition: wanted, labelId: label.id, via: input.via ?? 'dashboard', createdAt: now };
      await tx
        .insert(feedback)
        .values({ accountId: target.accountId, decisionId: target.decisionId, ...answered })
        .onConflictDoUpdate({ target: [feedback.userId, feedback.decisionId], set: answered });
      // Every marked message is kept as an example, with the text Sift holds of it; without any, the next pass captures it.
      const kept = await exampleText(tx, target.accountId, target.messageId);
      const held = kept ? { status: 'captured' as const, ...kept } : {};
      const marked = { labelId: label.id, markedAt: now, ...held };
      await tx
        .insert(examples)
        .values({ accountId: target.accountId, messageId: target.messageId, ...marked, ...(await exampleKeysOf(tx, target.accountId, target.messageId)) })
        .onConflictDoUpdate({ target: [examples.userId, examples.accountId, examples.messageId], set: marked });
    }
    // Mail Sift already marked in Gmail gets the answer as a decision of its own however it was given, as a correction would.
    for (const target of targets) if (input.carryOut || target.carriedOut) await recordDecision(tx, input.accountId, target.messageId, answer, carried);
    // The corrected message gets a decision of its own, so the log shows what the user said and, when
    // it is carried out, the mailbox is brought into line with it.
    if (given && changes) await recordDecision(tx, input.accountId, given.messageId, answer, carried);
  });
  // An answer makes no rule of its own; enough answers giving a sender's mail of one label another action, and Sift offers one.
  await proposeFromCorrections(db, input.accountId, input.sender, label.id, now);
  return {
    corrected: given && changes ? given.messageId : null,
    carrying: input.carryOut ? targets.length + ((given && changes) || fresh ? 1 : 0) : 0,
    asked: input.carryOut ? targets.filter((t) => t.carriedOut).map((t) => t.messageId) : [],
  };
}

export interface Accuracy {
  reviewed: number;
  right: number;
  /** Per tier that made the suggestion. Tiers with no answers are absent. */
  byStage: { stage: StageName; reviewed: number; right: number }[];
  /** Per label sift gave, most answers first. */
  byLabel: { labelId: string; labelName: string; reviewed: number; right: number }[];
  /** What sift called one label when the user said another, commonest first. */
  confusion: { suggested: string; correct: string; count: number }[];
}

/**
 * How often sift's suggestions matched what the user wanted, from the answers given since `since`.
 * An answer to mail sift could not place is not counted: having no suggestion is not being wrong.
 */
export async function accuracy(db: Sql, since = 0, accounts?: readonly string[]): Promise<Accuracy> {
  const right = sql<number>`count(*) FILTER (WHERE ${feedback.verdict} = 'right')`.mapWith(Number);
  const scored = (...also: SQL[]) =>
    and(
      inArray(feedback.verdict, ['right', 'wrong']),
      gte(feedback.createdAt, since),
      // Given, only these accounts' answers count; none given means none count.
      accounts === undefined ? undefined : inArray(feedback.accountId, accounts),
      ...also,
    );
  const byStage = await db
    .select({ stage: decisions.stage, reviewed: count(), right })
    .from(feedback)
    .innerJoin(decisions, eq(decisions.id, feedback.decisionId))
    .where(scored())
    .groupBy(decisions.stage)
    .orderBy(asc(decisions.stage));
  const byLabel = (await db
    .select({ labelId: decisions.labelId, labelName: min(labels.name), reviewed: count(), right })
    .from(feedback)
    .innerJoin(decisions, eq(decisions.id, feedback.decisionId))
    .innerJoin(labels, eq(labels.id, decisions.labelId))
    .where(scored())
    .groupBy(decisions.labelId)
    .orderBy(desc(count()), asc(decisions.labelId))) as { labelId: string; labelName: string; reviewed: number; right: number }[];
  const confusion = (await db
    .select({ suggested: decisions.labelId, correct: feedback.labelId, count: count() })
    .from(feedback)
    .innerJoin(decisions, eq(decisions.id, feedback.decisionId))
    .where(scored(eq(feedback.verdict, 'wrong'), isNotNull(decisions.labelId), isNotNull(feedback.labelId)))
    .groupBy(decisions.labelId, feedback.labelId)
    .orderBy(desc(count()), asc(decisions.labelId), asc(feedback.labelId))) as { suggested: string; correct: string; count: number }[];
  return {
    reviewed: byStage.reduce((sum, r) => sum + r.reviewed, 0),
    right: byStage.reduce((sum, r) => sum + r.right, 0),
    byStage,
    byLabel,
    confusion,
  };
}
