import { finishAction, insertPendingAction, openTries } from '../store/actions.ts';
import type { Sql } from '../store/sql.ts';
import type { Mailbox } from './mailbox.ts';

/** Sift's own Gmail label on every digest, so they are found together. `digest` is a name no label of the person's may take. */
const DIGEST_LABEL = 'sift/digest';

type PutDeps = { db: Sql; mailbox: Mailbox; now?: () => number };
type Put = { id: number; accountId: string; messageId: string };

/**
 * Put a digest into its mailbox, as new unread mail in the inbox, and return Gmail's id for it. Written to the audit log
 * before the call and settled from Gmail's answer. A try before this one whose answer never came is looked for by the
 * digest's Message-ID first, so one that landed is not put in twice. With no `raw`, only that earlier try is settled:
 * null when none landed.
 */
export async function putDigest(deps: PutDeps, digest: Put, raw: string): Promise<string>;
export async function putDigest(deps: PutDeps, digest: Put, raw: null): Promise<string | null>;
export async function putDigest(deps: PutDeps, digest: Put, raw: string | null): Promise<string | null> {
  const { db, mailbox } = deps;
  const now = deps.now ?? Date.now;
  const earlier = await openTries(db, 'digest', (payload) => payload.digest === digest.id);
  if (earlier.length > 0) {
    const found = await mailbox.findByMessageId(digest.messageId);
    for (const { id } of earlier) await finishAction(db, id, found ? 'done' : 'failed', null, found ? null : 'not in Gmail', now());
    if (found) return found.id;
  }
  if (raw === null) return null;
  const labelIds = ['INBOX', 'UNREAD', await mailbox.ensureLabel(DIGEST_LABEL)];
  const actionId = await insertPendingAction(
    db,
    { accountId: digest.accountId, messageId: null, type: 'digest', payload: { add: labelIds, remove: [], digest: digest.id }, originalLabels: [] },
    now(),
  );
  try {
    const put = await mailbox.insertMessage(raw, labelIds);
    await finishAction(db, actionId, 'done', put.labelIds, null, now());
    return put.id;
  } catch (error) {
    // It may have landed with its answer lost; the next try looks for it before putting it in again.
    await finishAction(db, actionId, 'unknown', null, error instanceof Error ? error.message : String(error), now());
    throw error;
  }
}
