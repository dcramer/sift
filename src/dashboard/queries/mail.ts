import {
  type AnyColumn,
  type SQL,
  alias,
  and,
  asc,
  decisions,
  desc,
  eq,
  exists,
  feedback,
  gte,
  inArray,
  isNull,
  lt,
  mailBodies,
  max,
  messages,
  not,
  or,
  sql,
  readBodies,
} from '../../store/query.ts';
import type { Sql } from '../../store/sql.ts';
import { listAccounts } from '../../store/accounts.ts';
import { listLabels } from '../../store/labels.ts';
import { hashOf, openEnvelope, openPart } from '../../store/content.ts';
import { mayMatch, searchedWords } from '../../store/search.ts';
import { type Search, matches, searchOf } from '../../search.ts';
import { type Scope, within } from '../scope.ts';
import { Refusal } from '../../refusal.ts';
import type { MailConversation, MailThread, MailThreads, MailView } from '../types.ts';
import { plain, seal } from '../../plain.ts';
import type { Confidential } from '../../confidential.ts';

/** About a screen's worth of conversations, so a page arrives in one read and scrolling loads the next. */
const PAGE = 50;
/**
 * How many conversations whose index says they may match one search reads through, newest first, opening their text to
 * drop those that do not. Fewer than a page matched by then answers what it has, with `next` to go on from.
 */
const SEARCH_REACH = 200;
const PREVIEW_CHARS = 400;

const has = (labelIds: SQL | AnyColumn, label: string) => sql<boolean>`${labelIds} @> ${JSON.stringify([label])}::jsonb`;

/** `newestAt.threadId`: where a page ended. Thread ids are Gmail's, letters and digits. */
const CURSOR = /^(\d+)\.([\w-]+)$/;

export interface ThreadQuery {
  view: MailView;
  label?: string | undefined;
  q?: string | undefined;
  unread?: boolean;
  before?: string | undefined;
  /** Senders, any of which wrote a message of the conversation: addresses, and domains for everyone at one. */
  from?: readonly string[];
  domain?: readonly string[];
  /** The newest message came on or after it. */
  since?: number | undefined;
}

/** Spam and Trash are not looked through, as Gmail's search does not. */
const junk = (labelIds: AnyColumn) => or(has(labelIds, 'SPAM'), has(labelIds, 'TRASH'))!;

/**
 * Conversations, newest first, a page at a time: those with mail in the inbox now, or, for a search or what Ask made of
 * one, all the mail Sift keeps. A search (`q`) is words one message has in its text, its sender or its subject, all of
 * them, the last as the start of one.
 */
export async function listThreads(db: Sql, scope: Scope, query: ThreadQuery): Promise<MailThreads> {
  const search = searchOf(query.q ?? '');
  const everywhere = search !== null || (query.from ?? []).length > 0 || (query.domain ?? []).length > 0 || query.since !== undefined;
  const inInbox = alias(messages, 'in_inbox');
  const hit = alias(messages, 'hit');
  const threads = db
    .select({
      accountId: messages.accountId,
      threadId: messages.threadId,
      newestAt: sql<number>`max(${messages.receivedAt})`.mapWith(Number).as('newest_at'),
      newestId: sql<string>`(array_agg(${messages.id} ORDER BY ${messages.receivedAt} DESC, ${messages.id} DESC))[1]`.as('newest_id'),
      unread: sql<boolean>`bool_or(${has(messages.labelIds, 'UNREAD')})`.as('unread'),
      inInbox: sql<boolean>`bool_or(${has(messages.labelIds, 'INBOX')})`.as('in_inbox'),
      sent: sql<boolean>`bool_and(${has(messages.labelIds, 'SENT')})`.as('sent'),
    })
    .from(messages)
    .where(
      and(
        within(scope, messages.accountId),
        everywhere
          ? not(junk(messages.labelIds))
          : exists(
              db
                .select({ one: sql`1` })
                .from(inInbox)
                .where(and(eq(inInbox.accountId, messages.accountId), eq(inInbox.threadId, messages.threadId), has(inInbox.labelIds, 'INBOX'))),
            ),
        search
          ? exists(
              db
                .select({ one: sql`1` })
                .from(hit)
                .innerJoin(mailBodies, and(eq(mailBodies.accountId, hit.accountId), eq(mailBodies.messageId, hit.id)))
                .where(
                  and(
                    eq(hit.accountId, messages.accountId),
                    eq(hit.threadId, messages.threadId),
                    not(junk(hit.labelIds)),
                    mayMatch(db, mailBodies.search, search),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .groupBy(messages.accountId, messages.threadId)
    .as('threads');
  const later = alias(decisions, 'later');
  // The reader's answer about it, where they gave one, beats what Sift decided.
  const answered = sql`${feedback.id} IS NOT NULL`;
  const labelId = sql<string | null>`CASE WHEN ${answered} THEN ${feedback.labelId} ELSE ${decisions.labelId} END`;
  const disposition = sql<string | null>`CASE WHEN ${answered} THEN ${feedback.disposition} ELSE ${decisions.disposition} END`;
  const cursor = query.before === undefined ? null : CURSOR.exec(query.before);
  const senders = [
    ...(query.from ?? []).map((a) => [hashOf(db, a), 'sender'] as const),
    ...(query.domain ?? []).map((d) => [hashOf(db, d), 'domain'] as const),
  ];
  const sent = alias(messages, 'sent');
  const rows = await db
    .select({
      accountId: threads.accountId,
      threadId: threads.threadId,
      newestAt: threads.newestAt,
      newestId: threads.newestId,
      unread: threads.unread,
      inInbox: threads.inInbox,
      sent: threads.sent,
      decisionId: decisions.id,
      answered: sql<boolean>`${answered}`,
      disposition,
      block: decisions.block,
      digest: decisions.digest,
      labelId,
      stage: decisions.stage,
      confidence: decisions.confidence,
    })
    .from(threads)
    .leftJoin(
      decisions,
      and(
        eq(decisions.accountId, threads.accountId),
        eq(decisions.messageId, threads.newestId),
        eq(
          decisions.id,
          db
            .select({ id: max(later.id) })
            .from(later)
            .where(and(eq(later.accountId, threads.accountId), eq(later.messageId, threads.newestId))),
        ),
      ),
    )
    .leftJoin(feedback, eq(feedback.decisionId, decisions.id))
    .where(
      and(
        cursor ? or(lt(threads.newestAt, Number(cursor[1])), and(eq(threads.newestAt, Number(cursor[1])), lt(threads.threadId, cursor[2]!))) : undefined,
        query.label ? sql`${labelId} = ${query.label}` : undefined,
        query.view === 'needs' ? or(isNull(decisions.id), sql`${disposition} IN ('keep', 'review')`) : undefined,
        query.view === 'sorted' ? sql`${disposition} IN ('archive', 'spam')` : undefined,
        query.unread ? eq(threads.unread, true) : undefined,
        query.since === undefined ? undefined : gte(threads.newestAt, query.since),
        senders.length > 0
          ? exists(
              db
                .select({ one: sql`1` })
                .from(sent)
                .where(
                  and(
                    eq(sent.accountId, threads.accountId),
                    eq(sent.threadId, threads.threadId),
                    or(...senders.map(([hash, by]) => eq(by === 'sender' ? sent.senderHash : sent.domainHash, hash))),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(threads.newestAt), desc(threads.threadId))
    .limit((search ? SEARCH_REACH : PAGE) + 1);

  const scanned = rows.slice(0, search ? SEARCH_REACH : PAGE);
  const matches = search ? await confirmed(db, scope, scanned, search) : scanned;
  const shown = matches.slice(0, PAGE);
  const last = matches.length > PAGE ? shown.at(-1) : rows.length > scanned.length ? scanned.at(-1) : undefined;
  const inThreads = await threadMessages(
    db,
    scope,
    shown.map((r) => [r.accountId, r.threadId] as const),
  );

  const names = new Map((await listLabels(db)).map((l) => [l.id, l.name] as const));
  const mine = new Set((await listAccounts(db)).map((a) => a.id));
  const previews = await previewsOf(
    db,
    shown.map((r) => [r.accountId, r.newestId] as const),
  );
  return {
    threads: shown.map((r): MailThread => {
      const all = inThreads.get(`${r.accountId}\n${r.threadId}`) ?? [];
      const newest = all.at(-1)!;
      const who = [...new Set(all.map((m) => (mine.has(plain(m.fromAddress)) ? 'me' : plain(m.fromName ?? m.fromAddress))))];
      return {
        accountId: r.accountId,
        threadId: r.threadId,
        subject: newest.subject,
        who: seal(who),
        messageIds: all.map((m) => m.messageId),
        unread: r.unread,
        newestAt: r.newestAt,
        place: r.inInbox ? 'inbox' : r.sent ? 'sent' : 'archived',
        preview: previews.get(`${r.accountId}\n${r.newestId}`) ?? null,
        thinks:
          r.decisionId === null
            ? null
            : {
                decisionId: r.decisionId,
                disposition: r.answered ? r.disposition! : r.block ? 'block' : r.digest ? 'digest' : r.disposition!,
                labelId: r.labelId,
                labelName: (r.labelId && names.get(r.labelId)) ?? null,
                stage: r.stage!,
                confidence: r.answered ? null : r.confidence,
              },
      };
    }),
    next: last ? `${last.newestAt}.${last.threadId}` : null,
  };
}

/**
 * The conversations of `rows`, in order, one of whose messages has every word of `search`: the messages the index lets
 * through are opened and their words read, a page and one at a time, until more than a page match.
 */
async function confirmed<R extends { accountId: string; threadId: string }>(db: Sql, scope: Scope, rows: readonly R[], search: Search): Promise<R[]> {
  const found: R[] = [];
  for (let start = 0; start < rows.length && found.length <= PAGE; start += PAGE + 1) {
    const batch = rows.slice(start, start + PAGE + 1);
    const wanted = new Set(batch.map((r) => `${r.accountId}\n${r.threadId}`));
    const candidates = await db
      .select({ accountId: messages.accountId, threadId: messages.threadId, id: messages.id, headers: messages.headers, text: mailBodies.bodyText })
      .from(messages)
      .innerJoin(mailBodies, and(eq(mailBodies.accountId, messages.accountId), eq(mailBodies.messageId, messages.id)))
      .where(
        and(
          within(scope, messages.accountId),
          inArray(messages.threadId, [...new Set(batch.map((r) => r.threadId))]),
          not(junk(messages.labelIds)),
          mayMatch(db, mailBodies.search, search),
        ),
      );
    const matched = new Set<string>();
    for (const c of candidates) {
      const key = `${c.accountId}\n${c.threadId}`;
      if (!wanted.has(key) || matched.has(key)) continue;
      const envelope = openEnvelope(db, c.accountId, c.id, { headers: c.headers });
      const words = searchedWords({
        text: plain(openPart(db, c.accountId, c.id, 'text', c.text)) ?? '',
        fromName: plain(envelope.fromName),
        fromAddress: plain(envelope.fromAddress),
        subject: plain(envelope.subject),
      });
      if (matches(words, search)) matched.add(key);
    }
    found.push(...batch.filter((r) => matched.has(`${r.accountId}\n${r.threadId}`)));
  }
  return found;
}

/** The recorded messages of these conversations, oldest first, by `account\nthread`. */
async function threadMessages(db: Sql, scope: Scope, threads: readonly (readonly [string, string])[]) {
  const wanted = new Set(threads.map(([account, thread]) => `${account}\n${thread}`));
  const byThread = new Map<string, ReturnType<typeof open>[]>();
  if (wanted.size === 0) return byThread;
  const open = (r: { accountId: string; id: string; headers: string; receivedAt: number; labelIds: string[] }) => ({
    messageId: r.id,
    receivedAt: r.receivedAt,
    unread: r.labelIds.includes('UNREAD'),
    ...openEnvelope(db, r.accountId, r.id, { headers: r.headers }),
  });
  const rows = await db
    .select({
      accountId: messages.accountId,
      threadId: messages.threadId,
      id: messages.id,
      headers: messages.headers,
      receivedAt: messages.receivedAt,
      labelIds: messages.labelIds,
    })
    .from(messages)
    .where(and(within(scope, messages.accountId), inArray(messages.threadId, [...new Set(threads.map(([, thread]) => thread))])))
    .orderBy(asc(messages.receivedAt), asc(messages.id));
  for (const r of rows) {
    const key = `${r.accountId}\n${r.threadId}`;
    if (!wanted.has(key)) continue;
    byThread.set(key, [...(byThread.get(key) ?? []), open(r)]);
  }
  return byThread;
}

/** The start of each message's text, on one line: Inbox's whole copy, or else the copy kept while it waits on the reader. */
async function previewsOf(db: Sql, wanted: readonly (readonly [string, string])[]) {
  const previews = new Map<string, Confidential>();
  if (wanted.length === 0) return previews;
  const ids = [...new Set(wanted.map(([, id]) => id))];
  const keys = new Set(wanted.map(([account, id]) => `${account}\n${id}`));
  for (const table of [readBodies, mailBodies]) {
    const rows = await db
      .select({ accountId: table.accountId, messageId: table.messageId, text: table.bodyText })
      .from(table)
      .where(inArray(table.messageId, ids));
    for (const r of rows) {
      const key = `${r.accountId}\n${r.messageId}`;
      if (!keys.has(key)) continue;
      const text = plain(openPart(db, r.accountId, r.messageId, 'text', r.text) ?? '');
      previews.set(key, seal(text.slice(0, PREVIEW_CHARS).replace(/\s+/g, ' ').trim()));
    }
  }
  return previews;
}

/**
 * Which of the scope's mailboxes holds the conversation with Gmail's id `threadId`, or null when none does. Like a
 * message's (`mailboxOf`, queries/messages.ts), two mailboxes could hold the same id: then the request must name one.
 */
async function threadMailbox(db: Sql, scope: Scope, threadId: string): Promise<string | null> {
  const found = await db
    .selectDistinct({ accountId: messages.accountId })
    .from(messages)
    .where(and(within(scope, messages.accountId), eq(messages.threadId, threadId)));
  if (found.length > 1) throw new Refusal('More than one of your mailboxes has a conversation with that id; say which.');
  return found[0]?.accountId ?? null;
}

/** One conversation's recorded messages, oldest first, in whichever of the scope's mailboxes holds it, or null when none does. */
export async function conversation(db: Sql, scope: Scope, threadId: string): Promise<MailConversation | null> {
  const accountId = await threadMailbox(db, scope, threadId);
  if (accountId === null) return null;
  const listed = (await threadMessages(db, scope, [[accountId, threadId]])).get(`${accountId}\n${threadId}`) ?? [];
  if (listed.length === 0) return null;
  const previews = await previewsOf(
    db,
    listed.map((m) => [accountId, m.messageId] as const),
  );
  return {
    accountId,
    threadId,
    messages: listed.map((m) => ({
      messageId: m.messageId,
      fromAddress: m.fromAddress,
      fromName: m.fromName,
      receivedAt: m.receivedAt,
      unread: m.unread,
      preview: previews.get(`${accountId}\n${m.messageId}`) ?? null,
    })),
  };
}
