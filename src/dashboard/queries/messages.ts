import { actions, and, asc, decisions, eq, examples, feedback, mailBodies, messages, modelRuns, sql, readBodies } from '../../store/query.ts';
import type { Sql } from '../../store/sql.ts';
import { unsubscribedAt, openPayload } from '../../store/actions.ts';
import { storedFacts } from '../../store/messages.ts';
import { openEnvelope, openPart } from '../../store/content.ts';
import { bulkSignals, passedDmarc } from '../../triage/features.ts';
import { Refusal } from '../../refusal.ts';
import { type Scope, within } from '../scope.ts';
import type { MessageDetail } from '../types.ts';
import { decisionsJoined, toDecisionRow } from './decisions.ts';
import { senderProfile } from './senders.ts';
import { plain, seal } from '../../plain.ts';
import type { Confidential } from '../../confidential.ts';

/**
 * Which of the scope's mailboxes holds the message with Gmail's id `messageId`, or null when none does. Gmail's ids
 * are each one mailbox's own, so two of a person's could in principle hold the same one: then the request must name
 * the mailbox (`?mailbox=`).
 */
async function mailboxOf(db: Sql, scope: Scope, messageId: string): Promise<string | null> {
  const found = await db
    .select({ accountId: messages.accountId })
    .from(messages)
    .where(and(within(scope, messages.accountId), eq(messages.id, messageId)));
  if (found.length > 1) throw new Refusal('More than one of your mailboxes has a message with that id; say which.');
  return found[0]?.accountId ?? null;
}

/** One message with its full history, in whichever of the scope's mailboxes holds it, or null if sift has not seen it. */
export async function messageDetail(db: Sql, scope: Scope, messageId: string): Promise<MessageDetail | null> {
  const accountId = await mailboxOf(db, scope, messageId);
  if (accountId === null) return null;
  const [stored] = await db
    .select({
      headers: messages.headers,
      receivedAt: messages.receivedAt,
    })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
  const facts = await storedFacts(db, accountId, messageId);
  if (!stored || !facts) return null;
  const m = openEnvelope(db, accountId, messageId, stored);

  const ofMessage = and(eq(decisions.accountId, accountId), eq(decisions.messageId, messageId));
  const shown = await decisionsJoined(db).where(ofMessage).orderBy(asc(decisions.id));
  const costs = new Map(
    (
      await db
        .select({
          id: decisions.id,
          ruleId: decisions.ruleId,
          inputTokens: sql<number>`coalesce(${modelRuns.inputTokens}, 0)`.mapWith(Number),
          outputTokens: sql<number>`coalesce(${modelRuns.outputTokens}, 0)`.mapWith(Number),
          durationMs: decisions.durationMs,
          answerLabel: feedback.labelId,
          answerDisposition: feedback.disposition,
        })
        .from(decisions)
        .leftJoin(modelRuns, eq(modelRuns.id, decisions.runId))
        .leftJoin(feedback, eq(feedback.decisionId, decisions.id))
        .where(ofMessage)
    ).map(
      ({ id, answerLabel, answerDisposition, ...rest }) =>
        [id, { ...rest, answer: answerDisposition === null ? null : { labelId: answerLabel, disposition: answerDisposition } }] as const,
    ),
  );
  const changes = await db
    .select({
      id: actions.id,
      type: actions.type,
      status: actions.status,
      payload: actions.payload,
      createdAt: actions.createdAt,
    })
    .from(actions)
    .where(and(eq(actions.accountId, accountId), eq(actions.messageId, messageId)))
    .orderBy(asc(actions.id));

  const body = await storedBody(db, accountId, messageId);
  return {
    accountId,
    messageId,
    fromAddress: m.fromAddress,
    fromName: m.fromName,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    receivedAt: m.receivedAt,
    headers: m.headers,
    body: body?.text ?? null,
    hasHtml: body?.html != null,
    facts: { ...facts, listId: seal(facts.listId) },
    unsubscribe: await canUnsubscribe(db, accountId, plain(m.fromAddress), plain(m.headers)),
    sender: (await senderProfile(db, scope, plain(m.fromAddress)))!,
    decisions: shown.map((r) => ({ ...toDecisionRow(db, r), ...costs.get(r.id)! })),
    actions: changes.map(({ payload: stored, ...a }) => {
      const payload = openPayload(db, accountId, stored);
      return { ...a, added: seal(payload.add), removed: seal(payload.remove) };
    }),
  };
}

/** A message as sift holds it, as text and HTML: Inbox's whole copy, a suggestion's temporary one, or an example the user made. */
async function storedBody(db: Sql, accountId: string, messageId: string): Promise<{ text: Confidential; html: Confidential | null } | null> {
  const [whole] = await db
    .select({ text: mailBodies.bodyText, html: mailBodies.bodyHtml })
    .from(mailBodies)
    .where(and(eq(mailBodies.accountId, accountId), eq(mailBodies.messageId, messageId)));
  if (whole) return { text: openPart(db, accountId, messageId, 'text', whole.text)!, html: openPart(db, accountId, messageId, 'html', whole.html) };
  const [held] = await db
    .select({ text: readBodies.bodyText, html: readBodies.bodyHtml })
    .from(readBodies)
    .where(and(eq(readBodies.accountId, accountId), eq(readBodies.messageId, messageId)));
  if (held) return { text: openPart(db, accountId, messageId, 'text', held.text)!, html: openPart(db, accountId, messageId, 'html', held.html) };
  const [kept] = await db
    .select({ text: examples.bodyText, html: examples.bodyHtml })
    .from(examples)
    .where(and(eq(examples.accountId, accountId), eq(examples.messageId, messageId), eq(examples.status, 'captured')));
  return kept?.text == null
    ? null
    : { text: openPart(db, accountId, messageId, 'text', kept.text)!, html: openPart(db, accountId, messageId, 'html', kept.html) };
}

/** The HTML of one of the scope's messages, as sift holds it; null when it holds none. */
export async function storedHtml(db: Sql, scope: Scope, messageId: string): Promise<string | null> {
  const accountId = await mailboxOf(db, scope, messageId);
  if (accountId === null) return null;
  return plain((await storedBody(db, accountId, messageId))?.html ?? null);
}

/** Whether sift can leave the list a message came from. Mirrors what `unsubscribe` in src/actions will agree to. */
async function canUnsubscribe(db: Sql, accountId: string, sender: string, headers: Record<string, string>): Promise<MessageDetail['unsubscribe']> {
  const signals = bulkSignals(headers);
  if (!signals.hasListUnsubscribe) return 'none';
  if ((await unsubscribedAt(db, accountId, sender)) !== null) return 'done';
  return signals.oneClickUnsubscribeUrl && passedDmarc(headers) ? 'available' : 'manual';
}
