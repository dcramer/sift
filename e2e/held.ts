import { loadConfig } from '../src/config.ts';
import { plain } from '../src/plain.ts';
import { listAccounts } from '../src/store/accounts.ts';
import { openEnvelope, openPart } from '../src/store/content.ts';
import { people } from '../src/store/people.ts';
import { listProposals } from '../src/store/proposals.ts';
import { decisions, messages, readBodies } from '../src/store/query.ts';
import { listRules } from '../src/store/rules.ts';
import { openStore } from '../src/store/store.ts';

/**
 * What the seeded home's owner has stored encrypted, decrypted through the store: every sender, recipient, subject,
 * line of waiting mail, decision's reason and rule's or proposal's condition and name. Their own mailboxes'
 * addresses are stored plain, and are left out.
 */
export async function heldValues(home: string): Promise<string[]> {
  const store = await openStore(loadConfig({ SIFT_HOME: home }));
  try {
    const owner = (await people(store).owner())!;
    const db = await owner.open(owner.id);
    const held = new Set<string>();
    const add = (...values: (string | null | undefined)[]) => values.forEach((v) => v && held.add(v));
    for (const row of await db.select({ accountId: messages.accountId, id: messages.id, headers: messages.headers }).from(messages)) {
      const m = plain(openEnvelope(db, row.accountId, row.id, { headers: row.headers }));
      add(m.subject, m.fromAddress, m.fromName, ...[...m.to, ...m.cc].flatMap((a) => [a.address, a.name]));
    }
    for (const row of await db.select().from(readBodies))
      add(
        plain(openPart(db, row.accountId, row.messageId, 'text', row.bodyText))
          ?.trim()
          .split('\n')[0]
          ?.slice(0, 60),
      );
    for (const row of await db.select({ accountId: decisions.accountId, messageId: decisions.messageId, reason: decisions.reason }).from(decisions))
      add(plain(openPart(db, row.accountId, row.messageId, 'reason', row.reason)));
    const conditions = [...(await listRules(db)).flatMap((r) => [r.match, ...(r.except ?? [])]), ...(await listProposals(db)).map((p) => plain(p.match))];
    for (const match of conditions) add(...Object.entries(match).flatMap(([key, value]) => (key === 'facts' ? [] : (value as string[]))));
    add(...(await listRules(db)).map((r) => r.name));
    for (const account of await listAccounts(db)) held.delete(account.email);
    return [...held].filter((value) => value.length >= 4);
  } finally {
    await store.close();
  }
}
