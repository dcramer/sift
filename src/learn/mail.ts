import { Refusal } from '../refusal.ts';
import { listLabels } from '../store/labels.ts';
import { finishAsk, startAsk } from '../store/mail-calls.ts';
import type { Sql } from '../store/sql.ts';
import { invokeAgent, reportError } from '../telemetry.ts';
import type { MailAnswer, MailAsker } from '../triage/mail-ask.ts';
import { senderLookup } from './rules.ts';

/**
 * Ask the model to turn the person's words into a filter on Inbox's list, looking up their senders as it needs,
 * recorded before the call and with what it cost, under `accountId`. Nothing is narrowed here: the page shows the filter.
 * Rejects when the call failed.
 */
export async function askMail(
  deps: { db: Sql; ask: MailAsker; model: string; now?: () => number },
  request: { accountId: string; words: string; today: string },
): Promise<MailAnswer> {
  const { db } = deps;
  const now = deps.now ?? Date.now;
  const id = await startAsk(db, { accountId: request.accountId, words: request.words, model: deps.model, now: now() });
  const labels = await listLabels(db);
  const find = senderLookup(db);
  const answer = await invokeAgent('ask', [db.person, id], { 'sift.ask': id }, async () => {
    try {
      return await deps.ask({ words: request.words, today: request.today, labels }, find);
    } catch (error) {
      await finishAsk(db, request.accountId, id, { error: error instanceof Error ? error.message : String(error), lookups: 0, now: now() });
      throw error;
    }
  });
  const { usage, lookups, ...said } = answer;
  const spent = { lookups, ...(usage ? { usage } : {}), now: now() };
  if ('failed' in said) {
    await finishAsk(db, request.accountId, id, { error: said.failed, ...spent });
    reportError(new Error(`Asking failed: ${said.failed}`));
    throw new Refusal(`The model could not make a filter (${said.failed}). Try again, or use Filters.`);
  }
  await finishAsk(db, request.accountId, id, { answer: said, ...spent });
  return said;
}
