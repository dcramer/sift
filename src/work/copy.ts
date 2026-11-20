import { and, eq, exists, inArray, mailBodies, messages, sql } from '../store/query.ts';
import type { Sql } from '../store/sql.ts';
import type { GmailApi } from '../gmail/api.ts';
import { NOT_MAIL, toFacts } from '../gmail/sync.ts';
import { type MailCopy, advanceCopy, goingCopy } from '../store/copies.ts';
import { isOwnDigest, knownDigests } from '../store/digests.ts';
import { heldText, keepText, recordKept } from '../store/kept.ts';
import { textOf } from './bodies.ts';
import { QUOTA_PER_MINUTE } from '../gmail/quota.ts';
import { type MailWindow, windowStart } from '../mail-window.ts';

/**
 * Ids listed a page: 100 whole reads are 6,000 quota units, about a minute and a quarter of the mailbox's quota, so a step
 * gets through a few pages and one cut short at its limit has little to list again.
 */
const PAGE = 100;

/**
 * The search a copy lists: mail received from `since` (whatever is in the inbox, however old) to `before`, which is when
 * Inbox was turned on (sync records what came after) or where a narrower window began (copied already). Gmail takes
 * epoch seconds; the second `before` falls in is listed too, and found recorded.
 */
export function copyQuery(copy: Pick<MailCopy, 'since' | 'before'>): string {
  return [
    ...(copy.since === null ? [] : [`{in:inbox after:${Math.floor(copy.since / 1000)}}`]),
    `before:${Math.ceil(copy.before / 1000) + 1}`,
    '-in:drafts',
    '-in:chats',
  ].join(' ');
}

/** Of `ids`, what the record holds: in the inbox now, and whether Inbox holds its text. */
async function recorded(db: Sql, accountId: string, ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, { inbox: boolean; text: boolean }>();
  const rows = await db
    .select({
      id: messages.id,
      inbox: sql<boolean>`${messages.labelIds} @> '["INBOX"]'::jsonb`.mapWith(Boolean),
      text: exists(
        db
          .select({ one: sql`1` })
          .from(mailBodies)
          .where(and(eq(mailBodies.accountId, messages.accountId), eq(mailBodies.messageId, messages.id))),
      ).mapWith(Boolean),
    })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), inArray(messages.id, [...ids])));
  return new Map(rows.map((r) => [r.id, { inbox: r.inbox, text: r.text }]));
}

/**
 * Go on copying one mailbox for Inbox, a page of Gmail's listing at a time, newest first, starting nothing after `until`.
 * Each message new to the record is read whole once (60 units) and recorded with its text, never triaged (`recordKept`);
 * one recorded without its text has the text read, unless Sift read it in the last month. What is in the inbox and recorded is left to the pass, which keeps its
 * text newest first too (`keepMailBodies`), so the two never read the same message. A page cut short is listed again and
 * what it recorded is passed over, so a crash or a failed step loses nothing. Stops once Inbox is off: every write checks.
 * Returns how many messages it read, or null when there is no copy going.
 */
export async function copyMail(
  deps: { db: Sql; api: Pick<GmailApi, 'searchMail' | 'getMessage' | 'getContent'>; until?: number; now?: () => number },
  accountId: string,
): Promise<number | null> {
  const { db, api } = deps;
  const now = deps.now ?? Date.now;
  const out = () => deps.until !== undefined && now() >= deps.until;
  let read = 0;
  let copy = await goingCopy(db, accountId);
  if (!copy) return null;
  while (copy && !out()) {
    const page = await api.searchMail(copyQuery(copy), PAGE, copy.pageToken ?? undefined);
    const known = await recorded(db, accountId, page.ids);
    const digests = await knownDigests(db, accountId, page.ids);
    for (const id of page.ids) {
      const state = known.get(id);
      if (state?.text || state?.inbox || digests.has(id)) continue;
      if (out()) return read;
      let kept: boolean;
      if (state) {
        // Read with Inbox off in the last month: moved, not read again.
        kept = await keepText(db, accountId, id, (await heldText(db, accountId, id)) ?? textOf(await api.getContent(id)), now());
      } else {
        const whole = await api.getMessage(id);
        const facts = whole && !whole.raw.labelIds.some((l) => NOT_MAIL.includes(l)) ? toFacts(accountId, whole.raw) : null;
        kept = !facts || (await isOwnDigest(db, facts.headers)) || (await recordKept(db, accountId, { facts, text: textOf(whole!.content) }, now()));
      }
      read++;
      if (!kept) return read;
    }
    await advanceCopy(db, copy, { listed: page.ids.length, next: page.nextPageToken ?? null, estimate: page.estimate ?? 0 }, now());
    copy = await goingCopy(db, accountId);
  }
  return read;
}

/** What a whole read costs of the quota: `messages.get` with `format=full`, as with `raw`. */
const READ_UNITS = 60;

const found = (page: { ids: string[]; nextPageToken?: string; estimate?: number }) =>
  page.nextPageToken ? Math.max(page.estimate ?? 0, page.ids.length) : page.ids.length;

/**
 * About how many messages copying one mailbox reads for each window, from Gmail's count (its estimate for a search, which can
 * be well off; the mailbox's own count for all of it), and the minutes of its quota that takes at the least. 11 units.
 */
export async function reachOf(
  api: Pick<GmailApi, 'searchMail' | 'mailboxSize'>,
  now: number,
): Promise<Record<MailWindow, { messages: number; minutes: number }>> {
  const year = found(await api.searchMail(copyQuery({ since: windowStart('year', now), before: now }), 1));
  const three = Math.max(year, found(await api.searchMail(copyQuery({ since: windowStart('three_years', now), before: now }), 1)));
  const all = Math.max(three, await api.mailboxSize());
  const of = (messages: number) => ({ messages, minutes: Math.ceil((messages * READ_UNITS) / QUOTA_PER_MINUTE) });
  return { year: of(year), three_years: of(three), all: of(all) };
}
