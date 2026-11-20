import { alias, and, asc, count, decisions, desc, eq, isNotNull, max, messages, ne, or } from '../../store/query.ts';
import { hashOf, newestOfGroup, openEnvelope, openNewest } from '../../store/content.ts';
import type { Sql } from '../../store/sql.ts';
import { contacts, domainFacts, senderFacts } from '../../store/senders.ts';
import { labelNames } from '../../store/labels.ts';
import { plainName } from '../../triage/stages/rules.ts';
import { type Scope, within } from '../scope.ts';
import type { SenderPage, SenderProfile } from '../types.ts';
import { listDecisions } from './decisions.ts';
import { listRuleSummaries } from './rules.ts';
import { keptOut, saved } from './saved.ts';
import { decidingRule, forExactly, givenBy, kindsOf, nextOf } from './contacts.ts';
import { plain, seal } from '../../plain.ts';

const later = alias(decisions, 'later');

/** How much of an address's mail the names are read from. Each name is in its message's encrypted headers, so each is opened in Sift. */
const NAMES_FROM = 2_000;

/**
 * The names an address sends under, most mail first, each with what its mail currently is; empty unless it
 * uses two or more. Names alike but for case and spacing are one, shown as most recently written. And the
 * newest of them, which is what the address is called.
 */
async function namesOf(
  db: Sql,
  scope: Scope,
  address: string,
  labelNames: ReadonlyMap<string, string>,
): Promise<{ names: SenderPage['names']; newest: string | null }> {
  const rows = await db
    .select({ accountId: messages.accountId, id: messages.id, headers: messages.headers, receivedAt: messages.receivedAt })
    .from(messages)
    .where(and(within(scope, messages.accountId), eq(messages.senderHash, hashOf(db, address))))
    .orderBy(desc(messages.receivedAt))
    .limit(NAMES_FROM);
  const decided = await db
    .select({ accountId: decisions.accountId, messageId: decisions.messageId, labelId: decisions.labelId, disposition: decisions.disposition })
    .from(decisions)
    .innerJoin(messages, and(eq(messages.accountId, decisions.accountId), eq(messages.id, decisions.messageId)))
    .where(
      and(
        within(scope, decisions.accountId),
        eq(messages.senderHash, hashOf(db, address)),
        or(isNotNull(decisions.labelId), ne(decisions.disposition, 'review')),
        eq(
          decisions.id,
          db
            .select({ id: max(later.id) })
            .from(later)
            .where(and(eq(later.accountId, decisions.accountId), eq(later.messageId, decisions.messageId))),
        ),
      ),
    );
  const decisionOf = new Map(decided.map((r) => [`${r.accountId}\n${r.messageId}`, r]));
  const names = new Map<string, { name: string | null; messages: number; lastSeenAt: number; labels: Map<string, number>; actions: Map<string, number> }>();
  let newest: string | null = null;
  for (const row of rows) {
    const name = plain(openEnvelope(db, row.accountId, row.id, row).fromName)?.trim() || null;
    newest ??= name;
    const key = name === null ? '' : plainName(name);
    const entry = names.get(key) ?? { name, messages: 0, lastSeenAt: row.receivedAt, labels: new Map<string, number>(), actions: new Map<string, number>() };
    entry.messages++;
    const decision = decisionOf.get(`${row.accountId}\n${row.id}`);
    const add = (tally: Map<string, number>, id: string) => tally.set(id, (tally.get(id) ?? 0) + 1);
    if (decision?.labelId) add(entry.labels, decision.labelId);
    // A rule that only says what happens gives no label: its mail is placed by that action, not undecided.
    else if (decision) add(entry.actions, decision.disposition);
    names.set(key, entry);
  }
  if ([...names.values()].filter((n) => n.name !== null).length < 2) return { names: [], newest };
  return {
    names: [...names.values()]
      .toSorted((a, b) => b.messages - a.messages || b.lastSeenAt - a.lastSeenAt)
      .map(({ labels, actions, name, ...n }) => ({
        ...n,
        name: seal(name),
        labels: [...labels].toSorted(([, a], [, b]) => b - a).map(([id, messages]) => ({ id, name: labelNames.get(id) ?? id, messages })),
        actions: [...actions].toSorted(([, a], [, b]) => b - a).map(([action, messages]) => ({ action, messages })),
      })),
    newest,
  };
}

/** What sift knows about one sender, from all of the person's mailboxes. */
async function profileOf(db: Sql, scope: Scope, who: { address: string } | { domain: string }, now: number): Promise<SenderProfile | null> {
  const known = 'address' in who ? await senderFacts(db, scope.accounts, who.address, now) : await domainFacts(db, scope.accounts, who.domain, now);
  if (!known) return null;
  const names = await labelNames(db);
  const domainName = 'address' in who ? (who.address.split('@')[1] ?? '') : who.domain;
  const ofDomain = 'address' in who ? await domainFacts(db, scope.accounts, domainName, now) : null;
  const rules = (await listRuleSummaries(db, scope, now))
    .filter((r) =>
      'address' in who
        ? plain(r.match.from ?? []).includes(who.address) || plain(r.match.fromDomain ?? []).includes(domainName)
        : plain(r.match.fromDomain ?? []).includes(domainName) || plain(r.match.from ?? []).some((a) => a.endsWith(`@${domainName}`)),
    )
    .map((r) => ({
      id: r.id,
      match: r.match,
      name: r.name,
      labelId: r.labelId,
      labelName: r.labelName,
      disposition: r.disposition,
      source: r.source,
      kind: r.kind,
      when: r.when,
    }));
  return {
    address: seal('address' in who ? who.address : who.domain),
    contact: known.contact,
    given: givenBy(rules.find((r) => forExactly(r, who)) ?? null),
    messages: known.messages,
    firstSeenAt: known.firstSeenAt,
    lastSeenAt: known.lastSeenAt,
    recent: known.recent,
    saved: saved(
      (
        await keptOut(db, scope, 0, {
          where: eq('address' in who ? messages.senderHash : messages.domainHash, hashOf(db, 'address' in who ? who.address : who.domain)),
        })
      ).length,
    ),
    senders: known.senders,
    answers: known.answers,
    userHasWritten: known.userHasWritten,
    labels: known.labels.map((l) => ({ id: l.id, name: names.get(l.id) ?? l.id, messages: l.messages })),
    domain: ofDomain ? { name: seal(domainName), contact: ofDomain.contact } : null,
    rules,
  };
}

/** What sift knows about a sender, the rules that apply to them and where they stand. */
export async function senderProfile(db: Sql, scope: Scope, address: string, now: number = Date.now()): Promise<SenderProfile | null> {
  return await profileOf(db, scope, { address }, now);
}

/** How many of a sender's newest messages are listed on their page. */
const LISTED = 50;

/**
 * A sender's page, or a domain's. Null for a domain anyone can get an address at, and for one the person has
 * neither mail from nor a rule about, which would only say back what was asked. `under` narrows the mail
 * listed to what came under that name, read from as far back as the names are.
 */
export async function senderPage(
  db: Sql,
  scope: Scope,
  who: { address: string } | { domain: string },
  now: number = Date.now(),
  under?: string,
): Promise<SenderPage | null> {
  const profile = await profileOf(db, scope, who, now);
  if (!profile || (profile.messages === 0 && profile.rules.length === 0)) return null;
  const filter = 'address' in who ? { sender: who.address } : { domain: who.domain };
  const hash = hashOf(db, 'address' in who ? who.address : who.domain);
  // A rule for one of a domain's senders does not decide what the domain's next mail gets.
  const deciding = decidingRule('address' in who ? profile.rules : profile.rules.filter((r) => plain(r.match.fromDomain ?? []).includes(who.domain)), (r) =>
    forExactly(r, who),
  );
  const kinds = await kindsOf(db, scope, 'address' in who ? messages.senderHash : messages.domainHash, [hash]);
  const named = 'address' in who ? await namesOf(db, scope, who.address, await labelNames(db)) : null;
  const writing =
    'domain' in who
      ? (
          await db
            .select({
              newest: newestOfGroup(),
              messages: count(),
              lastSeenAt: max(messages.receivedAt),
            })
            .from(messages)
            .where(and(within(scope, messages.accountId), eq(messages.domainHash, hashOf(db, who.domain))))
            .groupBy(messages.senderHash)
            .orderBy(desc(count()), asc(messages.senderHash))
            .limit(100)
        ).map(({ newest, ...s }) => {
          const { fromAddress, fromName } = openNewest(db, newest);
          return { address: fromAddress, ...s, name: fromName };
        })
      : [];
  const known = await contacts(
    db,
    scope.accounts,
    writing.map((s) => plain(s.address)),
  );
  const senders = writing.map((s) => ({ ...s, lastSeenAt: s.lastSeenAt!, contact: known.get(plain(s.address)) ?? null }));
  return {
    kind: 'address' in who ? 'sender' : 'domain',
    name: seal(named?.newest ?? null),
    profile,
    next: nextOf(deciding, kinds.get(hash) ?? []),
    names: named?.names ?? [],
    senders,
    decisions:
      under === undefined
        ? (await listDecisions(db, scope, { days: 36_500, limit: LISTED, ...filter }, now)).rows
        : (await listDecisions(db, scope, { days: 36_500, limit: NAMES_FROM, ...filter }, now)).rows
            .filter((row) => plainName(plain(row.fromName) ?? '') === plainName(under))
            .slice(0, LISTED),
  };
}
