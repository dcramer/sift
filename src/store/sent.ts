import type { Sql } from './sql.ts';
import { recordKept } from './kept.ts';
import { envelopeOf } from '../triage/features.ts';

/**
 * Keep mail the person sent from Sift, so its conversation shows it: a record in `messages` with Gmail's labels for it,
 * decided already (it is theirs, not mail to triage), and what they wrote in `mail_bodies`. `headers` are the headers it
 * went with, names lowercased. Only while Inbox is on (`recordKept`). Safe to repeat.
 */
export async function recordSent(
  db: Sql,
  accountId: string,
  sent: { id: string; threadId: string; labelIds: readonly string[]; headers: Record<string, string>; text: string; at: number },
): Promise<void> {
  const envelope = envelopeOf(sent.headers);
  if (!envelope) throw new Error('A sent message has no usable From');
  const facts = {
    accountId,
    messageId: sent.id,
    threadId: sent.threadId,
    ...envelope,
    labelIds: [...sent.labelIds],
    headers: sent.headers,
    receivedAt: sent.at,
  };
  const words = sent.text.trim() === '' ? 0 : sent.text.trim().split(/\s+/).length;
  await recordKept(db, accountId, { facts, text: { text: sent.text, html: null, read: { hasAttachments: false, words } } }, sent.at);
}
