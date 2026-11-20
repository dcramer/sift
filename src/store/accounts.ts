import { and, asc, eq, gt, isNull, lte, accounts, credentials, labels, mailboxes, messages as messageRows, preferences, users } from './query.ts';
import { startCopies } from './copies.ts';
import { windowStart } from '../mail-window.ts';
import { inboxRow } from './labels.ts';
import type { Sql } from './sql.ts';
import { sealFacts, sealMessage } from './content.ts';
import type { Store } from './store.ts';
import { deriveFacts } from '../triage/facts.ts';
import type { MessageFacts } from '../triage/types.ts';

export interface Account {
  id: string;
  /** The mailbox's own number, the same while it stays connected: what names it in a Workflow run. */
  number: number;
  email: string;
  historyId: string | null;
}

/** A person. Their accounts are the mailboxes they have signed in with. */
export interface User {
  id: number;
  /** The first user: the one who may change what applies to the whole install. */
  owner: boolean;
}

/**
 * Add an account, or reset its cursor if it is already connected. The account id is its email address.
 * A new account joins `userId`'s mailboxes when given (someone signed in connected it); otherwise it is
 * a new person's first, and the first person ever owns the install. An account never changes hands.
 * Returns the person it belongs to.
 */
export async function connectAccount(store: Store, email: string, historyId: string, now: number = Date.now(), userId?: number): Promise<number> {
  const user = await store.central.transaction(async (tx) => {
    const [known] = await tx.select({ userId: accounts.userId }).from(accounts).where(eq(accounts.id, email));
    if (known) return known.userId;
    let person = userId;
    if (person === undefined) {
      const first = (await tx.select({ id: users.id }).from(users).limit(1)).length === 0;
      [{ id: person }] = (await tx.insert(users).values({ owner: first, createdAt: now }).returning({ id: users.id })) as [{ id: number }];
    }
    // A person's first mailbox is their primary one.
    await tx.insert(accounts).values({ id: email, userId: person, createdAt: now, primary: userId === undefined });
    return person;
  });
  await addMailbox(await store.user(user), email, historyId);
  return user;
}

/**
 * A mailbox in one person's own database, unless it is there already. Their labels and rules are theirs for
 * every mailbox, so one connected later is not set up again; the first brings Leave in inbox. Its `accounts`
 * row must exist. Returns whether it was new.
 */
export async function ensureMailbox(db: Sql, mailbox: { id: string; historyId?: string | null }): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const added = await tx.insert(mailboxes).values(mailbox).onConflictDoNothing().returning({ id: mailboxes.id });
    await tx.insert(labels).values(inboxRow()).onConflictDoNothing();
    return added.length > 0;
  });
}

/** A mailbox in one person's own database, or its cursor reset if it is there already. A new one is copied for Inbox while it is on. */
export async function addMailbox(db: Sql, id: string, historyId: string, now: number = Date.now()): Promise<void> {
  await db.transaction(async (tx) => {
    if (!(await ensureMailbox(tx, { id, historyId }))) {
      await tx.update(mailboxes).set({ historyId }).where(eq(mailboxes.id, id));
      return;
    }
    const [inbox] = await tx.select({ on: preferences.mail, window: preferences.mailWindow }).from(preferences);
    if (inbox?.on) await startCopies(tx, [id], { since: windowStart(inbox.window, now), before: now, now });
  });
}

/**
 * Remove one of a person's mailboxes: its Gmail sign-in, then its account, which takes its mailbox and every
 * row of it along. The primary one's place goes to the earliest connected of those left. Revoking the
 * sign-in at Google is the caller's, before this. Returns false if the mailbox is not theirs.
 */
export async function removeMailbox(store: Store, userId: number, email: string): Promise<boolean> {
  const [theirs] = await store.central
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, email), eq(accounts.userId, userId)));
  if (!theirs) return false;
  // The token first: a crash in between leaves a mailbox sift cannot read, not a token for one it no longer has.
  await (await store.user(userId)).delete(credentials).where(and(eq(credentials.kind, 'gmail'), eq(credentials.key, email)));
  await store.central.transaction(async (tx) => {
    const [gone] = await tx
      .delete(accounts)
      .where(and(eq(accounts.id, email), eq(accounts.userId, userId)))
      .returning({ primary: accounts.primary });
    if (!gone?.primary) return;
    const [next] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, userId))
      .orderBy(asc(accounts.createdAt), asc(accounts.id))
      .limit(1);
    if (next) await tx.update(accounts).set({ primary: true }).where(eq(accounts.id, next.id));
  });
  return true;
}

/** Make one of a person's mailboxes their primary one. False if it is not theirs. */
export async function makePrimary(central: Sql, userId: number, email: string): Promise<boolean> {
  return await central.transaction(async (tx) => {
    const [theirs] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.id, email), eq(accounts.userId, userId)));
    if (!theirs) return false;
    await tx
      .update(accounts)
      .set({ primary: false })
      .where(and(eq(accounts.userId, userId), eq(accounts.primary, true)));
    await tx.update(accounts).set({ primary: true }).where(eq(accounts.id, email));
    return true;
  });
}

/** A person's mailboxes, by address, and which is their primary one. */
export async function mailboxesOf(central: Sql, userId: number): Promise<{ id: string; primary: boolean }[]> {
  return await central.select({ id: accounts.id, primary: accounts.primary }).from(accounts).where(eq(accounts.userId, userId)).orderBy(asc(accounts.id));
}

/**
 * Delete a person and everything of theirs, their sign-ins included. Revoking their Gmail sign-ins is the
 * caller's, before this. When they owned the install, the earliest person left owns it; with nobody left,
 * whoever signs in next does.
 */
export async function deleteUser(store: Store, userId: number): Promise<void> {
  await store.central.transaction(async (tx) => {
    const [gone] = await tx.delete(users).where(eq(users.id, userId)).returning({ owner: users.owner });
    if (!gone?.owner) return;
    const [next] = await tx.select({ id: users.id }).from(users).orderBy(asc(users.createdAt), asc(users.id)).limit(1);
    if (next) await tx.update(users).set({ owner: true }).where(eq(users.id, next.id));
  });
  store.forget(userId);
}

/** The person an account belongs to, or null if it is not connected. */
export async function userOf(central: Sql, email: string): Promise<User | null> {
  const [row] = await central
    .select({ id: users.id, owner: users.owner })
    .from(accounts)
    .innerJoin(users, eq(users.id, accounts.userId))
    .where(eq(accounts.id, email));
  return row ?? null;
}

/** The person who owns the install, once someone has signed in. */
export async function owner(central: Sql): Promise<User | null> {
  const [row] = await central.select({ id: users.id }).from(users).where(eq(users.owner, true)).orderBy(asc(users.id)).limit(1);
  return row ? { id: row.id, owner: true } : null;
}

export async function listUsers(central: Sql): Promise<User[]> {
  return await central.select({ id: users.id, owner: users.owner }).from(users).orderBy(asc(users.id));
}

/** Every connected address, everyone's. */
export async function connectedAddresses(central: Sql): Promise<string[]> {
  const rows = await central.select({ id: accounts.id }).from(accounts).orderBy(asc(accounts.id));
  return rows.map((r) => r.id);
}

/** Whose rows `db` reads and writes. */
export async function personOf(db: Sql): Promise<number> {
  if (db.person === null) throw new Error('The central handle is no one’s.');
  return db.person;
}

/** When the account's last sync began, or null before its first. */
export async function lastSyncedAt(db: Sql, accountId: string): Promise<number | null> {
  const [row] = await db.select({ at: mailboxes.lastSyncedAt }).from(mailboxes).where(eq(mailboxes.id, accountId));
  return row?.at ?? null;
}

/** How long Google lets a sign-in from a client in Testing last ([gmail.md](../../docs/gmail.md#signing-in)). */
export const TESTING_SIGN_IN_MS = 7 * 86_400_000;
/**
 * How long after the week an ended sign-in is still taken for Testing's: it is found only at the next look, and a
 * revoked or password-changed one is refused the same way. Gmail still answering past it means the client is not in Testing.
 */
const NOTICED_MS = 86_400_000;

export async function signedIn(db: Sql, accountId: string, now: number): Promise<void> {
  await db.update(mailboxes).set({ signedInAt: now }).where(eq(mailboxes.id, accountId));
}

/** Google refused the mailbox's sign-in: if it was given a week ago, its client is in Testing and the next will end a week after it too. */
export async function signInEnded(db: Sql, accountId: string, now: number): Promise<void> {
  await db
    .update(mailboxes)
    .set({ weeklySignIn: true })
    .where(
      and(eq(mailboxes.id, accountId), lte(mailboxes.signedInAt, now - TESTING_SIGN_IN_MS), gt(mailboxes.signedInAt, now - TESTING_SIGN_IN_MS - NOTICED_MS)),
    );
}

/** Gmail answered: a sign-in that has outlived the week was not given by a client in Testing, whatever an earlier one was. */
export async function signInHeld(db: Sql, accountId: string, now: number): Promise<void> {
  await db
    .update(mailboxes)
    .set({ weeklySignIn: false })
    .where(and(eq(mailboxes.id, accountId), eq(mailboxes.weeklySignIn, true), lte(mailboxes.signedInAt, now - TESTING_SIGN_IN_MS - NOTICED_MS)));
}

/** When each mailbox's sign-in will end, for those whose last ended a week after it was given. */
export async function signInEnds(db: Sql): Promise<Map<string, number>> {
  const rows = await db.select({ id: mailboxes.id, at: mailboxes.signedInAt }).from(mailboxes).where(eq(mailboxes.weeklySignIn, true));
  return new Map(rows.flatMap((r) => (r.at === null ? [] : [[r.id, r.at + TESTING_SIGN_IN_MS] as const])));
}

/** The mailboxes in one person's database. */
export async function listAccounts(db: Sql): Promise<Account[]> {
  const rows = await db.select({ id: mailboxes.id, number: mailboxes.number, historyId: mailboxes.historyId }).from(mailboxes).orderBy(asc(mailboxes.id));
  return rows.map((r) => ({ id: r.id, number: r.number, email: r.id, historyId: r.historyId }));
}

/** Whether the sign-in Sift holds for this mailbox lets it send. */
export async function canSend(db: Sql, accountId: string): Promise<boolean> {
  const [row] = await db.select({ canSend: mailboxes.canSend }).from(mailboxes).where(eq(mailboxes.id, accountId));
  return row?.canSend ?? false;
}

export async function setCanSend(db: Sql, accountId: string, can: boolean): Promise<void> {
  await db.update(mailboxes).set({ canSend: can }).where(eq(mailboxes.id, accountId));
}

/** The mailbox's other addresses in Gmail, as its last sync found them. */
export async function mailboxAliases(db: Sql, accountId: string): Promise<string[]> {
  const [row] = await db.select({ aliases: mailboxes.aliases }).from(mailboxes).where(eq(mailboxes.id, accountId));
  return row?.aliases ?? [];
}

export async function setMailboxAliases(db: Sql, accountId: string, aliases: readonly string[]): Promise<void> {
  await db
    .update(mailboxes)
    .set({ aliases: aliases.filter((a) => a !== accountId) })
    .where(eq(mailboxes.id, accountId));
}

async function insertMessages(
  db: Sql,
  accountId: string,
  messages: readonly MessageFacts[],
  now: number,
  suggestOnly: boolean,
  decided = false,
): Promise<number> {
  if (messages.length === 0) return 0;
  const aliases = await mailboxAliases(db, accountId);
  const added = await db
    .insert(messageRows)
    .values(
      messages.map((m) => ({
        accountId,
        id: m.messageId,
        threadId: m.threadId,
        receivedAt: m.receivedAt,
        ...sealMessage(db, accountId, m.messageId, m),
        labelIds: m.labelIds,
        syncedAt: now,
        suggestOnly,
        decided,
        facts: sealFacts(deriveFacts(m, {}, aliases)),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: messageRows.id });
  return added.length;
}

/**
 * Record newly synced messages and advance the cursor atomically, so a crash can neither lose a
 * message nor skip one. Stores the subject and triage headers, no body.
 * `read` are messages the user was seen to have opened, these or earlier ones; the first sighting stands.
 * Returns how many messages were not already known.
 */
export async function recordSync(
  db: Sql,
  accountId: string,
  messages: readonly MessageFacts[],
  historyId: string,
  now: number = Date.now(),
  read: readonly string[] = [],
): Promise<number> {
  return await db.transaction(async (tx) => {
    const added = await insertMessages(tx, accountId, messages, now, false);
    for (const id of read)
      await tx
        .update(messageRows)
        .set({ readAt: now })
        .where(and(eq(messageRows.accountId, accountId), eq(messageRows.id, id), isNull(messageRows.readAt)));
    await tx.update(mailboxes).set({ historyId, lastSyncedAt: now }).where(eq(mailboxes.id, accountId));
    return added;
  });
}

/** Record synced messages before the cursor moves, for a sync too long to fetch in one go. Returns how many were not already known. */
export async function recordSynced(db: Sql, accountId: string, messages: readonly MessageFacts[], now: number = Date.now()): Promise<number> {
  return await db.transaction(async (tx) => await insertMessages(tx, accountId, messages, now, false));
}

/**
 * Record mail found in the inbox that Sift had not seen, read for a look that decides nothing (what a rule would do), so it
 * is not read again. Out of the triage queue, as the copy's mail is: going through the inbox or applying a rule decides it.
 */
export async function recordFound(db: Sql, accountId: string, messages: readonly MessageFacts[], now: number): Promise<void> {
  await db.transaction(async (tx) => await insertMessages(tx, accountId, messages, now, false, true));
}

/**
 * Record mail an inbox run found that Sift had not seen. It does not move the sync cursor. `suggestOnly`
 * when the run only suggests, so a pass that decides it first never carries it out either. Returns how many were not already known.
 */
export async function recordFromInbox(
  db: Sql,
  accountId: string,
  messages: readonly MessageFacts[],
  suggestOnly: boolean,
  now: number = Date.now(),
): Promise<number> {
  return await db.transaction(async (tx) => await insertMessages(tx, accountId, messages, now, suggestOnly));
}
