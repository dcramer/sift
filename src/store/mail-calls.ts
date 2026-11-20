import type { MailAnswer } from '../triage/mail-ask.ts';
import type { Usage } from '../triage/stages/model.ts';
import { askName, sealJson } from './content.ts';
import { eq, mailAsks } from './query.ts';
import type { Sql } from './sql.ts';

const cost = (usage: Usage | undefined) => (usage ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd } : {});

/** Record an Ask before the model is called. */
export async function startAsk(db: Sql, request: { accountId: string; words: string; model: string; now: number }): Promise<number> {
  const [row] = await db
    .insert(mailAsks)
    .values({
      accountId: request.accountId,
      startedAt: request.now,
      model: request.model,
      words: sealJson(db, askName(db, request.accountId, 'words'), request.words),
    })
    .returning({ id: mailAsks.id });
  return row!.id;
}

export async function finishAsk(
  db: Sql,
  accountId: string,
  id: number,
  outcome: ({ answer: MailAnswer } | { error: string }) & { usage?: Usage; lookups: number; now: number },
): Promise<void> {
  await db
    .update(mailAsks)
    .set({
      finishedAt: outcome.now,
      lookups: outcome.lookups,
      ...('answer' in outcome ? { answer: sealJson(db, askName(db, accountId, 'answer'), outcome.answer) } : { error: outcome.error }),
      ...cost(outcome.usage),
    })
    .where(eq(mailAsks.id, id));
}
