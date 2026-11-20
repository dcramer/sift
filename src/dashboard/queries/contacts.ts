import {
  alias,
  and,
  asc,
  count,
  correspondents,
  decisions,
  desc,
  eq,
  feedback,
  inArray,
  isNull,
  labels,
  mailboxes,
  max,
  messages,
  notInArray,
  or,
  sql,
} from '../../store/query.ts';
import type { Sql } from '../../store/sql.ts';
import { hashOf, openEnvelope } from '../../store/content.ts';
import { contactOf } from '../../store/senders.ts';
import { LEAVE_IN_INBOX } from '../../triage/types.ts';
import type { Given } from '../../triage/standing.ts';
import { type Scope, within } from '../scope.ts';
import type { ContactPage, NextMail, RuleSummary } from '../types.ts';
import { listRuleSummaries } from './rules.ts';
import { DAY_MS } from './decisions.ts';
import { plain } from '../../plain.ts';

type Rule = Pick<RuleSummary, 'id' | 'match' | 'kind' | 'labelId' | 'labelName' | 'disposition' | 'when'>;

/** A rule for all of someone's mail, not some of it (under one name, say). */
const forAll = (rule: Rule) => Object.keys(rule.match).length === 1;

/** The one address or domain a rule for all their mail names, when it names only one. */
const named = (rule: Rule): { from: string } | { fromDomain: string } | null => {
  if (!forAll(rule)) return null;
  const [from, ...others] = plain(rule.match.from ?? []);
  if (from !== undefined && others.length === 0) return { from };
  const [domain, ...more] = plain(rule.match.fromDomain ?? []);
  return domain !== undefined && more.length === 0 ? { fromDomain: domain } : null;
};

/** A rule for exactly them, and nobody else. */
export const forExactly = (rule: Rule, who: { address: string } | { domain: string }) => {
  const one = named(rule);
  return one !== null && ('address' in who ? 'from' in one && one.from === who.address : 'fromDomain' in one && one.fromDomain === who.domain);
};

/** The rule that decides their next message, of those `about` them: one for exactly them wins over one for their domain. */
export const decidingRule = (about: readonly Rule[], exactly: (rule: Rule) => boolean): Rule | null => about.find(exactly) ?? about.find(forAll) ?? null;

const STANDS: Record<string, Given> = { keep: 'trusted', archive: 'unwanted', spam: 'blocked', block: 'blocked' };

/**
 * The standing their own rule gives them: one for exactly them that says only what happens to their mail (an action, or
 * Leave in inbox). A label rule that happens to archive is not one.
 */
export const givenBy = (rule: Rule | null): Given | null =>
  rule && rule.when === null && (rule.kind === 'action' || rule.labelId === LEAVE_IN_INBOX) ? (STANDS[rule.disposition ?? 'keep'] ?? null) : null;

/** What their current decisions say, one kind (a label, or none) at a time: how many, the newest, and what the newest of them does. */
export interface Kind {
  labelId: string | null;
  labelName: string | null;
  messages: number;
  lastAt: number;
  does: string;
}

/**
 * What their next message gets. A rule for all their mail says it. Otherwise their mail does, as it stands now, the
 * reader's answers included: what most of it is when it is of several kinds (`usually`), else what the newest is.
 */
export const nextOf = (rule: Rule | null, kinds: readonly Kind[]): NextMail => {
  if (rule !== null && rule.kind !== 'when-label')
    return { labelId: rule.labelId, labelName: rule.labelName, disposition: rule.disposition ?? 'keep', usually: false, ruleId: rule.id };
  const labelled = kinds.filter((k) => k.labelId !== null).toSorted((a, b) => b.messages - a.messages || b.lastAt - a.lastAt);
  const [most] = labelled;
  if (most && labelled.length > 1) return { labelId: most.labelId, labelName: most.labelName, disposition: most.does, usually: true, ruleId: null };
  const [newest] = kinds.toSorted((a, b) => b.lastAt - a.lastAt);
  return newest
    ? { labelId: newest.labelId, labelName: newest.labelName, disposition: newest.does, usually: false, ruleId: null }
    : { labelId: null, labelName: null, disposition: 'review', usually: false, ruleId: null };
};

const later = alias(decisions, 'later');

/**
 * Each sender's (or domain's, by `column`) mail by what its current decision says, or the reader's answer to it, which
 * beats the decision, for the hashes given. A label since removed is left out: their history has it, but no mail is given it again.
 */
export async function kindsOf(
  db: Sql,
  scope: Scope,
  column: typeof messages.senderHash | typeof messages.domainHash,
  hashes: readonly string[],
): Promise<Map<string, Kind[]>> {
  if (hashes.length === 0) return new Map();
  const answered = sql`${feedback.id} IS NOT NULL`;
  const labelId = sql<string | null>`CASE WHEN ${answered} THEN ${feedback.labelId} ELSE ${decisions.labelId} END`;
  const does = sql`CASE WHEN ${answered} THEN ${feedback.disposition} WHEN ${decisions.block} THEN 'block' WHEN ${decisions.digest} THEN 'digest' ELSE ${decisions.disposition} END`;
  const rows = await db
    .select({
      hash: sql<string>`${column}`,
      labelId,
      labelName: labels.name,
      messages: count(),
      lastAt: max(messages.receivedAt),
      does: sql<string>`(array_agg(${does} ORDER BY ${messages.receivedAt} DESC, ${decisions.id} DESC))[1]`,
    })
    .from(decisions)
    .innerJoin(messages, and(eq(messages.accountId, decisions.accountId), eq(messages.id, decisions.messageId)))
    .leftJoin(feedback, eq(feedback.decisionId, decisions.id))
    .leftJoin(labels, eq(labels.id, labelId))
    .where(
      and(
        within(scope, decisions.accountId),
        inArray(column, [...hashes]),
        or(isNull(labelId), isNull(labels.removedAt)),
        eq(
          decisions.id,
          db
            .select({ id: max(later.id) })
            .from(later)
            .where(and(eq(later.accountId, decisions.accountId), eq(later.messageId, decisions.messageId))),
        ),
      ),
    )
    .groupBy(column, labelId, labels.name);
  const kinds = new Map<string, Kind[]>();
  for (const { hash, lastAt, ...kind } of rows) kinds.set(hash, [...(kinds.get(hash) ?? []), { ...kind, lastAt: lastAt ?? 0 }]);
  return kinds;
}

interface ContactFilter {
  /** Case-insensitive part of their name or address. Reads the newest message of everyone the rest of the filter leaves. */
  search?: string;
  standing?: Given;
  know?: 'new' | 'mutual' | 'one-way';
  limit: number;
  offset: number;
}

const MONTH_MS = 30 * DAY_MS;

/**
 * Everyone the person has mail from in the scope's mailboxes, newest first, with what Sift does with their next mail,
 * where they stand and how they and the person know each other. Senders are found only by keyed hash, so a rule is
 * matched to them by hashing what it names, and a name or address is read only for the page shown, or for everyone
 * when searching. Mail the person sent from Sift, which is recorded too, is theirs and not a contact's.
 */
export async function listContacts(db: Sql, scope: Scope, filter: ContactFilter, now: number): Promise<ContactPage> {
  if (scope.accounts.length === 0) return { total: 0, rows: [] };
  const own = (await db.select({ id: mailboxes.id, aliases: mailboxes.aliases }).from(mailboxes)).flatMap((m) =>
    [m.id, ...m.aliases].map((a) => hashOf(db, a)),
  );
  const senders = await db
    .select({
      hash: messages.senderHash,
      domain: max(messages.domainHash),
      messages: count(),
      lastAt: max(messages.receivedAt),
      recent: sql<number>`count(*) FILTER (WHERE ${messages.receivedAt} >= ${now - MONTH_MS})`.mapWith(Number),
    })
    .from(messages)
    .where(and(within(scope, messages.accountId), own.length > 0 ? notInArray(messages.senderHash, own) : undefined))
    .groupBy(messages.senderHash)
    .orderBy(desc(max(messages.receivedAt)), asc(messages.senderHash));
  const written = new Map(
    (
      await db
        .select({ hash: correspondents.addressHash, yes: sql<boolean | null>`bool_or(${correspondents.userHasWritten})` })
        .from(correspondents)
        .where(within(scope, correspondents.accountId))
        .groupBy(correspondents.addressHash)
    ).map((r) => [r.hash, r.yes] as const),
  );
  const rules = (await listRuleSummaries(db, scope, now)).map((rule) => {
    const one = named(rule);
    return {
      rule,
      from: new Set(plain(rule.match.from ?? []).map((a) => hashOf(db, a))),
      domains: new Set(plain(rule.match.fromDomain ?? []).map((d) => hashOf(db, d))),
      exactly: one && 'from' in one ? hashOf(db, one.from) : null,
    };
  });

  const people = senders
    .map((s) => {
      const about = rules.filter((r) => r.from.has(s.hash) || (s.domain !== null && r.domains.has(s.domain)));
      const exactly = about.find((r) => r.exactly === s.hash)?.rule ?? null;
      const rule = exactly ?? about.find((r) => forAll(r.rule))?.rule ?? null;
      return {
        ...s,
        lastAt: s.lastAt ?? 0,
        rule,
        rules: about.length,
        given: givenBy(exactly),
        contact: contactOf(s.messages, written.get(s.hash) ?? null),
      };
    })
    .filter((p) => (filter.standing === undefined || p.given === filter.standing) && (filter.know === undefined || p.contact === filter.know));

  // The newest message of each, which is where their name and address are.
  const envelopes = async (some: typeof people) => {
    if (some.length === 0) return new Map<string, ReturnType<typeof openEnvelope<{ headers: string }>>>();
    const newest = new Map(some.map((p) => [p.hash, p.lastAt]));
    const rows = await db
      .select({ hash: messages.senderHash, accountId: messages.accountId, id: messages.id, headers: messages.headers, receivedAt: messages.receivedAt })
      .from(messages)
      .where(
        and(within(scope, messages.accountId), inArray(messages.senderHash, [...newest.keys()]), inArray(messages.receivedAt, [...new Set(newest.values())])),
      );
    const opened = new Map<string, ReturnType<typeof openEnvelope<{ headers: string }>>>();
    for (const row of rows)
      if (!opened.has(row.hash) && newest.get(row.hash) === row.receivedAt)
        opened.set(row.hash, openEnvelope(db, row.accountId, row.id, { headers: row.headers }));
    return opened;
  };

  const term = filter.search?.trim().toLowerCase();
  let total = people.length;
  let shown = people.slice(filter.offset, filter.offset + filter.limit);
  let read: Awaited<ReturnType<typeof envelopes>>;
  if (term) {
    read = await envelopes(people);
    const found = people.filter((p) => {
      const envelope = read.get(p.hash);
      return envelope !== undefined && [envelope.fromAddress, envelope.fromName].some((s) => plain(s)?.toLowerCase().includes(term));
    });
    total = found.length;
    shown = found.slice(filter.offset, filter.offset + filter.limit);
  } else read = await envelopes(shown);

  const kinds = await kindsOf(
    db,
    scope,
    messages.senderHash,
    shown.map((p) => p.hash),
  );
  return {
    total,
    rows: shown.flatMap((p) => {
      const envelope = read.get(p.hash);
      if (!envelope) return [];
      return [
        {
          address: envelope.fromAddress,
          name: envelope.fromName,
          contact: p.contact,
          given: p.given,
          rules: p.rules,
          next: nextOf(p.rule, kinds.get(p.hash) ?? []),
          recent: p.recent,
          lastSeenAt: p.lastAt,
        },
      ];
    }),
  };
}
