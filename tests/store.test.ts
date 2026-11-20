import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as schema from '../src/store/schema.ts';
import {
  addMailbox,
  connectAccount,
  connectedAddresses,
  deleteUser,
  listAccounts,
  mailboxesOf,
  makePrimary,
  recordSync,
  removeMailbox,
} from '../src/store/accounts.ts';
import { recordDecision } from '../src/store/decisions.ts';
import { listLabels, updateLabel } from '../src/store/labels.ts';
import { addRule, listRules } from '../src/store/rules.ts';
import { accounts, labels } from '../src/store/query.ts';
import { DatabaseInUse, moveAside, pglite, roleBypass, verified } from '../src/store/db.ts';
import { openStore, storeOn } from '../src/store/store.ts';
import { loadKeyring } from '../src/secrets.ts';
import { resetDb } from '../src/cli/commands/reset-db.ts';
import type { Sql } from '../src/store/sql.ts';
import type { Disposition } from '../src/triage/types.ts';
import { freshStore, onePerson, openUserDb, raw, recordEverything, rowsBy, superuser } from './fixtures.ts';
import { facts, tempDir, withSampleLabels } from './helpers.ts';

const MIGRATIONS = new URL('../src/store/migrations/', import.meta.url);

/**
 * A database migrated up to `tag` and not through it, as an install was then, with a way to run each migration on it:
 * as a Postgres server runs it, by the tables' owner, whom row-level security holds as it holds sift; or `asSuperuser`,
 * as PGlite runs it on a machine.
 */
async function migratedBefore(tag: string, { asSuperuser = false } = {}) {
  const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', MIGRATIONS), 'utf8')) as { entries: { tag: string }[] };
  const tags = journal.entries.map((e) => e.tag);
  const db = new PGlite();
  onTestFinished(() => db.close());
  const sql = (each: string) => readFileSync(new URL(`${each}.sql`, MIGRATIONS), 'utf8');
  for (const each of tags.slice(0, tags.indexOf(tag))) await db.exec(sql(each));
  // As on a Postgres server: the tables' owner runs the migration, and row-level security holds it as it holds sift.
  await db.exec(`
    CREATE ROLE migrator NOSUPERUSER NOBYPASSRLS;
    GRANT CREATE ON SCHEMA public TO migrator;
    DO $$ DECLARE t text; BEGIN
      FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP EXECUTE format('ALTER TABLE %I OWNER TO migrator', t); END LOOP;
    END $$;
  `);
  const run = async (each: string) => await db.exec(asSuperuser ? sql(each) : `SET ROLE migrator; ${sql(each)}; RESET ROLE;`);
  return { db, run, after: tags[tags.indexOf(tag) + 1]! };
}

describe('migrations', () => {
  it('have been generated for everything in the schema', async () => {
    const snapshots = readdirSync(new URL('meta/', MIGRATIONS))
      .filter((f) => f.endsWith('_snapshot.json'))
      .toSorted();
    const last = JSON.parse(readFileSync(new URL(`meta/${snapshots.at(-1)}`, MIGRATIONS), 'utf8')) as Parameters<typeof generateMigration>[0];
    expect(await generateMigration(last, generateDrizzleJson(schema, last.id)), 'run pnpm db:generate').toEqual([]);
  });

  // Drizzle runs only what is dated after the newest a database has run, so a branch's migration dated before one
  // that reached main first is skipped on every database main migrated. Renumber and re-date a branch's after main's.
  it('are dated in the order they are numbered, one to a number', () => {
    const journal = JSON.parse(readFileSync(new URL('meta/_journal.json', MIGRATIONS), 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
    const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
    expect(files.toSorted()).toEqual(journal.entries.map((e) => `${e.tag}.sql`));
    journal.entries.forEach((entry, index) => {
      expect(entry.tag.slice(0, 4)).toBe(String(index).padStart(4, '0'));
      if (index > 0) expect(entry.when, entry.tag).toBeGreaterThan(journal.entries[index - 1]!.when);
    });
  });

  it('enforce what the schema says', async () => {
    const db = await openUserDb('acct');
    const insert = (id: string, disposition: Disposition) =>
      db.insert(labels).values({ id, name: 'N', description: '', disposition, gmailLabel: 'sift/n', position: 0 }).execute();
    await insert('n', 'archive');
    await expect(insert('x', 'delete' as Disposition)).rejects.toThrow();
    await expect(insert('n', 'keep')).rejects.toThrow();
  });

  it('keep the database where they were applied, and refuse one a newer sift has migrated', async () => {
    const paths = { databaseDir: tempDir(), keys: loadKeyring({}) };
    const first = await openStore(paths);
    await connectAccount(first, 'me@example.org', '1', 0);
    await first.close();
    const again = await openStore(paths);
    expect(await again.central.select({ id: accounts.id }).from(accounts)).toEqual([{ id: 'me@example.org' }]);
    await again.close();

    const raw = new PGlite(paths.databaseDir);
    await raw.query(`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('from-the-future', $1)`, [Date.UTC(2999, 0)]);
    await raw.close();
    await expect(openStore(paths)).rejects.toThrow('last opened by a newer Sift');
  });

  it('start over in a new database once the old one is moved aside, which is refused while it is open', async () => {
    const paths = { databaseDir: tempDir(), keys: loadKeyring({}) };
    const first = await openStore(paths);
    await connectAccount(first, 'me@example.org', '1', 0);
    expect(() => moveAside(paths.databaseDir)).toThrow(DatabaseInUse);
    await first.close();
    const old = moveAside(paths.databaseDir);
    expect(existsSync(old)).toBe(true);
    const fresh = await openStore(paths);
    expect(await fresh.central.select({ id: accounts.id }).from(accounts)).toEqual([]);
    await fresh.close();
  });

  it('move Workflow’s runs aside with the database on sift reset-db: they name the old one’s people and mailboxes', () => {
    const home = tempDir();
    vi.stubEnv('SIFT_HOME', home);
    mkdirSync(join(home, 'database'));
    mkdirSync(join(home, 'workflow'));
    resetDb();
    vi.unstubAllEnvs();
    expect(readdirSync(home).filter((name) => name.startsWith('database') || name.startsWith('workflow'))).toEqual([
      expect.stringMatching(/^database\.\d{4}-/),
      expect.stringMatching(/^workflow\.\d{4}-/),
    ]);
  });

  it('refuse a database made by migrations since replaced, rather than run them again over it', async () => {
    const paths = { databaseDir: tempDir(), keys: loadKeyring({}) };
    await (await openStore(paths)).close();
    const raw = new PGlite(paths.databaseDir);
    await raw.query(`UPDATE drizzle.__drizzle_migrations SET hash = 'replaced' WHERE id = 1`);
    await raw.close();
    await expect(openStore(paths)).rejects.toThrow('sift reset-db');
  });
});

describe('a Postgres address', () => {
  it('names verify-full for every SSL mode pg treats as it, so pg 9 cannot stop checking the certificate', () => {
    const at = (query: string) => `postgres://app:p%40ss@db.example.com/sift${query}`;
    for (const mode of ['prefer', 'require', 'verify-ca'])
      expect(verified(at(`?sslmode=${mode}&channel_binding=require`))).toBe(at('?sslmode=verify-full&channel_binding=require'));
    for (const query of ['', '?sslmode=disable', '?sslmode=no-verify', '?sslmode=verify-full', '?uselibpqcompat=true&sslmode=require'])
      expect(verified(at(query))).toBe(at(query));
  });
});

describe("a person's data", () => {
  it('is in tables that hold every query to row-level security, the owner included', async () => {
    const { central } = await freshStore();
    const tables = await raw(central).all<{ name: string; enabled: boolean; forced: boolean; policies: number; person: boolean }>(
      `SELECT c.relname AS name, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced,
              (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'user_id') AS person
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN ('users', 'accounts')`,
    );
    expect(tables.length).toBeGreaterThan(10);
    for (const table of tables) expect(table, table.name).toMatchObject({ enabled: true, forced: true, policies: 1, person: true });
  });

  it('is seen and written only through that person, never through anyone else or nobody', async () => {
    const store = await freshStore();
    const alphaId = await connectAccount(store, 'alpha@example.org', '1', 0);
    const alpha = await store.user(alphaId);
    const bravo = await store.user(await connectAccount(store, 'bravo@example.net', '1', 0));
    await raw(alpha).run(
      `INSERT INTO correspondents (account_id, address_hash, domain_hash, user_has_written, checked_at) VALUES ('alpha@example.org', 'x@example.com', 'example.com', true, 0)`,
    );

    expect(await raw(alpha).all('SELECT address_hash FROM correspondents')).toEqual([{ address_hash: 'x@example.com' }]);
    for (const other of [bravo, store.central, store.nobody]) {
      expect(await raw(other).all('SELECT address_hash FROM correspondents')).toEqual([]);
      expect(await raw(other).all('SELECT id FROM mailboxes WHERE id = ?', 'alpha@example.org')).toEqual([]);
    }
    // Nor can a person write a row as someone else, into someone else's mailbox, or over their rows.
    await expect(raw(bravo).run('INSERT INTO credentials (user_id, kind, key, value) VALUES (?, ?, ?, ?)', alphaId, 'model', 'openai', 'x')).rejects.toThrow(
      'row-level security',
    );
    await expect(
      raw(bravo).run(
        `INSERT INTO correspondents (account_id, address_hash, domain_hash, user_has_written, checked_at) VALUES ('alpha@example.org', 'y@example.com', 'example.com', true, 0)`,
      ),
    ).rejects.toThrow();
    expect(await raw(bravo).run('UPDATE correspondents SET user_has_written = false')).toEqual({ changes: 0 });
    expect(await raw(alpha).get('SELECT user_has_written FROM correspondents')).toEqual({ user_has_written: true });
    // Without a person, nothing of anyone's can be written.
    await expect(raw(store.central).run('INSERT INTO preferences DEFAULT VALUES')).rejects.toThrow();
  });

  it("goes with them when they are deleted, and no one else's does", async () => {
    const store = await freshStore();
    const alpha = await connectAccount(store, 'alpha@example.org', '1', 0);
    const bravo = await connectAccount(store, 'bravo@example.net', '1', 0);
    await recordEverything(await store.user(alpha), 'alpha@example.org');
    await recordEverything(await store.user(bravo), 'bravo@example.net');
    const before = await rowsBy('user_id');
    expect(Object.keys(before).length).toBeGreaterThan(10);
    for (const [name, counts] of Object.entries(before)) expect(Object.keys(counts), name).toEqual([String(alpha), String(bravo)]);

    await deleteUser(store, alpha);
    const after = await rowsBy('user_id');
    for (const [name, counts] of Object.entries(before)) expect(after[name], name).toEqual({ [bravo]: counts[bravo] });
    expect((await (await superuser()).query('SELECT id, owner FROM users')).rows).toEqual([{ id: bravo, owner: true }]);
  });
});

describe("a mailbox's data", () => {
  it('is in tables that each have a key to the mailbox that deletes the row with it', async () => {
    const { rows } = await (
      await superuser()
    ).query<{ name: string; cascades: boolean }>(
      `SELECT c.relname AS name,
              EXISTS (SELECT 1 FROM pg_constraint k
                      WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confrelid = 'mailboxes'::regclass AND k.confdeltype = 'c'
                        AND (SELECT array_agg(a.attname::text ORDER BY a.attname) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum = ANY (k.conkey))
                            = ARRAY['account_id', 'user_id']) AS cascades
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'account_id')
       ORDER BY 1`,
    );
    expect(rows.length).toBeGreaterThan(10);
    for (const row of rows) expect(row, row.name).toEqual({ name: row.name, cascades: true });
  });

  it('goes with it when it is removed, with its sign-in, and nothing of another mailbox does', async () => {
    const { store } = await onePerson('alpha@example.org', 'alpha@work.example.com');
    const bravo = await connectAccount(store, 'bravo@example.net', '1', 0);
    const alpha = await store.user(1);
    await recordEverything(alpha, 'alpha@example.org');
    await recordEverything(alpha, 'alpha@work.example.com');
    await recordEverything(await store.user(bravo), 'bravo@example.net');
    const before = await rowsBy('account_id');
    expect(Object.keys(before).length).toBeGreaterThan(10);

    expect(await removeMailbox(store, bravo, 'alpha@work.example.com')).toBe(false);
    expect(await rowsBy('account_id')).toEqual(before);
    expect(await removeMailbox(store, 1, 'alpha@work.example.com')).toBe(true);
    const after = await rowsBy('account_id');
    for (const [name, counts] of Object.entries(before)) {
      const { ['alpha@work.example.com']: gone, ...rest } = counts;
      expect(gone, name).toBeGreaterThan(0);
      expect(after[name], name).toEqual(rest);
    }
    expect(await raw(alpha).all(`SELECT key FROM credentials WHERE kind = 'gmail' ORDER BY key`)).toEqual([{ key: 'alpha@example.org' }]);
    expect(await connectedAddresses(store.central)).toEqual(['alpha@example.org', 'bravo@example.net']);
  });
});

describe('a primary mailbox', () => {
  const primaryOf = async (central: Sql, person: number) => (await mailboxesOf(central, person)).find((m) => m.primary)?.id;
  it('is the first one a person connects, is theirs to change, and goes to the one connected longest when removed', async () => {
    const store = await freshStore();
    const alpha = await connectAccount(store, 'alpha@example.org', '1', 0);
    await connectAccount(store, 'alpha@work.example.com', '1', 10, alpha);
    await connectAccount(store, 'alpha@club.example.com', '1', 5, alpha);
    const bravo = await connectAccount(store, 'bravo@example.net', '1', 20);
    expect([await primaryOf(store.central, alpha), await primaryOf(store.central, bravo)]).toEqual(['alpha@example.org', 'bravo@example.net']);

    expect(await makePrimary(store.central, bravo, 'alpha@work.example.com')).toBe(false);
    expect(await makePrimary(store.central, alpha, 'alpha@work.example.com')).toBe(true);
    expect(await primaryOf(store.central, alpha)).toBe('alpha@work.example.com');
    expect(await primaryOf(store.central, bravo)).toBe('bravo@example.net');

    // Removing another leaves it; removing it hands it on, by when each was connected rather than by address.
    await removeMailbox(store, alpha, 'alpha@example.org');
    await makePrimary(store.central, alpha, 'alpha@work.example.com');
    await connectAccount(store, 'alpha@a.example.com', '1', 30, alpha);
    expect(await primaryOf(store.central, alpha)).toBe('alpha@work.example.com');
    await removeMailbox(store, alpha, 'alpha@work.example.com');
    expect(await primaryOf(store.central, alpha)).toBe('alpha@club.example.com');
  });

  it('is given by a migration to the earliest connected mailbox of each person without one', async () => {
    const store = await freshStore();
    const alpha = await connectAccount(store, 'alpha@example.org', '1', 10);
    await connectAccount(store, 'alpha@work.example.com', '1', 5, alpha);
    const bravo = await connectAccount(store, 'bravo@example.net', '1', 20);
    await connectAccount(store, 'bravo@work.example.net', '1', 30, bravo);
    await makePrimary(store.central, bravo, 'bravo@work.example.net');
    await raw(store.central).run(`UPDATE accounts SET "primary" = false WHERE user_id = ?`, alpha);
    const migration = readFileSync(new URL('0040_every_person_has_a_primary_mailbox.sql', MIGRATIONS), 'utf8');
    await (await superuser()).exec(migration);
    await (await superuser()).exec(migration);
    expect([await primaryOf(store.central, alpha), await primaryOf(store.central, bravo)]).toEqual(['alpha@work.example.com', 'bravo@work.example.net']);
  });
});

describe("a mailbox's number", () => {
  it('is given by a migration to every mailbox connected before mailboxes had one, each its own', async () => {
    const { db, run } = await migratedBefore('0050_mailboxes_have_numbers');
    await db.exec(`
      INSERT INTO users (id, owner, created_at) VALUES (1, true, 0), (2, false, 0);
      INSERT INTO accounts (id, user_id, created_at, "primary") VALUES ('a@example.org', 1, 0, true), ('a@work.example.com', 1, 1, false), ('b@example.net', 2, 2, true);
      INSERT INTO mailboxes (user_id, id) VALUES (1, 'a@example.org'), (1, 'a@work.example.com'), (2, 'b@example.net');
    `);
    await run('0050_mailboxes_have_numbers');
    const numbers = (await db.query<{ number: number }>('SELECT number FROM mailboxes')).rows.map((row) => row.number);
    expect(numbers).toHaveLength(3);
    expect(new Set(numbers).size).toBe(3);
  });
});

describe('a message', () => {
  it('decided before messages said so is marked decided by a migration, as a Postgres server runs it', async () => {
    const { db, run } = await migratedBefore('0054_mail_already_decided');
    await db.exec(`
      INSERT INTO users (id, owner, created_at) VALUES (1, true, 0), (2, false, 0);
      INSERT INTO accounts (id, user_id, created_at, "primary") VALUES ('a@example.org', 1, 0, true), ('b@example.net', 2, 0, true);
      INSERT INTO mailboxes (user_id, id) VALUES (1, 'a@example.org'), (2, 'b@example.net');
      INSERT INTO messages (user_id, account_id, id, thread_id, sender_hash, domain_hash, received_at, headers, synced_at, facts) VALUES
        (1, 'a@example.org', 'decided', 't', 's', 'd', 0, 'h', 0, '{}'), (1, 'a@example.org', 'waiting', 't', 's', 'd', 0, 'h', 0, '{}'),
        (2, 'b@example.net', 'decided', 't', 's', 'd', 0, 'h', 0, '{}');
      INSERT INTO decisions (user_id, account_id, message_id, stage, disposition, subscription, reason, decided_at) VALUES
        (1, 'a@example.org', 'decided', 'rules', 'keep', 'preserve', 'r', 1), (2, 'b@example.net', 'decided', 'rules', 'keep', 'preserve', 'r', 1);
    `);
    await run('0054_mail_already_decided');
    expect((await db.query('SELECT user_id, id, decided FROM messages ORDER BY user_id, id')).rows).toEqual([
      { user_id: 1, id: 'decided', decided: true },
      { user_id: 1, id: 'waiting', decided: false },
      { user_id: 2, id: 'decided', decided: true },
    ]);
  });
});

describe('Inbox turned on before it copied all mail', () => {
  it('starts copying a year of every mailbox of whoever has it on, by a migration, as a Postgres server runs it', async () => {
    const { db, run } = await migratedBefore('0066_inbox_copies_mail_row_security');
    await db.exec(`
      INSERT INTO users (id, owner, created_at) VALUES (1, true, 0), (2, false, 0);
      INSERT INTO accounts (id, user_id, created_at, "primary") VALUES ('a@example.org', 1, 0, true), ('a@work.example.com', 1, 1, false), ('b@example.net', 2, 2, true);
      INSERT INTO mailboxes (user_id, id) VALUES (1, 'a@example.org'), (1, 'a@work.example.com'), (2, 'b@example.net');
      INSERT INTO preferences (user_id, mail) VALUES (1, true), (2, false);
    `);
    await run('0066_inbox_copies_mail_row_security');
    const rows = (
      await db.query<{ user_id: number; account_id: string; year: boolean }>(
        `SELECT user_id, account_id, before - since = 31536000000 AND finished_at IS NULL AS year FROM mail_copies ORDER BY account_id`,
      )
    ).rows;
    expect(rows).toEqual([
      { user_id: 1, account_id: 'a@example.org', year: true },
      { user_id: 1, account_id: 'a@work.example.com', year: true },
    ]);
  });
});

describe('the text Sift read', () => {
  it('kept while mail waited is kept as read text by a migration, as a Postgres server runs it, held to its person', async () => {
    const { db, run } = await migratedBefore('0070_read_text_is_kept_thirty_days');
    await db.exec(`
      INSERT INTO users (id, owner, created_at) VALUES (1, true, 0);
      INSERT INTO accounts (id, user_id, created_at, "primary") VALUES ('a@example.org', 1, 0, true);
      INSERT INTO mailboxes (user_id, id) VALUES (1, 'a@example.org');
      INSERT INTO messages (user_id, account_id, id, thread_id, sender_hash, domain_hash, received_at, headers, synced_at, facts) VALUES
        (1, 'a@example.org', 'waiting', 't', 's', 'd', 0, 'h', 0, '{}');
      INSERT INTO suggestion_bodies (user_id, account_id, message_id, body_text, fetched_at) VALUES (1, 'a@example.org', 'waiting', 'sealed', 5);
    `);
    await run('0070_read_text_is_kept_thirty_days');
    expect((await db.query('SELECT user_id, message_id, body_text, fetched_at FROM read_bodies')).rows).toEqual([
      { user_id: 1, message_id: 'waiting', body_text: 'sealed', fetched_at: 5 },
    ]);
    expect((await db.query(`SELECT relforcerowsecurity AS forced FROM pg_class WHERE relname = 'read_bodies'`)).rows).toEqual([{ forced: true }]);
  });
});

describe('a model call', () => {
  it('made before calls said which rule they checked is given the rule whose condition it met, by a migration', async () => {
    // On a Postgres server row-level security hid every row from it, so only a machine's install was given them.
    const { db, run } = await migratedBefore('0045_rule_runs_from_decisions', { asSuperuser: true });
    await db.exec(`
      INSERT INTO users (id, owner, created_at) VALUES (1, true, 0);
      INSERT INTO accounts (id, user_id, created_at, "primary") VALUES ('a@example.org', 1, 0, true);
      INSERT INTO mailboxes (user_id, id) VALUES (1, 'a@example.org');
      INSERT INTO labels (user_id, account_id, id, name, description, disposition, gmail_label, position) VALUES (1, 'a@example.org', 'news', 'News', '', 'archive', 'sift/news', 0);
      INSERT INTO messages (user_id, account_id, id, thread_id, sender_hash, domain_hash, received_at, headers, synced_at, facts) VALUES
        (1, 'a@example.org', 'a', 't', 's', 'd', 0, 'h', 0, '{}'), (1, 'a@example.org', 'b', 't', 's', 'd', 0, 'h', 0, '{}');
      INSERT INTO rules (user_id, id, account_id, position, match, except_matches, conditions, label_id, condition, source, created_at) VALUES
        (1, 'checked', 'a@example.org', 1, 'm', 'e', 'c1', 'news', 'a sale', 'user', 0);
      INSERT INTO rules (user_id, id, account_id, position, match, except_matches, conditions, when_label, disposition, source, created_at) VALUES
        (1, 'waits', 'a@example.org', 2, 'm', 'e', 'c2', 'news', 'archive', 'user', 0);
      INSERT INTO model_runs (user_id, id, account_id, message_id, model, started_at) VALUES (1, 1, 'a@example.org', 'a', 'm', 2), (1, 2, 'a@example.org', 'b', 'm', 2);
      INSERT INTO decisions (user_id, id, account_id, message_id, stage, disposition, subscription, rule_id, reason, run_id, decided_at) VALUES
        (1, 1, 'a@example.org', 'a', 'model', 'keep', 'preserve', 'checked', 'r', 1, 3), (1, 2, 'a@example.org', 'b', 'model', 'keep', 'preserve', 'waits', 'r', 2, 3);
    `);
    await run('0045_rule_runs_from_decisions');
    await run('0045_rule_runs_from_decisions');
    expect((await db.query('SELECT id, rule_id FROM model_runs ORDER BY id')).rows).toEqual([
      { id: 1, rule_id: 'checked' },
      // A rule that waits for a label asks no model a question of its own.
      { id: 2, rule_id: null },
    ]);
  });
});

describe('a proposal', () => {
  it('names what the rule it proposes would do', async () => {
    const { db } = await onePerson('alpha@example.org');
    const propose = (disposition: string | null) =>
      raw(db).run(
        `INSERT INTO proposals (account_id, match, conditions, label_id, disposition, agreed, created_at) VALUES ('alpha@example.org', '{}', 'c', 'newsletter', ?, 2, 0)`,
        disposition,
      );
    await expect(propose(null)).rejects.toThrow();
    await expect(propose('review')).rejects.toThrow();
    await propose('keep');
  });
});

describe('a person', () => {
  it('starts with Leave in inbox alone, once, and keeps their labels when a mailbox is connected again', async () => {
    const store = await freshStore();
    const db = await store.user(await connectAccount(store, 'alpha@example.org', '1', 0));
    expect(await listLabels(db)).toEqual([{ id: 'everything_else', name: 'Leave in inbox', description: '', disposition: 'keep' }]);
    await withSampleLabels(db);
    await updateLabel(db, 'newsletter', { name: 'Reading' });
    await connectAccount(store, 'alpha@example.org', '9', 5);
    await addMailbox(db, 'alpha@example.org', '10');
    expect((await listLabels(db)).map((l) => l.name)).toContain('Reading');
    // Leave in inbox is listed after the person's own; the page puts it first.
    expect((await listLabels(db)).at(-1)?.id).toBe('everything_else');
    // A store opened afresh puts back a mailbox missing from a person's database; their labels were never its.
    await raw(db).run('DELETE FROM mailboxes');
    const reopened = await storeOn(pglite(await superuser()), loadKeyring({})).user(1);
    expect((await listAccounts(reopened)).map((m) => m.id)).toEqual(['alpha@example.org']);
    expect((await listLabels(reopened)).map((l) => l.name)).toContain('Reading');
  });

  it("has one set of labels and rules for every mailbox of theirs, and none of anyone else's", async () => {
    const store = await freshStore();
    const person = await connectAccount(store, 'alpha@example.org', '1', 0);
    const db = await store.user(person);
    await withSampleLabels(db);
    const rule = await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    await connectAccount(store, 'beta@example.org', '1', 0, person);
    expect((await listLabels(db)).filter((l) => l.id === 'newsletter')).toHaveLength(1);
    expect((await listRules(db)).map((r) => r.id)).toEqual([rule]);
    // Removing a mailbox leaves them.
    await removeMailbox(store, person, 'beta@example.org');
    expect((await listRules(db)).map((r) => r.id)).toEqual([rule]);
    const other = await store.user(await connectAccount(store, 'gamma@example.org', '1', 0));
    expect((await listLabels(other)).map((l) => l.id)).toEqual(['everything_else']);
    expect(await listRules(other)).toEqual([]);
  });

  it("had each mailbox's labels and rules made one set by a migration, the primary mailbox's first", async () => {
    const { db, run, after } = await migratedBefore('0048_labels_and_rules_are_the_persons');
    // One person with two mailboxes, the later one primary, as before 0048.
    await db.exec(`
      INSERT INTO users (id, owner, created_at) VALUES (1, true, 0);
      INSERT INTO accounts (id, user_id, created_at, "primary") VALUES ('a@example.org', 1, 0, false), ('b@example.org', 1, 1, true);
      INSERT INTO mailboxes (user_id, id) VALUES (1, 'a@example.org'), (1, 'b@example.org');
      INSERT INTO labels (user_id, account_id, id, name, description, disposition, gmail_label, position) VALUES
        (1, 'a@example.org', 'everything_else', 'Leave in inbox', '', 'keep', NULL, 30),
        (1, 'b@example.org', 'everything_else', 'Leave in inbox', '', 'keep', NULL, 30),
        (1, 'a@example.org', 'news', 'News', 'from a', 'archive', 'sift/news', 0),
        (1, 'b@example.org', 'news', 'News', 'from b', 'keep', 'sift/news', 0),
        (1, 'a@example.org', 'reading', 'Bills', 'renamed', 'keep', 'sift/reading', 1),
        (1, 'b@example.org', 'bills', 'Bills', 'its own', 'keep', 'sift/bills', 1),
        (1, 'a@example.org', 'trips', 'Trips', '', 'archive', 'sift/trips', 2);
      INSERT INTO rules (user_id, id, account_id, position, match, except_matches, conditions, label_id, source, hits, created_at, filter_id, filter_state, filter_written, filter_checked_at) VALUES
        (1, 'r-a1', 'a@example.org', 1, 'm', 'e', 'same', 'news', 'user', 2, 0, 'gmail-a', 'active', 'w', 5),
        (1, 'r-b1', 'b@example.org', 1, 'm', 'e', 'same', 'news', 'user', 3, 0, 'gmail-b', 'active', 'w', 5),
        (1, 'r-a2', 'a@example.org', 2, 'm', 'e', 'other', 'reading', 'user', 0, 0, NULL, NULL, NULL, NULL);
    `);
    await run('0048_labels_and_rules_are_the_persons');
    await run(after);
    const labelRows = (await db.query<{ id: string; description: string; position: number }>('SELECT id, description, position FROM labels ORDER BY position'))
      .rows;
    // The primary mailbox's wins where they differ, and two labels with one name are one.
    expect(labelRows).toEqual([
      { id: 'news', description: 'from b', position: 0 },
      { id: 'bills', description: 'its own', position: 1 },
      { id: 'trips', description: '', position: 3 },
      { id: 'everything_else', description: '', position: 30 },
    ]);
    // Rules that said the same are one, with both counts; one naming the label merged away names the one kept.
    const ruleRows = (await db.query<{ id: string; label_id: string; hits: number }>('SELECT id, label_id, hits FROM rules ORDER BY position')).rows;
    expect(ruleRows).toEqual([
      { id: 'r-b1', label_id: 'news', hits: 5 },
      { id: 'r-a2', label_id: 'bills', hits: 0 },
    ]);
    // Each mailbox's Gmail filter stays its own, where its rule was kept.
    expect((await db.query('SELECT rule_id, account_id, filter_id FROM rule_filters')).rows).toEqual([
      { rule_id: 'r-b1', account_id: 'b@example.org', filter_id: 'gmail-b' },
    ]);
    // Row-level security holds the owner again afterwards.
    expect((await db.query(`SELECT relname FROM pg_class WHERE relrowsecurity AND NOT relforcerowsecurity AND relkind = 'r'`)).rows).toEqual([]);
  });

  it('had Everything Else become Leave in inbox by a migration', async () => {
    const { db } = await onePerson('alpha@example.org');
    await raw(db).run(
      `UPDATE labels SET name = 'Everything Else', description = 'Mail that is plainly none of the other labels.' WHERE id = 'everything_else'`,
    );
    // Its old default said nothing of the person's, so it goes; what they wrote stays theirs.
    const renamed = readFileSync(new URL('0034_leave_in_inbox.sql', MIGRATIONS), 'utf8');
    await (await superuser()).exec(renamed);
    expect((await listLabels(db)).at(-1)).toEqual({ id: 'everything_else', name: 'Leave in inbox', description: '', disposition: 'keep' });
    await raw(db).run(`UPDATE labels SET name = 'The rest', description = 'Bills I still owe.' WHERE id = 'everything_else'`);
    await (await superuser()).exec(renamed);
    expect((await listLabels(db)).at(-1)).toMatchObject({ name: 'Leave in inbox', description: 'Bills I still owe.' });
    // Then it stops being the person's to write in at all.
    await (await superuser()).exec(readFileSync(new URL('0037_leave_in_inbox_is_fixed.sql', MIGRATIONS), 'utf8'));
    expect((await listLabels(db)).at(-1)).toMatchObject({ name: 'Leave in inbox', description: '' });
  });

  it('turns a rule made before that only keeps mail into Leave in inbox, and leaves one with an extra', async () => {
    const { db } = await onePerson('alpha@example.org');
    const trusted = await addRule(db, { match: { from: ['ada@example.org'] }, disposition: 'archive' }, 'user');
    const read = await addRule(db, { match: { from: ['digest@example.com'] }, disposition: 'archive', markRead: true }, 'user');
    // As they were stored before: an action that keeps, with no label.
    await raw(db).run(`UPDATE rules SET disposition = 'keep'`);
    await (await superuser()).exec(readFileSync(new URL('0035_leave_in_inbox_rules.sql', MIGRATIONS), 'utf8'));
    const rules = await listRules(db);
    expect(rules.find((r) => r.id === trusted)).toMatchObject({ labelId: 'everything_else' });
    expect(rules.find((r) => r.id === trusted)).not.toHaveProperty('disposition');
    expect(rules.find((r) => r.id === read)).toMatchObject({ disposition: 'keep', markRead: true });
    expect(rules.find((r) => r.id === read)).not.toHaveProperty('labelId');
  });

  it('needs its labels to exist for anything that names one', async () => {
    const { db } = await onePerson('alpha@example.org');
    await recordSync(db, 'alpha@example.org', [facts({ accountId: 'alpha@example.org', messageId: 'm1' })], '2', 0);
    await expect(
      recordDecision(db, 'alpha@example.org', 'm1', { disposition: 'archive', subscription: 'preserve', stage: 'model', labelId: 'nonsense', reason: 'r' }),
    ).rejects.toThrow();
    await expect(
      raw(db).run(
        `INSERT INTO rules (id, position, match, except_matches, conditions, when_label, source, created_at) VALUES ('r', 0, '{}', '[]', 'c', 'nonsense', 'user', 0)`,
      ),
    ).rejects.toThrow();
  });
});

describe('the database in the home directory', () => {
  it('is refused to a second opener while the first has it, and free again once closed', async () => {
    const paths = { databaseDir: tempDir(), keys: loadKeyring({}) };
    const first = await openStore(paths);
    await expect(openStore(paths)).rejects.toThrow(`Another Sift (process ${process.pid}) has the database open`);
    await first.close();
    await (await openStore(paths)).close();
  });
});

describe("a person's handle", () => {
  it('sends what holds a statement to its person with BEGIN, so it costs no round trip of its own', async () => {
    const driver = pglite(await superuser());
    const openings: string[] = [];
    const sent: string[] = [];
    const store = storeOn(
      {
        ...driver,
        transaction: (opening, work) => {
          openings.push(opening);
          return driver.transaction(opening, (c) => work({ query: (text, params, array) => (sent.push(text), c.query(text, params, array)) }));
        },
      },
      loadKeyring({}),
    );
    const person = await connectAccount(store, 'one@example.com', '1', 0);
    const other = await connectAccount(store, 'two@example.com', '1', 0);
    const db = await store.user(person);
    await (await store.user(other)).transaction(async (tx) => await tx.update(labels).set({ name: 'Theirs' }));
    openings.length = sent.length = 0;

    expect((await listLabels(db)).map((l) => l.name)).toEqual(['Leave in inbox']);
    expect(openings).toEqual([`SET LOCAL ROLE sift_app; SELECT set_config('sift.user', '${person}', true)`]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^select /);
  });
});

describe('the role sift connects to a server as', () => {
  it('is named when it could pass row-level security', async () => {
    const pg = await superuser();
    // In a transaction rolled back after, so the roles and table go with it.
    const as = async (setup: string, role: string | null) =>
      await pg.transaction(async (tx) => {
        await tx.exec(setup);
        if (role) await tx.exec(`SET LOCAL ROLE ${role}`);
        const found = await roleBypass(async (text) => (await tx.query<Record<string, unknown>>(text)).rows);
        await tx.rollback();
        return found;
      });
    expect(await as('', 'sift_app')).toBeNull();
    expect(await as('CREATE ROLE runner; GRANT sift_app TO runner', 'runner')).toBeNull();
    expect(await as('', null)).toMatch(/^The database role \w+ is a superuser$/);
    expect(await as('CREATE ROLE runner BYPASSRLS', 'runner')).toBe('The database role runner can bypass row-level security');
    expect(await as('CREATE ROLE wide BYPASSRLS; CREATE ROLE runner; GRANT wide TO runner', 'runner')).toMatch(/runner can bypass/);
    const owned = 'CREATE ROLE owner; CREATE TABLE held (x int); ALTER TABLE held ENABLE ROW LEVEL SECURITY; ALTER TABLE held OWNER TO owner';
    expect(await as(`${owned}; CREATE ROLE runner; GRANT owner TO runner`, 'runner')).toBe("The database role runner can act as the tables' owner");
  });

  it('is warned about by the store, for whoever starts sift to be told', async () => {
    const driver = pglite(await superuser());
    expect(storeOn(driver, loadKeyring({})).warning).toBeUndefined();
    expect(storeOn({ ...driver, warning: 'The database role x is a superuser' }, loadKeyring({})).warning).toBe('The database role x is a superuser');
  });
});
