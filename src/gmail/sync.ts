import { envelopeOf } from '../triage/features.ts';
import type { MessageFacts } from '../triage/types.ts';
import { type GmailApi, HistoryExpiredError, type HistoryLabelChange, type RawMessage } from './api.ts';

export interface PullResult {
  /** Ids of messages that arrived in the inbox since the cursor, oldest first, deduplicated. */
  messageIds: string[];
  /**
   * Label changes to any message since the cursor, sift's own among them. Empty after `recovery`: what
   * changed while the cursor was expired cannot be read back.
   */
  labelChanges: HistoryLabelChange[];
  /**
   * Messages history named without listing them as added to the inbox, that may have been: named by a record
   * without saying what happened to them, or put in the inbox. Sync records those that are new to it and arrived
   * since it last looked.
   */
  strays: string[];
  /**
   * Mail added anywhere but the inbox since the cursor, and mail that gained `SENT`: what the person sent from Gmail or a
   * phone, what a filter moved past the inbox. Not Spam, Trash, drafts or chats (`NOT_MAIL`). Inbox records it.
   */
  elsewhere: string[];
  /** Messages deleted for good since the cursor. */
  deleted: string[];
  /** Store this as the new cursor, in the same transaction that records the messages. */
  historyId: string;
  /** How the ids were found. `recovery` means the cursor had expired and a bounded search was used instead. */
  mode: 'start' | 'incremental' | 'recovery';
}

/** Labels of what is not mail to keep: what the person threw out, Gmail's spam, drafts that change with every keystroke, and chats. */
export const NOT_MAIL = ['SPAM', 'TRASH', 'DRAFT', 'CHAT'];
const isMail = (labelIds: readonly string[]) => !labelIds.some((label) => NOT_MAIL.includes(label));

/** How far back to search when the cursor has expired. Gmail keeps history for about a week. */
const RECOVERY_DAYS = 7;

/**
 * Find messages added to the inbox since `cursor`.
 *
 * With no cursor this only records the current position: sift handles mail that arrives after it
 * is connected and never sweeps the existing inbox on its own.
 */
export async function pullChanges(api: GmailApi, cursor: string | null): Promise<PullResult> {
  if (cursor === null) {
    const profile = await api.getProfile();
    return { messageIds: [], labelChanges: [], strays: [], elsewhere: [], deleted: [], historyId: profile.historyId, mode: 'start' };
  }

  try {
    const ids = new Set<string>();
    const labelChanges: HistoryLabelChange[] = [];
    const strays = new Set<string>();
    const elsewhere = new Set<string>();
    const deleted = new Set<string>();
    let historyId = cursor;
    let pageToken: string | undefined;
    do {
      const page = await api.listHistory(cursor, pageToken);
      // A message can be added outside the inbox (sent, filtered) and still appear; keep only inbox arrivals.
      for (const added of page.additions) {
        if (added.labelIds.includes('INBOX')) ids.add(added.id);
        else if (isMail(added.labelIds)) elsewhere.add(added.id);
      }
      labelChanges.push(...(page.labelChanges ?? []));
      for (const id of page.unexplained ?? []) strays.add(id);
      for (const id of page.deleted ?? []) deleted.add(id);
      for (const change of page.labelChanges ?? []) {
        if (change.added.includes('INBOX')) strays.add(change.messageId);
        if (change.added.includes('SENT')) elsewhere.add(change.messageId);
      }
      historyId = page.historyId;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return {
      messageIds: [...ids],
      labelChanges,
      strays: [...strays].filter((id) => !ids.has(id)),
      elsewhere: [...elsewhere].filter((id) => !ids.has(id) && !strays.has(id)),
      deleted: [...deleted],
      historyId,
      mode: 'incremental',
    };
  } catch (error) {
    if (!(error instanceof HistoryExpiredError)) throw error;
  }

  // Read the new cursor before searching, so anything arriving during the search is seen again next time.
  const profile = await api.getProfile();
  const ids = new Set<string>();
  let pageToken: string | undefined;
  do {
    const page = await api.searchInbox(`newer_than:${RECOVERY_DAYS}d`, pageToken);
    for (const id of page.ids) ids.add(id);
    pageToken = page.nextPageToken;
  } while (pageToken);
  // Search returns newest first.
  return { messageIds: [...ids].toReversed(), labelChanges: [], strays: [], elsewhere: [], deleted: [], historyId: profile.historyId, mode: 'recovery' };
}

/** Convert Gmail metadata to triage input. Null when there is no usable From address. */
export function toFacts(accountId: string, raw: RawMessage): MessageFacts | null {
  const headers: Record<string, string> = {};
  // Keep the first occurrence: for repeated trace headers such as Authentication-Results, the topmost is the receiver's own.
  for (const { name, value } of raw.headers) headers[name.toLowerCase()] ??= value;

  const envelope = envelopeOf(headers);
  if (!envelope) return null;

  return {
    accountId,
    messageId: raw.id,
    threadId: raw.threadId,
    ...envelope,
    labelIds: raw.labelIds,
    headers,
    receivedAt: raw.internalDate,
  };
}
