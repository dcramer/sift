import { and, eq, exists, inArray, isNull, lt, mailBodies, mailCopies, mailboxes, messages, not, sql } from './query.ts';
import type { Sql } from './sql.ts';
import { type MailWindow, windowStart } from '../mail-window.ts';

/** Earlier is wider; null is all of it. */
const wider = (a: number | null, b: number | null) => (a === null ? b !== null : b !== null && a < b);

export interface MailCopy {
  accountId: string;
  since: number | null;
  before: number;
  pageToken: string | null;
  done: number;
  total: number;
  startedAt: number;
}

const COLUMNS = {
  accountId: mailCopies.accountId,
  since: mailCopies.since,
  before: mailCopies.before,
  pageToken: mailCopies.pageToken,
  done: mailCopies.done,
  total: mailCopies.total,
  startedAt: mailCopies.startedAt,
};

/** Copy these mailboxes from `since` to `before`, starting the listing again where one is already under way or done. */
export async function startCopies(db: Sql, accountIds: readonly string[], copy: { since: number | null; before: number; now: number }): Promise<void> {
  if (accountIds.length === 0) return;
  const fresh = { since: copy.since, before: copy.before, pageToken: null, done: 0, total: 0, startedAt: copy.now, finishedAt: null };
  await db
    .insert(mailCopies)
    .values(accountIds.map((accountId) => ({ accountId, ...fresh })))
    .onConflictDoUpdate({ target: [mailCopies.userId, mailCopies.accountId], set: fresh });
}

/** The copies still going, every mailbox's. */
export async function goingCopies(db: Sql): Promise<MailCopy[]> {
  return await db.select(COLUMNS).from(mailCopies).where(isNull(mailCopies.finishedAt));
}

/** Whether Inbox holds all of this mailbox's mail in its window: it is on, and its copy has reached the start of the window. */
export async function copied(db: Sql, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ one: sql`1` })
    .from(mailCopies)
    .where(and(eq(mailCopies.accountId, accountId), not(isNull(mailCopies.finishedAt))));
  return row !== undefined;
}

export async function goingCopy(db: Sql, accountId: string): Promise<MailCopy | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(mailCopies)
    .where(and(eq(mailCopies.accountId, accountId), isNull(mailCopies.finishedAt)));
  return row ?? null;
}

/**
 * A page of the listing is recorded: count it and move to the next, or finish at the end. Nothing is written when the copy
 * was started again or stopped meanwhile (`startedAt` changed, or the row went with Inbox).
 */
export async function advanceCopy(db: Sql, copy: MailCopy, page: { listed: number; next: string | null; estimate: number }, now: number): Promise<void> {
  await db
    .update(mailCopies)
    .set({
      done: copy.done + page.listed,
      total: copy.pageToken === null ? Math.max(page.estimate, page.listed) : copy.total,
      pageToken: page.next,
      finishedAt: page.next === null ? now : null,
    })
    .where(and(eq(mailCopies.accountId, copy.accountId), eq(mailCopies.startedAt, copy.startedAt), isNull(mailCopies.finishedAt)));
}

export interface CopyProgress {
  /** Copying these mailboxes now, all of them together. */
  going: { done: number; total: number; startedAt: number } | null;
}

export async function copyProgress(db: Sql, accountIds: readonly string[]): Promise<CopyProgress> {
  if (accountIds.length === 0) return { going: null };
  const going = await db
    .select(COLUMNS)
    .from(mailCopies)
    .where(and(inArray(mailCopies.accountId, [...accountIds]), isNull(mailCopies.finishedAt)));
  if (going.length === 0) return { going: null };
  return {
    going: {
      done: going.reduce((n, c) => n + c.done, 0),
      total: going.reduce((n, c) => n + Math.max(c.total, c.done), 0),
      startedAt: Math.min(...going.map((c) => c.startedAt)),
    },
  };
}

/**
 * Inbox's window moves from `from` to `to`. Wider, every mailbox copies what it adds, the copy under way going on to the new
 * start; narrower, a copy under way stops at the new start, and the text of mail received before it and not in the inbox
 * goes now. The records go with retention's next pass (`pruneOld`). In the caller's transaction.
 */
export async function moveWindow(db: Sql, from: MailWindow, to: MailWindow, now: number): Promise<void> {
  const was = windowStart(from, now);
  const since = windowStart(to, now);
  const restart = { since, pageToken: null, done: 0, total: 0, startedAt: now };
  const going = await goingCopies(db);
  if (wider(since, was)) {
    for (const copy of going) await db.update(mailCopies).set(restart).where(eq(mailCopies.accountId, copy.accountId));
    const all = await db.select({ id: mailboxes.id }).from(mailboxes);
    const rest = all.map((m) => m.id).filter((id) => !going.some((c) => c.accountId === id));
    // Narrower than all of it, so it began somewhere.
    await startCopies(db, rest, { since, before: was!, now });
    return;
  }
  if (since === null || was === since) return;
  for (const copy of going)
    await db
      .update(mailCopies)
      .set(since >= copy.before ? { finishedAt: now } : restart)
      .where(eq(mailCopies.accountId, copy.accountId));
  await dropTextBefore(db, since);
}

/** Delete Inbox's text of mail received before `since` that is not in the inbox. */
export async function dropTextBefore(db: Sql, since: number): Promise<void> {
  await db.delete(mailBodies).where(
    exists(
      db
        .select({ one: sql`1` })
        .from(messages)
        .where(
          and(
            eq(messages.accountId, mailBodies.accountId),
            eq(messages.id, mailBodies.messageId),
            lt(messages.receivedAt, since),
            not(sql`${messages.labelIds} @> '["INBOX"]'::jsonb`),
          ),
        ),
    ),
  );
}
