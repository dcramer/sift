import { and, desc, eq, mailBodies, messages, notExists, preferences, sql } from '../store/query.ts';
import type { Sql } from '../store/sql.ts';
import type { GmailApi } from '../gmail/api.ts';
import { pendingSuggestions } from '../learn/feedback.ts';
import { READ_KEEP_DAYS, type Text, heldText, keepRead, keepText, neverRead } from '../store/kept.ts';
import { type MessageContent, heldContent } from '../gmail/body.ts';

const PER_PASS = 50;

/** What Inbox keeps of a message read whole. One that has gone is kept empty, so it is not asked for again. */
export const textOf = (content: MessageContent | null): Text => ({
  text: content?.whole ?? content?.text ?? '',
  html: content?.html ?? null,
  read: content?.facts ?? { hasAttachments: false },
});

/** Text Sift holds as a read of the message gives it; null for one kept empty, which had gone. */
export const contentOf = (held: Text): MessageContent | null => (held.text === '' && held.html === null ? null : heldContent(held.text, held.html, held.read));

/** Reads a message's text, from what Sift holds before Gmail. */
export type Reader = Pick<GmailApi, 'getContent'>;

/**
 * Gmail's text of a message, read at most once: from what Sift holds of it (`heldText`), and otherwise from Gmail, kept as it is
 * read, in Inbox's copy while Inbox is on and for `READ_KEEP_DAYS` otherwise, before anything uses it. The model, the text kept of
 * waiting mail, Inbox and the examples all read through one, so a message is read from Gmail once whichever asks first, in this
 * pass or a later one. A read that failed is asked for again. Remembers only for the pass.
 */
export function readingOnce(db: Sql, accountId: string, api: Reader, now: () => number = Date.now): Reader {
  const reads = new Map<string, Promise<MessageContent | null>>();
  const fromGmail = async (messageId: string) => {
    const content = await api.getContent(messageId);
    const text = textOf(content);
    if (!(await keepText(db, accountId, messageId, text, now()))) await keepRead(db, accountId, messageId, text, now());
    return content;
  };
  const read = async (messageId: string) => {
    const held = await heldText(db, accountId, messageId);
    return held ? contentOf(held) : await fromGmail(messageId);
  };
  return {
    getContent: (messageId) => {
      let reading = reads.get(messageId);
      if (!reading) {
        reading = read(messageId);
        reads.set(messageId, reading);
        reading.catch(() => reads.delete(messageId));
      }
      return reading;
    },
  };
}

/** Waiting mail Sift would move or could not place whose text it has never read, newest first. Bounded: a mailbox's suggestions go back a year. */
async function unreadWaiting(db: Sql, accountId: string, now: number): Promise<string[]> {
  const since = now - READ_KEEP_DAYS * 86_400_000;
  const waiting = (await pendingSuggestions(db, { accountId, since })).filter((s) => s.disposition !== 'keep').map((s) => s.messageId);
  const unread = new Set(await neverRead(db, accountId, waiting));
  return waiting.filter((id) => unread.has(id));
}

/** Whether `keepWaitingText` has text to read. */
export async function bodiesDue(db: Sql, accountId: string, now: number): Promise<boolean> {
  return (await unreadWaiting(db, accountId, now)).length > 0;
}

/**
 * Read the text of mail waiting on the person that Sift would move or could not place and has never read (a rule decided
 * it), up to `PER_PASS`, through `reader`, which keeps it. Mail it would simply keep is not read. A failed read is tried again
 * on the next pass. Returns how many were read.
 */
export async function keepWaitingText(db: Sql, reader: Reader, accountId: string, now: () => number = Date.now): Promise<number> {
  const unread = (await unreadWaiting(db, accountId, now())).slice(0, PER_PASS);
  for (const messageId of unread) await reader.getContent(messageId);
  return unread.length;
}

/** Inbox mail Sift has a record of and no text for, newest first. `messages_inbox` serves it. */
const textless = (db: Sql, accountId: string, limit: number) =>
  db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        sql`${messages.labelIds} @> '["INBOX"]'::jsonb`,
        notExists(
          db
            .select({ one: sql`1` })
            .from(mailBodies)
            .where(and(eq(mailBodies.accountId, messages.accountId), eq(mailBodies.messageId, messages.id))),
        ),
      ),
    )
    .orderBy(desc(messages.receivedAt))
    .limit(limit);

export const inboxOn = async (db: Sql) => (await db.select({ mail: preferences.mail }).from(preferences))[0]?.mail === true;

/** Whether `keepMailBodies` has text to keep: Inbox is on and some inbox mail has none. */
export async function mailBodiesDue(db: Sql, accountId: string): Promise<boolean> {
  return (await inboxOn(db)) && (await textless(db, accountId, 1)).length > 0;
}

/**
 * While Inbox is on, keep the whole text and HTML of the mail in the inbox, `PER_PASS` a pass, newest first, through `reader`:
 * what Sift read with Inbox off is moved from what it held, and only the rest is read from Gmail. A message that has gone is
 * kept empty, so it is not asked for again. Returns how many it kept.
 */
export async function keepMailBodies(db: Sql, reader: Reader, accountId: string, now: () => number = Date.now): Promise<number> {
  if (!(await inboxOn(db))) return 0;
  let kept = 0;
  for (const { id: messageId } of await textless(db, accountId, PER_PASS)) {
    if (!(await keepText(db, accountId, messageId, textOf(await reader.getContent(messageId)), now()))) break;
    kept++;
  }
  return kept;
}
