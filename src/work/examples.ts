import { and, asc, eq, examples } from '../store/query.ts';
import type { Sql } from '../store/sql.ts';
import { sealPart } from '../store/content.ts';
import { heldText, neverRead } from '../store/kept.ts';
import { type Reader, contentOf } from './bodies.ts';

const PER_PASS = 50;

const pending = (db: Sql, accountId: string, limit: number) =>
  db
    .select({ messageId: examples.messageId })
    .from(examples)
    .where(and(eq(examples.accountId, accountId), eq(examples.status, 'pending')))
    .orderBy(asc(examples.markedAt), asc(examples.messageId))
    .limit(limit);

/** Whether `captureExamples` has a marked message to store. */
export const examplesDue = async (db: Sql, accountId: string): Promise<boolean> => (await pending(db, accountId, 1)).length > 0;

/**
 * Store the text and HTML of messages the user has marked with their answer, as evaluation and training data: what Sift holds
 * of each, or for one it has never read, one read through `reader`, which keeps it. One read before whose text Sift no longer holds (read more
 * than `READ_KEEP_DAYS` ago), or that no longer exists, keeps the answer alone (`gone`) rather than reading Gmail again. A failed
 * read leaves the example pending for the next pass. Returns how many were captured.
 */
export async function captureExamples(db: Sql, reader: Reader, accountId: string): Promise<number> {
  let captured = 0;
  for (const { messageId } of await pending(db, accountId, PER_PASS)) {
    const example = and(eq(examples.accountId, accountId), eq(examples.messageId, messageId));
    const held = await heldText(db, accountId, messageId);
    const content = held ? contentOf(held) : (await neverRead(db, accountId, [messageId])).length > 0 ? await reader.getContent(messageId) : null;
    if (content === null) {
      await db.update(examples).set({ status: 'gone' }).where(example);
      continue;
    }
    await db
      .update(examples)
      .set({
        status: 'captured',
        bodyText: sealPart(db, accountId, messageId, 'text', content.text),
        bodyHtml: sealPart(db, accountId, messageId, 'html', content.html),
      })
      .where(example);
    captured++;
  }
  return captured;
}
