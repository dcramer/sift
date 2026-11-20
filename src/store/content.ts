import type { Confidential, Sealed } from '../confidential.ts';
import { seal as held } from '../plain.ts';
import { currentPrefix, keyedHash, openSecret, openToRekey, sealSecret, staleSecret } from '../secrets.ts';
import type { Facts } from '../triage/facts.ts';
import { envelopeOf, parseListId } from '../triage/features.ts';
import { nameKey, subjectPattern } from '../triage/fewshot.ts';
import type { Address, MessageFacts } from '../triage/types.ts';
import {
  actions,
  and,
  asc,
  correspondents,
  decisions,
  digests,
  eq,
  examples,
  gt,
  inArray,
  labelProposals,
  mailAsks,
  mailBodies,
  messages,
  notLike,
  or,
  proposals,
  ruleDrafts,
  ruleFilters,
  rules,
  sql,
  readBodies,
} from './query.ts';
import { type RuleMatch, tidyMatch } from '../triage/stages/rules.ts';
import { searchIndex } from './search.ts';
import type { Sql } from './sql.ts';

/** What Sift holds of a message that came from the message: its body, and the headers its record keeps. */
type Part = 'text' | 'html' | 'headers' | 'reason';

/** Each is encrypted for its person, message and part, so one copied into another row does not open. */
const nameOf = (db: Sql, accountId: string, messageId: string, part: Part) => `person ${db.person} ${part} of ${accountId} ${messageId}`;
export const ruleName = (db: Sql, ruleId: string, field: 'match' | 'except' | 'filter' | 'name') => `person ${db.person} rule ${ruleId} ${field}`;
export const proposalName = (db: Sql, accountId: string) => `person ${db.person} proposal of ${accountId}`;
export const actionName = (db: Sql, accountId: string) => `person ${db.person} action of ${accountId}`;
export const labelProposalName = (db: Sql, accountId: string, field: 'goal' | 'labels' | 'note') =>
  `person ${db.person} label proposal ${field} of ${accountId}`;
export const ruleDraftName = (db: Sql, accountId: string, field: 'goal' | 'rule') => `person ${db.person} rule draft ${field} of ${accountId}`;
export const askName = (db: Sql, accountId: string, field: 'words' | 'answer') => `person ${db.person} ask ${field} of ${accountId}`;
export const digestName = (db: Sql, id: number) => `person ${db.person} digest ${id} highlights`;

/**
 * Marks a value stored without a key. Content comes from whoever sent the mail, so a subject that only
 * looks like an encrypted value must not be taken for one.
 */
const PLAIN = 'sift-plain:';

const seal = (db: Sql, name: string, value: string) => (db.keys.current ? sealSecret(name, value, db.keys) : PLAIN + value);

function open(db: Sql, name: string, stored: string): string {
  if (!stored.startsWith(PLAIN)) return openSecret(name, stored, db.keys);
  if (db.keys.current) throw new Error(`${name} is stored unencrypted though SIFT_KEY is set.`);
  return stored.slice(PLAIN.length);
}

/** A part as it is stored: encrypted with the install's key (marked plain without one), and null when there is none. */
export function sealPart(db: Sql, accountId: string, messageId: string, part: Part, value: string | null): string | null {
  return value === null ? null : seal(db, nameOf(db, accountId, messageId, part), value);
}

const openText = (db: Sql, accountId: string, messageId: string, part: Part, stored: string | null): string | null =>
  stored === null ? null : open(db, nameOf(db, accountId, messageId, part), stored);

/** A stored part, decrypted. Refuses a plain one once there is a key, as `openSecret` does: every one was encrypted at start. */
export const openPart = (db: Sql, accountId: string, messageId: string, part: Part, stored: string | null): Confidential | null =>
  held(openText(db, accountId, messageId, part, stored));

/** JSON that names senders without being part of a message: a rule's or proposal's conditions, a change's details. */
export const sealJson = (db: Sql, name: string, value: unknown): string => seal(db, name, JSON.stringify(value));
export const openJson = <T>(db: Sql, name: string, stored: string): Sealed<T> => held(JSON.parse(open(db, name, stored)) as T);

/**
 * Key order does not matter, as it did not to `jsonb` equality; a missing key and an undefined one are the
 * same. Nor do the order and case of a condition's values, which are alternatives.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return JSON.stringify([...new Set(value.map((v) => v.toLowerCase()))].toSorted());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, v]) => v !== undefined);
  return `{${entries
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(',')}}`;
}

/** What finds a rule, or a proposal, with exactly these conditions: the keyed hash of them. */
export const conditionsHash = (db: Sql, match: RuleMatch, except: readonly RuleMatch[] = []): string =>
  hashOf(db, canonical([tidyMatch(match), except.map(tidyMatch)]));

/**
 * The keyed hash an address or domain is found by (src/secrets.ts). Equal values hash the same for one
 * person and differently for another; nothing else can be asked of it.
 */
export function hashOf(db: Sql, value: string): string {
  if (db.person === null) throw new Error('Only a person’s handle hashes what came from their mail.');
  return keyedHash(db.keys, db.person, value.toLowerCase());
}

/**
 * What a trace may say of a message (src/telemetry.ts): its id, sender and domain as the keyed hashes
 * `hashOf` gives, so a trace leads back to them only here, where `messages` is searched by the same
 * sender and domain hashes. Without a key `hashOf` is the value itself, so a trace then names none of them.
 */
export function traceIds(db: Sql, messageId: string, from?: Pick<Address, 'address' | 'domain'>): Record<string, string> {
  if (!db.keys.current) return {};
  return { 'sift.message': hashOf(db, messageId), ...(from ? { 'sift.sender': hashOf(db, from.address), 'sift.domain': hashOf(db, from.domain) } : {}) };
}

/** A cached correspondent as stored: only the hashes it is found by. A new key empties the cache (`rekeyMail`). */
export const hashCorrespondent = (db: Sql, address: string): { addressHash: string; domainHash: string } => ({
  addressHash: hashOf(db, address),
  domainHash: hashOf(db, address.slice(address.lastIndexOf('@') + 1)),
});

/** A message's record as `messages` stores it: its headers encrypted, and the hashes its sender is found by. */
export function sealMessage(db: Sql, accountId: string, messageId: string, message: Pick<MessageFacts, 'from' | 'headers'>) {
  return {
    headers: sealPart(db, accountId, messageId, 'headers', JSON.stringify(message.headers))!,
    senderHash: hashOf(db, message.from.address),
    domainHash: hashOf(db, message.from.domain),
  };
}

/** What an example is found by when the model judges mail like it (`examplesFor`): its sender's name and its kind of subject, hashed. */
export function exampleKeys(db: Sql, message: Pick<MessageFacts, 'from' | 'subject'>): { nameHash: string | null; subjectHash: string | null } {
  const name = nameKey(message.from);
  const pattern = subjectPattern(message.subject);
  return { nameHash: name === null ? null : hashOf(db, name), subjectHash: pattern === null ? null : hashOf(db, pattern) };
}

const keysOfStored = (db: Sql, accountId: string, messageId: string, headers: string) =>
  exampleKeys(db, envelopeOf(JSON.parse(openText(db, accountId, messageId, 'headers', headers)!) as Record<string, string>)!);

/** `exampleKeys` of a recorded message, for its example. */
export async function exampleKeysOf(db: Sql, accountId: string, messageId: string): Promise<ReturnType<typeof exampleKeys>> {
  const [row] = await db
    .select({ headers: messages.headers })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.id, messageId)));
  return keysOfStored(db, accountId, messageId, row!.headers);
}

/** Stands in for a list id in stored facts, which ask only whether there is one; `openFacts` puts it back from the headers. */
const LISTED = 'listed';

/** Facts as `messages` stores them: a list id says who sent the mail, so it is kept only as there being one. */
export const sealFacts = (facts: Facts): Facts => ({ ...facts, listId: facts.listId === null ? null : LISTED });

/** Stored facts with their list id, from the message's headers (decrypted). */
export const openFacts = (facts: Facts, headers: Record<string, string>): Facts => ({
  ...facts,
  listId: facts.listId === null ? null : parseListId(headers['list-id']),
});

/** What a message's record shows, read from its headers. */
interface Envelope {
  fromAddress: string;
  fromDomain: string;
  fromName: string | null;
  subject: string;
  to: Address[];
  cc: Address[];
  headers: Record<string, string>;
}

type Nullable<T> = { [K in keyof T]: T[K] | null };

/** A message missing from a left join reads as null throughout. */
const MISSING: Nullable<Envelope> = { fromAddress: null, fromDomain: null, fromName: null, subject: null, to: null, cc: null, headers: null };

function envelopeFrom(text: string | null): Envelope | Nullable<Envelope> {
  if (text === null) return MISSING;
  const headers = JSON.parse(text) as Record<string, string>;
  // Every message is recorded from headers with a usable From (`toFacts`).
  const { from, to, cc, subject } = envelopeOf(headers)!;
  return { fromAddress: from.address, fromDomain: from.domain, fromName: from.name ?? null, subject, to, cc, headers };
}

type Opened<R> = Omit<R, 'headers' | 'reason'> &
  (R extends { headers: infer H } ? (null extends H ? Nullable<Sealed<Envelope>> : Sealed<Envelope>) : unknown) &
  (R extends { reason: infer V } ? { reason: null extends V ? Confidential | null : Confidential } : unknown);

/**
 * `row` with what it read of a message decrypted: its `headers` as the envelope they say (sender, recipients,
 * subject, and the headers themselves), and a decision's `reason`. Its other columns as they are.
 */
export function openEnvelope<R extends { headers?: string | null; reason?: string | null }>(db: Sql, accountId: string, messageId: string, row: R): Opened<R> {
  const { headers, reason, ...rest } = row;
  const opened: Record<string, unknown> = rest;
  if ('reason' in row) opened['reason'] = openText(db, accountId, messageId, 'reason', reason ?? null);
  if ('headers' in row) Object.assign(opened, envelopeFrom(openText(db, accountId, messageId, 'headers', headers ?? null)));
  return opened as Opened<R>;
}

/**
 * For a query grouped by sender: the group's newest message, as `[account, message id, encrypted headers]`,
 * which `openNewest` reads. A sender is known only from a message's headers.
 */
export const newestOfGroup = () =>
  sql<
    [string, string, string]
  >`(array_agg(json_build_array(${messages.accountId}, ${messages.id}, ${messages.headers}) ORDER BY ${messages.receivedAt} DESC))[1]`.mapWith((v: unknown) =>
    typeof v === 'string' ? JSON.parse(v) : v,
  );

export const openNewest = (db: Sql, [accountId, messageId, headers]: [string, string, string]): Sealed<Envelope> =>
  held(envelopeFrom(openText(db, accountId, messageId, 'headers', headers)) as Envelope);

const forRekey = (db: Sql, accountId: string, messageId: string, part: Part, stored: string | null) =>
  stored === null ? null : reopen(db, nameOf(db, accountId, messageId, part), stored);

const reopen = (db: Sql, name: string, stored: string) => (stored.startsWith(PLAIN) ? stored.slice(PLAIN.length) : openToRekey(name, stored, db.keys));

const stale = (db: Sql, stored: string | null) => stored !== null && db.keys.current !== null && (stored.startsWith(PLAIN) || staleSecret(stored, db.keys));

/** Mail records are read this many at a time: a mailbox can have many thousands. */
const BATCH = 500;

/**
 * Bring everything `db` holds of its messages' content under the current key, as `rekeyCredentials` does
 * for sign-ins. Throws if one does not open with the handle's keys. `write: false` only checks. Returns
 * how many messages had something to bring under it.
 */
export async function rekeyContent(db: Sql, write = true): Promise<number> {
  const prefix = currentPrefix(db.keys);
  await rekeyConditions(db, prefix, write);
  let touched = 0;
  if (prefix !== null) {
    await rekeyLog(db, prefix, write);
    touched = await rekeyMail(db, prefix, write);
  }
  if (write) await keyExamples(db);
  return touched;
}

const UNSET = 'unset:';

/** A match stored before a condition held a list (migration 0029), with each value as a list of it. */
function asLists(stored: unknown): RuleMatch {
  const match = stored as Record<string, unknown>;
  return Object.fromEntries(Object.entries(match).map(([key, value]) => [key, typeof value === 'string' ? [value] : value])) as RuleMatch;
}

/**
 * Rules, proposals, label proposals, rule drafts, asks and digests: few, so read whole. Their conditions are hashed again with the key, and those a
 * migration could not hash (`unset:`) are hashed here even without one.
 */
async function rekeyConditions(db: Sql, prefix: string | null, write: boolean): Promise<void> {
  const behind = (stored: string | null) => stored !== null && prefix !== null && !stored.startsWith(prefix);
  const ruleRows = await db.select({ id: rules.id, match: rules.match, except: rules.except, name: rules.name, conditions: rules.conditions }).from(rules);
  const ruleUpdates = ruleRows
    .filter((r) => r.conditions.startsWith(UNSET) || behind(r.match) || behind(r.except) || behind(r.name))
    .map((r) => {
      const match = asLists(JSON.parse(reopen(db, ruleName(db, r.id, 'match'), r.match)));
      const except = (JSON.parse(reopen(db, ruleName(db, r.id, 'except'), r.except)) as unknown[]).map(asLists);
      const name = r.name === null ? null : reopen(db, ruleName(db, r.id, 'name'), r.name);
      return {
        id: r.id,
        set: {
          match: sealJson(db, ruleName(db, r.id, 'match'), match),
          except: sealJson(db, ruleName(db, r.id, 'except'), except),
          name: name === null ? null : seal(db, ruleName(db, r.id, 'name'), name),
          conditions: conditionsHash(db, match, except),
        },
      };
    });
  const filterUpdates = (await db.select({ ruleId: ruleFilters.ruleId, accountId: ruleFilters.accountId, written: ruleFilters.written }).from(ruleFilters))
    .filter((r) => behind(r.written))
    .map((r) => ({ ...r, written: seal(db, ruleName(db, r.ruleId, 'filter'), reopen(db, ruleName(db, r.ruleId, 'filter'), r.written!)) }));
  const proposalRows = await db
    .select({ id: proposals.id, accountId: proposals.accountId, match: proposals.match, conditions: proposals.conditions, status: proposals.status })
    .from(proposals)
    .orderBy(asc(proposals.id));
  const proposalUpdates = proposalRows
    .filter((r) => r.conditions.startsWith(UNSET) || behind(r.match))
    .map((r) => {
      const match = asLists(JSON.parse(reopen(db, proposalName(db, r.accountId), r.match)));
      return { id: r.id, set: { match: sealJson(db, proposalName(db, r.accountId), match), conditions: conditionsHash(db, match) } };
    });
  // Two proposals for the same mail hashed apart once (one made while a sender was still one value, before
  // 0029) hash alike now, which `proposals_once` refuses: the one the user answered stays, else the first.
  const hashed = new Map(proposalUpdates.map((u) => [u.id, u.set.conditions]));
  const kept = new Map<string, number>();
  const duplicates: number[] = [];
  for (const r of proposalRows.toSorted((a, b) => Number(a.status === 'open') - Number(b.status === 'open'))) {
    const key = `${r.accountId}\n${hashed.get(r.id) ?? r.conditions}`;
    if (kept.has(key)) duplicates.push(r.id);
    else kept.set(key, r.id);
  }
  const labelProposalRows = await db
    .select({ id: labelProposals.id, accountId: labelProposals.accountId, goal: labelProposals.goal, labels: labelProposals.labels, note: labelProposals.note })
    .from(labelProposals);
  const labelProposalUpdates = labelProposalRows
    .filter((r) => behind(r.goal) || behind(r.labels) || behind(r.note))
    .map((r) => {
      const again = (field: 'goal' | 'labels' | 'note', stored: string) =>
        seal(db, labelProposalName(db, r.accountId, field), reopen(db, labelProposalName(db, r.accountId, field), stored));
      return {
        id: r.id,
        set: {
          goal: again('goal', r.goal),
          labels: r.labels === null ? null : again('labels', r.labels),
          note: r.note === null ? null : again('note', r.note),
        },
      };
    });
  const draftRows = await db.select({ id: ruleDrafts.id, accountId: ruleDrafts.accountId, goal: ruleDrafts.goal, rule: ruleDrafts.rule }).from(ruleDrafts);
  const draftUpdates = draftRows
    .filter((r) => behind(r.goal) || behind(r.rule))
    .map((r) => {
      const again = (field: 'goal' | 'rule', stored: string) =>
        seal(db, ruleDraftName(db, r.accountId, field), reopen(db, ruleDraftName(db, r.accountId, field), stored));
      return { id: r.id, set: { goal: again('goal', r.goal), rule: r.rule === null ? null : again('rule', r.rule) } };
    });
  const askUpdates = (await db.select({ id: mailAsks.id, accountId: mailAsks.accountId, words: mailAsks.words, answer: mailAsks.answer }).from(mailAsks))
    .filter((r) => behind(r.words) || behind(r.answer))
    .map((r) => {
      const again = (field: 'words' | 'answer', stored: string) =>
        seal(db, askName(db, r.accountId, field), reopen(db, askName(db, r.accountId, field), stored));
      return { id: r.id, set: { words: again('words', r.words), answer: r.answer === null ? null : again('answer', r.answer) } };
    });
  const digestUpdates = (await db.select({ id: digests.id, highlights: digests.highlights }).from(digests))
    .filter((r) => behind(r.highlights))
    .map((r) => ({ id: r.id, highlights: seal(db, digestName(db, r.id), reopen(db, digestName(db, r.id), r.highlights!)) }));
  if (write)
    await db.transaction(async (tx) => {
      for (const { id, highlights } of digestUpdates) await tx.update(digests).set({ highlights }).where(eq(digests.id, id));
      for (const { id, set } of draftUpdates) await tx.update(ruleDrafts).set(set).where(eq(ruleDrafts.id, id));
      for (const { id, set } of askUpdates) await tx.update(mailAsks).set(set).where(eq(mailAsks.id, id));
      for (const { id, set } of ruleUpdates) await tx.update(rules).set(set).where(eq(rules.id, id));
      for (const { ruleId, accountId, written } of filterUpdates)
        await tx
          .update(ruleFilters)
          .set({ written })
          .where(and(eq(ruleFilters.ruleId, ruleId), eq(ruleFilters.accountId, accountId)));
      if (duplicates.length > 0) await tx.delete(proposals).where(inArray(proposals.id, duplicates));
      for (const { id, set } of proposalUpdates) if (!duplicates.includes(id)) await tx.update(proposals).set(set).where(eq(proposals.id, id));
      for (const { id, set } of labelProposalUpdates) await tx.update(labelProposals).set(set).where(eq(labelProposals.id, id));
    });
}

/** Changes made and decisions reached: one row each, so read in batches like mail records. */
async function rekeyLog(db: Sql, prefix: string, write: boolean): Promise<void> {
  for (let after = 0; ;) {
    const rows = await db
      .select({ id: actions.id, accountId: actions.accountId, payload: actions.payload })
      .from(actions)
      .where(and(notLike(actions.payload, `${prefix}%`), gt(actions.id, after)))
      .orderBy(asc(actions.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    const sealed = rows.map((r) => ({ id: r.id, payload: seal(db, actionName(db, r.accountId), reopen(db, actionName(db, r.accountId), r.payload)) }));
    if (write)
      await db.transaction(async (tx) => {
        for (const { id, payload } of sealed) await tx.update(actions).set({ payload }).where(eq(actions.id, id));
      });
    after = rows.at(-1)!.id;
  }
  for (let after = 0; ;) {
    const rows = await db
      .select({ id: decisions.id, accountId: decisions.accountId, messageId: decisions.messageId, reason: decisions.reason })
      .from(decisions)
      .where(and(notLike(decisions.reason, `${prefix}%`), gt(decisions.id, after)))
      .orderBy(asc(decisions.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    const sealed = rows.map((r) => ({
      id: r.id,
      reason: sealPart(db, r.accountId, r.messageId, 'reason', forRekey(db, r.accountId, r.messageId, 'reason', r.reason))!,
    }));
    if (write)
      await db.transaction(async (tx) => {
        for (const { id, reason } of sealed) await tx.update(decisions).set({ reason }).where(eq(decisions.id, id));
      });
    after = rows.at(-1)!.id;
  }
}

/** Mail records, the text kept of them and correspondents. Returns how many messages had something to bring under the key. */
async function rekeyMail(db: Sql, prefix: string, write: boolean): Promise<number> {
  const touched = new Set<string>();
  const bodies = [
    {
      table: readBodies,
      rows: await db
        .select({
          accountId: readBodies.accountId,
          messageId: readBodies.messageId,
          text: readBodies.bodyText,
          html: readBodies.bodyHtml,
        })
        .from(readBodies)
        .where(or(notLike(readBodies.bodyText, `${prefix}%`), notLike(readBodies.bodyHtml, `${prefix}%`))),
    },
    {
      table: examples,
      rows: await db
        .select({ accountId: examples.accountId, messageId: examples.messageId, text: examples.bodyText, html: examples.bodyHtml })
        .from(examples)
        .where(or(notLike(examples.bodyText, `${prefix}%`), notLike(examples.bodyHtml, `${prefix}%`))),
    },
  ];
  const reseal = bodies.flatMap(({ table, rows }) =>
    rows
      .filter((r) => stale(db, r.text) || stale(db, r.html))
      .map((r) => ({
        table,
        row: r,
        text: sealPart(db, r.accountId, r.messageId, 'text', forRekey(db, r.accountId, r.messageId, 'text', r.text)),
        html: sealPart(db, r.accountId, r.messageId, 'html', forRekey(db, r.accountId, r.messageId, 'html', r.html)),
      })),
  );
  for (const { row } of reseal) touched.add(`${row.accountId}\n${row.messageId}`);
  if (write)
    await db.transaction(async (tx) => {
      for (const { table, row, text, html } of reseal)
        await tx
          .update(table)
          .set({ bodyText: text, bodyHtml: html })
          .where(and(eq(table.accountId, row.accountId), eq(table.messageId, row.messageId)));
    });

  // Inbox keeps the text of a whole inbox, so it is read in batches, as mail records are. Its search index is made again
  // with the text, under the new key's search key; one there was none of yet is left to the pass.
  for (let after: { accountId: string; messageId: string } | null = null; ;) {
    const rows = await db
      .select({
        accountId: mailBodies.accountId,
        messageId: mailBodies.messageId,
        text: mailBodies.bodyText,
        html: mailBodies.bodyHtml,
        indexed: sql<boolean>`${mailBodies.search} IS NOT NULL`,
        headers: messages.headers,
      })
      .from(mailBodies)
      .innerJoin(messages, and(eq(messages.accountId, mailBodies.accountId), eq(messages.id, mailBodies.messageId)))
      .where(
        and(
          or(notLike(mailBodies.bodyText, `${prefix}%`), notLike(mailBodies.bodyHtml, `${prefix}%`)),
          after
            ? or(gt(mailBodies.accountId, after.accountId), and(eq(mailBodies.accountId, after.accountId), gt(mailBodies.messageId, after.messageId)))
            : undefined,
        ),
      )
      .orderBy(asc(mailBodies.accountId), asc(mailBodies.messageId))
      .limit(BATCH);
    if (rows.length === 0) break;
    const resealed = rows
      .filter((r) => stale(db, r.text) || stale(db, r.html))
      .map((r) => {
        const text = forRekey(db, r.accountId, r.messageId, 'text', r.text)!;
        const envelope = envelopeFrom(forRekey(db, r.accountId, r.messageId, 'headers', r.headers)) as Envelope;
        return {
          ...r,
          text: sealPart(db, r.accountId, r.messageId, 'text', text)!,
          html: sealPart(db, r.accountId, r.messageId, 'html', forRekey(db, r.accountId, r.messageId, 'html', r.html)),
          search: r.indexed ? searchIndex(db, { text, fromName: envelope.fromName, fromAddress: envelope.fromAddress, subject: envelope.subject }) : null,
        };
      });
    for (const r of resealed) touched.add(`${r.accountId}\n${r.messageId}`);
    if (write)
      await db.transaction(async (tx) => {
        for (const r of resealed)
          await tx
            .update(mailBodies)
            .set({ bodyText: r.text, bodyHtml: r.html, search: r.search })
            .where(and(eq(mailBodies.accountId, r.accountId), eq(mailBodies.messageId, r.messageId)));
      });
    const last: { accountId: string; messageId: string } = rows.at(-1)!;
    after = { accountId: last.accountId, messageId: last.messageId };
  }

  // A record's hashes are made with the key its headers are encrypted with, so the headers say whether both are current.
  let after: { accountId: string; id: string } | null = null;
  for (;;) {
    const rows = await db
      .select({ accountId: messages.accountId, id: messages.id, facts: messages.facts, headers: messages.headers })
      .from(messages)
      .where(
        and(
          notLike(messages.headers, `${prefix}%`),
          after ? or(gt(messages.accountId, after.accountId), and(eq(messages.accountId, after.accountId), gt(messages.id, after.id))) : undefined,
        ),
      )
      .orderBy(asc(messages.accountId), asc(messages.id))
      .limit(BATCH);
    if (rows.length === 0) break;
    const records = rows.map((r) => {
      const headers = JSON.parse(forRekey(db, r.accountId, r.id, 'headers', r.headers)!) as Record<string, string>;
      return {
        accountId: r.accountId,
        id: r.id,
        sealed: { ...sealMessage(db, r.accountId, r.id, { from: envelopeOf(headers)!.from, headers }), facts: sealFacts(r.facts) },
      };
    });
    for (const r of records) touched.add(`${r.accountId}\n${r.id}`);
    if (write)
      await db.transaction(async (tx) => {
        for (const r of records)
          await tx
            .update(messages)
            .set(r.sealed)
            .where(and(eq(messages.accountId, r.accountId), eq(messages.id, r.id)));
      });
    const last: { accountId: string; id: string } = rows.at(-1)!;
    after = { accountId: last.accountId, id: last.id };
  }

  // Who the owner has written to is a cache kept only as hashes, which a new key makes useless: it refills as mail arrives.
  // Examples are found by hashes too, which `keyExamples` makes again.
  if (write && touched.size > 0) {
    await db.delete(correspondents);
    await db.update(examples).set({ nameHash: UNSET, subjectHash: UNSET });
  }
  return touched.size;
}

/** Hash what examples are found by where it is `unset:`: answers given before there were these hashes, and every one under a new key. */
async function keyExamples(db: Sql): Promise<void> {
  const unset = or(eq(examples.nameHash, UNSET), eq(examples.subjectHash, UNSET));
  for (;;) {
    const rows = await db
      .select({ accountId: examples.accountId, messageId: examples.messageId, headers: messages.headers })
      .from(examples)
      .innerJoin(messages, and(eq(messages.accountId, examples.accountId), eq(messages.id, examples.messageId)))
      .where(unset)
      .limit(BATCH);
    if (rows.length === 0) return;
    await db.transaction(async (tx) => {
      for (const r of rows)
        await tx
          .update(examples)
          .set(keysOfStored(db, r.accountId, r.messageId, r.headers))
          .where(and(eq(examples.accountId, r.accountId), eq(examples.messageId, r.messageId)));
    });
  }
}
