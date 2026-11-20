import { alias, and, count, decisions, eq, inArray, isNotNull, mailBodies, max, messages as messageRows, not, readBodies } from '../../store/query.ts';
import { noDecision } from '../../store/messages.ts';
import { goingInboxRuns } from '../../store/inbox.ts';
import { outOfTries } from '../../store/runs.ts';
import type { Sql } from '../../store/sql.ts';
import { accuracy, pendingSuggestions } from '../../learn/feedback.ts';
import { listLabels } from '../../store/labels.ts';
import { preferences } from '../../store/preferences.ts';
import { hashOf, openPart } from '../../store/content.ts';
import type { Label } from '../../triage/types.ts';
import { listProposals } from '../../store/proposals.ts';
import { contacts } from '../../store/senders.ts';
import { type Scope, sees, within } from '../scope.ts';
import { FACT_FILTERS, type FactFilter, type SuggestionDetail, type SuggestionItem, type Suggestions } from '../types.ts';
import { outcomeOf } from './labels.ts';
import { plain, seal } from '../../plain.ts';
import type { Confidential } from '../../confidential.ts';

/** One sender's waiting mail, in all of the person's mailboxes, newest first. */
export async function suggestionDetail(db: Sql, scope: Scope, sender: string): Promise<SuggestionDetail> {
  const messages = (await pendingSuggestions(db, { accounts: scope.accounts, sender, limit: 200 })).map((s) => ({
    accountId: s.accountId,
    decisionId: s.decisionId,
    messageId: s.messageId,
    subject: s.subject,
    receivedAt: s.receivedAt,
    labelId: s.labelId,
  }));
  return { messages };
}

const MAX_ITEMS = 500;

/**
 * Sift is going through the inbox, or mail it found there only to suggest about waits for the model. Each
 * becomes a suggestion on a later pass, unless the model keeps failing on it.
 */
async function pulledInWaiting(db: Sql, scope: Scope): Promise<boolean> {
  if ((await goingInboxRuns(db)).some((run) => sees(scope, run.accountId))) return true;
  const [row] = await db
    .select({ id: messageRows.id })
    .from(messageRows)
    .where(
      and(within(scope, messageRows.accountId), eq(messageRows.suggestOnly, true), noDecision(db), not(outOfTries(db, messageRows.accountId, messageRows.id))),
    )
    .limit(1);
  return row !== undefined;
}

export async function listSuggestions(db: Sql, scope: Scope, options: { includeKept?: boolean; fact?: FactFilter } = {}): Promise<Suggestions> {
  const labels = await listLabels(db);
  const names = new Map(labels.map((l) => [l.id, l.name] as const));
  const waitingNow = (await pendingSuggestions(db, { accounts: scope.accounts, ...(options.fact ? { facts: FACT_FILTERS[options.fact] } : {}) })).filter(
    (s) => options.includeKept || s.disposition !== 'keep',
  );
  // Newest mail first, as a mail app lists it, whenever Sift decided it.
  const shown = waitingNow.toSorted((a, b) => b.receivedAt - a.receivedAt || b.decisionId - a.decisionId).slice(0, MAX_ITEMS);
  // What each sender's mail has been labelled, by its current decision, to offer as other likely labels.
  const senders = new Map(
    shown.map((s) => {
      const key = `${s.accountId}\n${plain(s.fromAddress)}`;
      return [`${s.accountId}\n${hashOf(db, plain(s.fromAddress))}`, key] as const;
    }),
  );
  const later = alias(decisions, 'later');
  const labelled =
    senders.size === 0
      ? []
      : await db
          .select({ accountId: decisions.accountId, senderHash: messageRows.senderHash, labelId: decisions.labelId, n: count() })
          .from(decisions)
          .innerJoin(messageRows, and(eq(messageRows.accountId, decisions.accountId), eq(messageRows.id, decisions.messageId)))
          .where(
            and(
              within(scope, decisions.accountId),
              inArray(messageRows.senderHash, [...new Set([...senders.keys()].map((key) => key.split('\n')[1]!))]),
              isNotNull(decisions.labelId),
              eq(
                decisions.id,
                db
                  .select({ id: max(later.id) })
                  .from(later)
                  .where(and(eq(later.accountId, decisions.accountId), eq(later.messageId, decisions.messageId))),
              ),
            ),
          )
          .groupBy(decisions.accountId, messageRows.senderHash, decisions.labelId);
  const history = new Map<string, Map<string, number>>();
  for (const row of labelled) {
    const key = senders.get(`${row.accountId}\n${row.senderHash}`);
    if (!key) continue;
    const counts = history.get(key) ?? new Map<string, number>();
    counts.set(row.labelId!, row.n);
    history.set(key, counts);
  }
  const alternatives = (s: (typeof shown)[number]) => {
    const counts = history.get(`${s.accountId}\n${plain(s.fromAddress)}`) ?? new Map<string, number>();
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    return [...counts]
      .filter(([id]) => id !== s.labelId)
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 2)
      .flatMap(([id, n]) => {
        const name = names.get(id);
        return name ? [{ id, name, share: n / total }] : [];
      });
  };
  // The text Sift holds of what is shown: Inbox's copy, or what it read with Inbox off.
  const previews = new Map<string, Confidential>();
  const ids = [...new Set(shown.map((s) => s.messageId))];
  for (const table of ids.length === 0 ? [] : [readBodies, mailBodies])
    for (const r of await db
      .select({ accountId: table.accountId, messageId: table.messageId, text: table.bodyText })
      .from(table)
      .where(and(within(scope, table.accountId), inArray(table.messageId, ids))))
      previews.set(
        `${r.accountId}\n${r.messageId}`,
        seal(
          plain(openPart(db, r.accountId, r.messageId, 'text', r.text))!
            .slice(0, 400)
            .replace(/\s+/g, ' ')
            .trim(),
        ),
      );
  const known = await contacts(
    db,
    scope.accounts,
    shown.map((s) => plain(s.fromAddress)),
  );
  const items = shown.map((s): SuggestionItem => ({
    accountId: s.accountId,
    messageId: s.messageId,
    decisionId: s.decisionId,
    sender: s.fromAddress,
    senderName: s.fromName,
    contact: known.get(plain(s.fromAddress)) ?? null,
    subject: s.subject,
    receivedAt: s.receivedAt,
    disposition: s.block ? 'block' : s.digest ? 'digest' : s.disposition,
    labelId: s.labelId,
    labelName: (s.labelId && names.get(s.labelId)) ?? null,
    stage: s.stage,
    confidence: s.confidence,
    alternatives: alternatives(s),
    preview: previews.get(`${s.accountId}\n${s.messageId}`) || null,
  }));
  const { reviewed, right } = await accuracy(db, 0, scope.accounts);
  return {
    labels: labels.map((l) => ({ id: l.id, name: l.name, disposition: outcomeOf(l) })),
    proposals: await proposalSummaries(db, scope, labels),
    items,
    waiting: waitingNow.length,
    accuracy: { reviewed, right },
    active: (await preferences(db)).active,
    importing: await pulledInWaiting(db, scope),
  };
}

async function proposalSummaries(db: Sql, scope: Scope, labels: readonly Label[]): Promise<Suggestions['proposals']> {
  const summaries: Suggestions['proposals'] = [];
  for (const p of await listProposals(db)) {
    const label = labels.find((l) => l.id === p.labelId);
    // A proposal whose label has been removed has nothing to offer.
    if (!sees(scope, p.accountId) || !label) continue;
    summaries.push({
      id: p.id,
      accountId: p.accountId,
      match: p.match,
      labelId: p.labelId,
      labelName: label.name,
      disposition: p.disposition,
      labelDisposition: outcomeOf(label),
      agreed: p.agreed,
    });
  }
  return summaries;
}
