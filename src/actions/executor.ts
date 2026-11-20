import { and, eq, messages } from '../store/query.ts';
import type { Sql } from '../store/sql.ts';
import { openEnvelope, traceIds } from '../store/content.ts';
import {
  type ActionPayload,
  type ActionRecord,
  type ActionType,
  type LabelChange,
  finishAction,
  getAction,
  insertPendingAction,
  listOpenActions,
  setActionStatus,
} from '../store/actions.ts';
import type { Mailbox } from './mailbox.ts';
import { Refusal } from '../refusal.ts';
import { traced } from '../telemetry.ts';
import { plain } from '../plain.ts';

export interface MessageAction {
  /** `label` leaves the message where it is; `archive` and `spam` take it out of the inbox. */
  type: 'label' | 'archive' | 'spam';
  /** Gmail labels to add, by name: what the mail is. */
  labels?: string[];
  /** Also mark the message read. Not for spam. */
  markRead?: boolean;
}

/**
 * What sift did, as a second Gmail label beside the one for what the mail is. Applied here to every
 * archived or spammed message whatever the caller passes, so anything sift moved can be found in Gmail itself.
 */
const AUDIT_LABELS = { archive: 'sift/did/archived', spam: 'sift/did/spam' } as const;

export type Outcome =
  | { status: 'done'; actionId: number; finalLabels: string[] }
  /** Nothing was attempted. No audit row is written. */
  | { status: 'skipped'; reason: string }
  /** `failed`: the change did not happen. `unknown`: the provider call errored and the result could not be read back. */
  | { status: 'failed' | 'unknown'; actionId: number; reason: string };

export interface ActionDeps {
  db: Sql;
  mailbox: Mailbox;
  now?: () => number;
}

const clock = (deps: ActionDeps) => (deps.now ?? Date.now)();
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const applied = (labels: string[], change: LabelChange) => change.add.every((l) => labels.includes(l)) && !change.remove.some((l) => labels.includes(l));

type Target = { accountId: string; messageId: string; type: ActionType; undoOf?: number; decisionId?: number };

/** The single path for changing a message, as a span of its own. */
const applyChange = (deps: ActionDeps, target: Target, current: string[], requested: LabelChange): Promise<Outcome> =>
  traced('sift.action', target.type, { ...traceIds(deps.db, target.messageId), 'sift.decision_id': target.decisionId }, async (span) => {
    const outcome = await changeLabels(deps, target, current, requested);
    span.set({ 'sift.status': outcome.status, ...(outcome.status === 'skipped' ? {} : { 'sift.action_id': outcome.actionId }) });
    if (outcome.status === 'failed' || outcome.status === 'unknown') span.fail();
    return outcome;
  });

/**
 * Write intent, change, read back, record the outcome. Only the part of `change` that differs from
 * `current` is sent, so unrelated labels and unread state are untouched.
 */
async function changeLabels(deps: ActionDeps, target: Target, current: string[], requested: LabelChange): Promise<Outcome> {
  const change: LabelChange = {
    add: requested.add.filter((l) => !current.includes(l)),
    remove: requested.remove.filter((l) => current.includes(l)),
  };
  if (change.add.length === 0 && change.remove.length === 0) return { status: 'skipped', reason: 'already in the requested state' };

  const payload: ActionPayload = { ...change, ...(target.undoOf === undefined ? {} : { undoOf: target.undoOf }) };
  const actionId = await insertPendingAction(
    deps.db,
    {
      accountId: target.accountId,
      messageId: target.messageId,
      type: target.type,
      payload,
      originalLabels: current,
      ...(target.decisionId === undefined ? {} : { decisionId: target.decisionId }),
    },
    clock(deps),
  );

  let finalLabels: string[];
  try {
    // Gmail answers the change with the message's labels after it, so they are not read again.
    finalLabels = await deps.mailbox.modifyLabels(target.messageId, change);
  } catch (error) {
    // The call may or may not have landed. Leave it open; reconcile() settles it from the mailbox's actual state.
    await finishAction(deps.db, actionId, 'unknown', null, message(error), clock(deps));
    return { status: 'unknown', actionId, reason: message(error) };
  }

  if (applied(finalLabels, change)) {
    await finishAction(deps.db, actionId, 'done', finalLabels, null, clock(deps));
    return { status: 'done', actionId, finalLabels };
  }
  const reason = 'the labels Gmail gave back did not match the change';
  await finishAction(deps.db, actionId, 'failed', finalLabels, reason, clock(deps));
  return { status: 'failed', actionId, reason };
}

/** An unsubscribe already `unknown` stays so: no mailbox can say whether it took. */
const settles = (action: ActionRecord) => !(action.type === 'unsubscribe' && action.status === 'unknown');

/** Whether `reconcile` has a change in this mailbox to settle. */
export const reconcileDue = async (db: Sql, accountId: string): Promise<boolean> => (await listOpenActions(db, { accountId })).some(settles);

/**
 * Settle actions whose outcome was never confirmed (a crash or a provider error mid-change) by reading
 * the mailbox. A label change on one message is atomic, so it either fully applied or did not happen.
 * Never replays the change. Returns how many actions were settled.
 *
 * An unsubscribe changes no label, so the mailbox cannot say whether it took: one cut short is `unknown`,
 * which leaves the sender to be tried again, and never `done`, which would leave them alone for good.
 */
export async function reconcile(deps: ActionDeps, scope?: { accountId: string; messageId?: string }): Promise<number> {
  let settled = 0;
  for (const action of (await listOpenActions(deps.db, scope)).filter(settles)) {
    if (action.type === 'unsubscribe') {
      await finishAction(deps.db, action.id, 'unknown', null, 'Sift stopped before the answer was recorded', clock(deps));
      settled++;
      continue;
    }
    const labels = await deps.mailbox.getLabelIds(action.messageId);
    if (labels === null) await finishAction(deps.db, action.id, 'failed', null, 'message no longer exists', clock(deps));
    else if (applied(labels, action.payload)) await finishAction(deps.db, action.id, 'done', labels, null, clock(deps));
    else await finishAction(deps.db, action.id, 'failed', labels, action.error ?? 'change was not applied', clock(deps));
    settled++;
  }
  return settled;
}

/**
 * Apply one triage action to one message. Only messages currently in the inbox are changed.
 * Pass `decisionId` when the action carries out a recorded decision, so the two are linked in the audit log.
 */
export async function execute(deps: ActionDeps, accountId: string, messageId: string, action: MessageAction, decisionId?: number): Promise<Outcome> {
  await reconcile(deps, { accountId, messageId });

  const current = await deps.mailbox.getLabelIds(messageId);
  if (current === null) return { status: 'skipped', reason: 'message no longer exists' };
  if (!current.includes('INBOX')) return { status: 'skipped', reason: 'message is not in the inbox' };

  if (action.type === 'spam') {
    const refusal = await spamRefusal(deps, accountId, messageId);
    if (refusal) return { status: 'skipped', reason: refusal };
  }
  const names = [...(action.labels ?? []), ...(action.type === 'label' ? [] : [AUDIT_LABELS[action.type]])];
  const add: string[] = [];
  for (const name of new Set(names)) add.push(await deps.mailbox.ensureLabel(name));
  const read = action.markRead && action.type !== 'spam' ? ['UNREAD'] : [];
  const change: LabelChange =
    action.type === 'label' ? { add, remove: read } : { add: [...add, ...(action.type === 'spam' ? ['SPAM'] : [])], remove: ['INBOX', ...read] };

  return await applyChange(deps, { accountId, messageId, type: action.type, ...(decisionId === undefined ? {} : { decisionId }) }, current, change);
}

/** What the person can do to mail in their inbox from Inbox, and the change in Gmail each is. */
const PRESSES = {
  archive: { add: [], remove: ['INBOX'] },
  read: { add: [], remove: ['UNREAD'] },
  unread: { add: ['UNREAD'], remove: [] },
} as const satisfies Record<string, LabelChange>;
export type Press = keyof typeof PRESSES;

/**
 * The person's own press on one message, carried out whether Sift is on or not, as an answer is. Only a message in the
 * inbox now is changed; nothing is added for what Sift did, since Sift did not decide it. With the outcome, the
 * message's labels as Gmail last said them, for the record; null when it no longer exists.
 */
export async function press(deps: ActionDeps, accountId: string, messageId: string, what: Press): Promise<{ outcome: Outcome; labels: string[] | null }> {
  await reconcile(deps, { accountId, messageId });
  const current = await deps.mailbox.getLabelIds(messageId);
  if (current === null) return { outcome: { status: 'skipped', reason: 'message no longer exists' }, labels: null };
  if (!current.includes('INBOX')) return { outcome: { status: 'skipped', reason: 'message is not in the inbox' }, labels: current };
  const { add, remove } = PRESSES[what];
  const outcome = await applyChange(deps, { accountId, messageId, type: what }, current, { add: [...add], remove: [...remove] });
  return { outcome, labels: outcome.status === 'done' ? outcome.finalLabels : current };
}

/** Spam is the costliest mistake, so every doubt refuses: unknown sender, failed lookup, or any prior correspondence. */
async function spamRefusal(deps: ActionDeps, accountId: string, messageId: string): Promise<string | null> {
  const [row] = await deps.db
    .select({ headers: messages.headers })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
  if (!row) return 'sender is unknown, so spam is refused';
  try {
    if (await deps.mailbox.hasSentTo(plain(openEnvelope(deps.db, accountId, messageId, row).fromAddress)))
      return 'you have written to this sender, so spam is refused';
  } catch (error) {
    return `could not check correspondence with the sender (${message(error)}), so spam is refused`;
  }
  return null;
}

/**
 * Reverse a completed action exactly: remove what it added, restore what it removed. Labels the user
 * has changed since are left as they are. The undo is itself an audited action.
 */
export async function undo(deps: ActionDeps, actionId: number): Promise<Outcome> {
  const action: ActionRecord | null = await getAction(deps.db, actionId);
  if (!action) throw new Refusal(`There is no change #${actionId}.`);
  if (action.type === 'undo') throw new Refusal(`Change #${actionId} is itself an undo.`);
  if (action.type === 'filter' || action.type === 'unfilter') throw new Refusal('A Gmail filter is added or taken out from its rule, not undone.');
  if (action.type === 'digest') throw new Refusal('A digest is a message of its own in your inbox. Archive it there.');
  if (action.type === 'send') throw new Refusal('Mail once sent cannot be taken back.');
  if (action.type === 'unsubscribe') throw new Refusal('An unsubscribe cannot be undone from here. Subscribe again with the sender.');
  if (action.status !== 'done') throw new Refusal(`Change #${actionId} is ${action.status}; only completed changes can be undone.`);

  const current = await deps.mailbox.getLabelIds(action.messageId);
  if (current === null) throw new Refusal('The message no longer exists.');
  if (current.includes('TRASH')) throw new Refusal('The message is in the trash; restore it in Gmail first.');

  const outcome = await applyChange(deps, { accountId: action.accountId, messageId: action.messageId, type: 'undo', undoOf: action.id }, current, {
    add: action.payload.remove,
    remove: action.payload.add,
  });
  // 'skipped' means the user already put everything back by hand.
  if (outcome.status === 'done' || outcome.status === 'skipped') await setActionStatus(deps.db, action.id, 'undone');
  return outcome;
}
