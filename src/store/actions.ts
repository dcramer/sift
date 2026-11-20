import { type ACTION_STATUSES, type ACTION_TYPES, actions, and, asc, desc, eq, inArray, isNotNull, max, messages, min, notInArray } from './query.ts';
import type { Sql } from './sql.ts';
import { actionName, hashOf, openJson, sealJson } from './content.ts';
import { plain } from '../plain.ts';

type ActionStatus = (typeof ACTION_STATUSES)[number];
export type ActionType = (typeof ACTION_TYPES)[number];

/** The label change an action made (or tried to make), as provider label ids. */
export interface LabelChange {
  add: string[];
  remove: string[];
}

export interface ActionPayload extends LabelChange {
  /** For `undo` actions, the id of the action being reversed. */
  undoOf?: number;
  /** For `unsubscribe` actions, which changes no label: the host the request went to. */
  unsubscribe?: string;
  /** For `filter` and `unfilter` actions, which change no message: the rule, and the Gmail filter written for it or taken out. */
  filter?: { ruleId: string; id?: string; criteria?: Record<string, unknown>; action?: Record<string, unknown> };
  /** For `digest` actions, which put a message Sift wrote into the mailbox: the digest. */
  digest?: number;
  /** For `send` actions, which change no message: the mail sent, by its Message-ID, and to whom. */
  send?: { messageId: string; to: string[]; cc: string[]; subject: string };
}

export interface ActionRecord {
  id: number;
  accountId: string;
  messageId: string;
  type: ActionType;
  payload: ActionPayload;
  originalLabels: string[];
  finalLabels: string[] | null;
  status: ActionStatus;
  error: string | null;
  createdAt: number;
}

const COLUMNS = {
  id: actions.id,
  accountId: actions.accountId,
  messageId: actions.messageId,
  type: actions.type,
  payload: actions.payload,
  originalLabels: actions.originalLabels,
  finalLabels: actions.finalLabels,
  status: actions.status,
  error: actions.error,
  createdAt: actions.createdAt,
};

/** A change's details as stored: they can name a sender (an unsubscribe's host, a filter's criteria). */
export const openPayload = (db: Sql, accountId: string, stored: string): ActionPayload => plain(openJson<ActionPayload>(db, actionName(db, accountId), stored));

const fromRow =
  (db: Sql) =>
  ({
    messageId,
    payload,
    ...r
  }: {
    id: number;
    accountId: string;
    messageId: string | null;
    type: ActionType;
    payload: string;
    originalLabels: string[];
    finalLabels: string[] | null;
    status: ActionStatus;
    error: string | null;
    createdAt: number;
  }): ActionRecord => ({ ...r, messageId: messageId!, payload: openPayload(db, r.accountId, payload) });

/** Write the intent before touching the provider. Returns the action id. */
export async function insertPendingAction(
  db: Sql,
  action: { accountId: string; messageId: string | null; type: ActionType; payload: ActionPayload; originalLabels: string[]; decisionId?: number },
  now: number,
): Promise<number> {
  const [row] = await db
    .insert(actions)
    .values({
      accountId: action.accountId,
      messageId: action.messageId,
      type: action.type,
      payload: sealJson(db, actionName(db, action.accountId), action.payload),
      originalLabels: action.originalLabels,
      decisionId: action.decisionId ?? null,
      status: 'pending',
      createdAt: now,
    })
    .returning({ id: actions.id });
  return row!.id;
}

export async function finishAction(db: Sql, id: number, status: ActionStatus, finalLabels: string[] | null, error: string | null, now: number): Promise<void> {
  await db.update(actions).set({ status, finalLabels, error, completedAt: now }).where(eq(actions.id, id));
}

/** How many times a decision's change was sent to Gmail, and whether one of those landed. */
export async function changeTries(db: Sql, decisionId: number): Promise<{ tries: number; landed: boolean }> {
  const rows = await db.select({ status: actions.status }).from(actions).where(eq(actions.decisionId, decisionId));
  return { tries: rows.length, landed: rows.some((r) => r.status === 'done') };
}

export async function setActionStatus(db: Sql, id: number, status: ActionStatus): Promise<void> {
  await db.update(actions).set({ status }).where(eq(actions.id, id));
}

export async function getAction(db: Sql, id: number): Promise<ActionRecord | null> {
  const [row] = await db.select(COLUMNS).from(actions).where(eq(actions.id, id));
  return row ? fromRow(db)(row) : null;
}

/** The last thing sift did to a message's labels that still stands, or null. What the person pressed in Inbox is theirs, carrying out no decision. */
export async function lastStandingChange(db: Sql, accountId: string, messageId: string): Promise<ActionRecord | null> {
  const [row] = await db
    .select(COLUMNS)
    .from(actions)
    .where(
      and(
        eq(actions.accountId, accountId),
        eq(actions.messageId, messageId),
        notInArray(actions.type, ['undo', 'unsubscribe']),
        eq(actions.status, 'done'),
        isNotNull(actions.decisionId),
      ),
    )
    .orderBy(desc(actions.id))
    .limit(1);
  return row ? fromRow(db)(row) : null;
}

/** Actions whose outcome was never confirmed, oldest first. Optionally limited to one message. */
export async function listOpenActions(db: Sql, scope?: { accountId: string; messageId?: string }): Promise<ActionRecord[]> {
  const rows = await db
    .select(COLUMNS)
    .from(actions)
    .where(
      and(
        inArray(actions.status, ['pending', 'unknown']),
        isNotNull(actions.messageId),
        scope ? and(eq(actions.accountId, scope.accountId), scope.messageId === undefined ? undefined : eq(actions.messageId, scope.messageId)) : undefined,
      ),
    )
    .orderBy(asc(actions.id));
  return rows.map(fromRow(db));
}

/** When the user unsubscribed from this sender through sift, or null. */
export async function unsubscribedAt(db: Sql, accountId: string, sender: string): Promise<number | null> {
  const [row] = await db
    .select({ at: min(actions.createdAt) })
    .from(actions)
    .innerJoin(messages, and(eq(messages.accountId, actions.accountId), eq(messages.id, actions.messageId)))
    .where(and(eq(actions.accountId, accountId), eq(actions.type, 'unsubscribe'), eq(actions.status, 'done'), eq(messages.senderHash, hashOf(db, sender))));
  return row!.at;
}

/** When an unsubscribe request to this sender last failed or was cut short, or null. */
export async function lastUnsubscribeFailure(db: Sql, accountId: string, sender: string): Promise<number | null> {
  const [row] = await db
    .select({ at: max(actions.createdAt) })
    .from(actions)
    .innerJoin(messages, and(eq(messages.accountId, actions.accountId), eq(messages.id, actions.messageId)))
    .where(
      and(
        eq(actions.accountId, accountId),
        eq(actions.type, 'unsubscribe'),
        inArray(actions.status, ['failed', 'unknown']),
        eq(messages.senderHash, hashOf(db, sender)),
      ),
    );
  return row!.at;
}

/**
 * Tries at putting in a digest or sending mail whose outcome was never confirmed, of the one `which` picks out: `pending`
 * while its call has not answered, `unknown` once it failed without saying whether it landed. `at` is its latest word.
 */
export async function openTries(
  db: Sql,
  type: 'digest' | 'send',
  which: (payload: ActionPayload) => boolean,
): Promise<{ id: number; status: 'pending' | 'unknown'; at: number }[]> {
  const rows = await db
    .select({
      id: actions.id,
      accountId: actions.accountId,
      payload: actions.payload,
      status: actions.status,
      createdAt: actions.createdAt,
      completedAt: actions.completedAt,
    })
    .from(actions)
    .where(and(eq(actions.type, type), inArray(actions.status, ['pending', 'unknown'])));
  return rows
    .filter((r) => which(openPayload(db, r.accountId, r.payload)))
    .map((r) => ({ id: r.id, status: r.status === 'pending' ? 'pending' : 'unknown', at: r.completedAt ?? r.createdAt }));
}
