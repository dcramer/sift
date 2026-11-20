import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { readFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer, request } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { type FauxResponseStep, createModels, fauxProvider } from '@earendil-works/pi-ai';
import { afterAll, afterEach, beforeAll, beforeEach, inject, onTestFinished } from 'vitest';
import { type DashboardOptions, createDashboard } from '../src/dashboard/server.ts';
import type { People } from '../src/store/people.ts';
import { PARSERS, pglite } from '../src/store/db.ts';
import type { Sql } from '../src/store/sql.ts';
import { type Store, storeOn } from '../src/store/store.ts';
import { type Keyring, loadKeyring } from '../src/secrets.ts';
import { type Account, connectAccount, listAccounts, recordSync, userOf } from '../src/store/accounts.ts';
import { recordDecision } from '../src/store/decisions.ts';
import { setRuleFilter } from '../src/store/filters.ts';
import { addRule } from '../src/store/rules.ts';
import { addLabels } from '../src/store/labels.ts';
import { rememberCorrespondent } from '../src/store/senders.ts';
import { conditionsHash } from '../src/store/content.ts';
import { finishRun, startRun } from '../src/store/runs.ts';
import type { Usage } from '../src/triage/stages/model.ts';
import type { Decision } from '../src/triage/types.ts';
import { ACCOUNT, tempDir, withSampleLabels } from './helpers.ts';
import { FakeGoogle, SECRETS, serveGoogle } from './google.ts';
import { loadConfig } from '../src/config.ts';
import { clientFor, installClient } from '../src/gmail/auth.ts';
import { createGmailApi } from '../src/gmail/api.ts';
import { createGmailMailbox } from '../src/gmail/mailbox.ts';
import type { ChosenModel } from '../src/model/models.ts';
import { type Sift, createSift } from '../src/sift/sift.ts';
import type { Work } from '../src/work/run.ts';

/*
 * One database per test file, loaded from the image global-setup.ts migrated once for the whole run,
 * and emptied before each test. Tests in a file run one at a time, so a test sees only what it wrote.
 */
let database: Promise<PGlite> | undefined;
let tables: string | undefined;

const loaded = () =>
  (database ??= PGlite.create({ loadDataDir: new Blob([readFileSync(inject('template'))]), parsers: PARSERS }).then(async (pg) => {
    const { rows } = await pg.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`);
    tables = rows.map((r) => `"${r.name}"`).join(', ');
    return pg;
  }));

beforeEach(async () => {
  if (!database) return;
  await (await database).exec(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
});

/** This test's database, as the superuser: for reading what a handle wrote, past row-level security. */
export const superuser = loaded;

/** The store over this test's database. Every call in one test shares the same rows. */
export async function freshStore(keys: Keyring = loadKeyring({})): Promise<Store> {
  const store = storeOn(pglite(await loaded()), keys);
  return { ...store, close: async () => {} };
}

type Value = string | number | bigint | boolean | null | Uint8Array;
/** A value for a `?`, or an object of them for `:name` parameters. */
type Bind = Value | Record<string, Value>;

/** `?`, `?N` and `:name` placeholders as `$n`, outside quoted text and `::` casts. */
export function toPostgres(sql: string): { text: string; names: string[] } {
  let text = '';
  const names: string[] = [];
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      const end = sql.indexOf(c, i + 1);
      text += sql.slice(i, end + 1);
      i = end;
    } else if (c === '?') {
      const numbered = /^\d+/.exec(sql.slice(i + 1))?.[0];
      text += `$${numbered ?? ++n}`;
      i += numbered?.length ?? 0;
    } else if (c === ':' && sql[i + 1] === ':') {
      text += '::';
      i++;
    } else if (c === ':' && /[a-z_]/i.test(sql[i + 1] ?? '')) {
      const name = /^[a-z_]\w*/i.exec(sql.slice(i + 1))![0];
      let at = names.indexOf(name);
      if (at === -1) at = names.push(name) - 1;
      text += `$${at + 1}`;
      i += name.length;
    } else text += c;
  }
  return { text, names };
}

/**
 * What a database with no key holds of an encrypted column, read with `raw`, as the code reads it: the
 * value without the mark that says it is plain. Throws if it has no mark, so a test still sees it is stored as one.
 */
export function unmarked(stored: string): string {
  if (!stored.startsWith('sift-plain:')) throw new Error(`not stored marked plain: ${stored}`);
  return stored.slice('sift-plain:'.length);
}

/** A row read with `raw` with its decision's reason `unmarked`. */
export const withReason = <T>(row: T): T => {
  const r = row as T & { reason?: string };
  return r?.reason === undefined ? row : { ...r, reason: unmarked(r.reason) };
};

/**
 * SQL text run as `db`'s person, held to row-level security as sift's own queries are: for a test to set
 * up rows or read back what was stored. `?` placeholders, or `:name` ones given one object.
 */
export function raw(db: Sql) {
  const query = async (text: string, params: Bind[]) => {
    const { text: statement, names } = toPostgres(text);
    const args = names.length === 0 ? params : names.map((name) => (params[0] as Record<string, Bind>)[name]);
    return await (
      await loaded()
    ).transaction(async (tx) => {
      await tx.query('SET LOCAL ROLE sift_app');
      if (db.person !== null) await tx.query(`SELECT set_config('sift.user', $1, true)`, [String(db.person)]);
      return await tx.query<Record<string, unknown>>(statement, args);
    });
  };
  return {
    get: async <T = Record<string, unknown>>(text: string, ...params: Bind[]) => (await query(text, params)).rows[0] as T | undefined,
    all: async <T = Record<string, unknown>>(text: string, ...params: Bind[]) => (await query(text, params)).rows as T[],
    run: async (text: string, ...params: Bind[]) => ({ changes: (await query(text, params)).affectedRows ?? 0 }),
  };
}

/** A new person's own database, with these mailboxes connected as they would be by signing in. */
export async function openUserDb(...accounts: string[]): Promise<Sql> {
  const store = await freshStore();
  if (accounts.length === 0) {
    const created = await raw(store.central).get<{ id: number }>('INSERT INTO users (owner, created_at) VALUES (false, 0) RETURNING id');
    return await store.user(created!.id);
  }
  return (await onePerson(...accounts)).db;
}

type Dashboard = Awaited<ReturnType<typeof startDashboard>>;

export type Reply = { status: number; text: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> };

/**
 * `handle` over `node:http`, as Next.js hands a route handler a request: the URL's scheme is the one a proxy
 * forwarded, believed or not by the dashboard's `forwarded`.
 */
function listener(handle: (request: Request) => Promise<Response>) {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const headers = new Headers();
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
    const scheme = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const body = req.method === 'GET' || req.method === 'HEAD' ? null : Readable.toWeb(req);
    void handle(new Request(new URL(req.url ?? '/', `${scheme}://localhost`), { method: req.method ?? 'GET', headers, body, duplex: 'half' })).then(
      async (response) => {
        const cookies = response.headers.getSetCookie();
        res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}) });
        res.end(Buffer.from(await response.arrayBuffer()));
      },
    );
  });
}

/**
 * The dashboard on a free port, stopped when the test ends. `call` sends a request as the page would:
 * a write carries the page's own origin and header unless `headers` says otherwise. A string body is
 * sent as it is.
 */
export async function startDashboard(people: People, options: DashboardOptions = {}) {
  const dashboard = createDashboard(people, { now: () => 77, ephemeral: memoryEphemeral(), ...options });
  const server = listener(dashboard.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onTestFinished(() => void server.close());
  const port = (server.address() as AddressInfo).port;
  const call = (method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) =>
    new Promise<Reply>((resolve, reject) => {
      const own = method === 'POST' ? { origin: `http://localhost:${port}`, 'content-type': 'application/json', 'x-sift': '1' } : {};
      const req = request({ host: '127.0.0.1', port, path, method, headers: { host: `localhost:${port}`, ...own, ...headers } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += String(chunk)));
        res.on('end', () => {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            parsed = { text };
          }
          resolve({ status: res.statusCode ?? 0, text, body: parsed, headers: res.headers });
        });
      });
      req.on('error', reject);
      req.end(body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body));
    });
  return { port, base: `http://127.0.0.1:${port}`, call, handle: dashboard.handle };
}

/**
 * Sign in as `who` on `start`, given `codeSignIn`, and come back from Google to `back`. Returns the callback's
 * reply, whose cookie is the session when it signed the browser in.
 */
export async function googleSignIn(start: Pick<Dashboard, 'call'>, who: string, back = start): Promise<Reply> {
  const login = await start.call('GET', '/auth/login');
  const state = new URL(String(login.headers['location'])).searchParams.get('state');
  const started = String(login.headers['set-cookie']).split(';')[0]!;
  return await back.call('GET', `/auth/callback?state=${state}&code=${encodeURIComponent(who)}`, undefined, { cookie: started });
}

/** A store whose one person, the owner, has `accounts`; and that person's own database. */
export const onePerson = (...accounts: string[]) => personWith(loadKeyring({}), ...accounts);

/** `onePerson`, with the store's keys `keys`, so what is sealed is encrypted and hashes are hashes. */
export async function personWith(keys: Keyring, ...accounts: string[]): Promise<{ store: Store; db: Sql }> {
  const store = await freshStore(keys);
  let user: number | undefined;
  for (const account of accounts) user = await connectAccount(store, account, '1', 0, user);
  const db = await store.user(user ?? 1);
  if (accounts.length > 0) await withSampleLabels(db);
  return { store, db };
}

export const firstAccount = async (db: Sql): Promise<Account> => (await listAccounts(db))[0]!;

/** A model call about a message, started and finished at `at`. Returns its id. */
export async function modelRun(
  db: Sql,
  {
    accountId = ACCOUNT,
    messageId,
    model = 'test/model',
    ruleId,
    at,
    usage,
    error,
  }: {
    accountId?: string;
    messageId: string;
    model?: string;
    ruleId?: string;
    at: number;
    usage?: Usage;
    error?: string;
  },
): Promise<number> {
  const run = await startRun(db, { accountId, messageId, model, ruleId, now: at });
  await finishRun(db, run, { error, usage, now: at });
  return run;
}

/**
 * A row in every table of a person's data that a mailbox can have one in, for `account` (connected, in
 * `db`): what deleting a mailbox or a person must take with it. Its message is `m-<account>`.
 */
export async function recordEverything(db: Sql, account: string): Promise<void> {
  await withSampleLabels(db);
  const message = `m-${account}`;
  await recordSync(
    db,
    account,
    [
      {
        accountId: account,
        messageId: message,
        threadId: 't1',
        from: { address: 'news@example.com', domain: 'example.com' },
        to: [],
        cc: [],
        subject: 'Weekly digest',
        labelIds: ['INBOX'],
        headers: {},
        receivedAt: 0,
      },
    ],
    '2',
    0,
  );
  const decision = await recordDecision(db, account, message, {
    disposition: 'archive',
    subscription: 'preserve',
    stage: 'model',
    labelId: 'newsletter',
    reason: 'r',
  });
  const rule = await addRule(db, { match: { from: ['news@example.com'] }, whenLabel: 'newsletter' }, 'user', 0);
  await setRuleFilter(db, rule, account, { filterId: 'f-1', state: 'active', written: null }, 0);
  await rememberCorrespondent(db, account, 'news@example.com', true, 0);
  const { id: run } = (await raw(db).get<{ id: number }>(
    `INSERT INTO eval_runs (account_id, started_at, status, model, prompt_hash, labels_hash, labels, few_shot, total)
     VALUES (?, 0, 'done', 'p/m', 'h', 'h', '[]', false, 1) RETURNING id`,
    account,
  ))!;
  for (const [statement, ...params] of [
    [`INSERT INTO credentials (kind, key, value) VALUES ('gmail', ?, 'x')`, account],
    [
      `INSERT INTO actions (account_id, message_id, type, payload, original_labels, status, created_at, decision_id) VALUES (?, ?, 'archive', '{}', '[]', 'done', 0, ?)`,
      account,
      message,
      decision,
    ],
    [
      `INSERT INTO proposals (account_id, match, conditions, label_id, disposition, agreed, created_at) VALUES (?, '{"from": ["a@example.com"]}', ?, 'newsletter', 'keep', 2, 0)`,
      account,
      conditionsHash(db, { from: ['a@example.com'] }),
    ],
    [
      `INSERT INTO feedback (account_id, decision_id, verdict, disposition, label_id, via, created_at) VALUES (?, ?, 'right', 'archive', 'newsletter', 'dashboard', 0)`,
      account,
      decision,
    ],
    [`INSERT INTO examples (account_id, message_id, label_id, marked_at) VALUES (?, ?, 'newsletter', 0)`, account, message],
    [`INSERT INTO read_bodies (account_id, message_id, body_text, fetched_at) VALUES (?, ?, 'Hello.', 0)`, account, message],
    [`INSERT INTO mail_bodies (account_id, message_id, body_text, fetched_at) VALUES (?, ?, 'Hello.', 0)`, account, message],
    [`INSERT INTO model_runs (account_id, message_id, model, started_at, error) VALUES (?, ?, 'p/m', 0, 'e')`, account, message],
    [`INSERT INTO label_proposals (account_id, started_at, model, goal) VALUES (?, 0, 'p/m', 'g')`, account],
    [`INSERT INTO rule_drafts (account_id, started_at, model, goal) VALUES (?, 0, 'p/m', 'g')`, account],
    [`INSERT INTO mail_asks (account_id, started_at, model, words) VALUES (?, 0, 'p/m', 'w')`, account],
    [`INSERT INTO inbox_runs (account_id, started_at, acts, most) VALUES (?, 0, false, 10)`, account],
    [`INSERT INTO mail_copies (account_id, before, started_at) VALUES (?, 0, 0)`, account],
    [
      `INSERT INTO digests (label_id, account_id, since, until, message_id, count, created_at) VALUES ('newsletter', ?, 0, 1, ?, 1, 0)`,
      account,
      `<digest.${account}@sift.invalid>`,
    ],
    [
      `INSERT INTO eval_results (run_id, message_id, expected, got, duration_ms, shots, sender_shots) VALUES (?, ?, 'newsletter', 'newsletter', 1, 0, 0)`,
      run,
      message,
    ],
  ] as [string, ...(string | number)[]][])
    await raw(db).run(statement, ...params);
}

/** How many rows each table holds, by `column`'s value, for every table that has the column; read past row-level security. */
export async function rowsBy(column: 'user_id' | 'account_id'): Promise<Record<string, Record<string, number>>> {
  const pg = await loaded();
  const { rows: tables } = await pg.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = $1)
     ORDER BY 1`,
    [column],
  );
  return Object.fromEntries(
    await Promise.all(
      tables.map(async ({ name }) => {
        const { rows } = await pg.query<{ key: string; n: number }>(`SELECT ${column}::text AS key, count(*)::int AS n FROM "${name}" GROUP BY 1 ORDER BY 1`);
        return [name, Object.fromEntries(rows.map((r) => [r.key, r.n]))] as const;
      }),
    ),
  );
}

/**
 * Google, in memory, for every test in the file that calls this (`tests/google.ts`): each test starts with no mailboxes and
 * no sign-ins, and a request to a Google address the fake does not answer fails the test rather than reaching the network.
 */
export function fakeGoogle(): { readonly google: FakeGoogle } {
  const holder = { google: new FakeGoogle() };
  const server = serveGoogle(() => holder.google);
  beforeAll(() => server.listen());
  afterEach(() => {
    holder.google = new FakeGoogle();
    server.reset();
  });
  afterAll(() => server.close());
  return holder;
}

/**
 * Sift's own Gmail client for `address` in `google`, signed in as a sign-in that granted it would be (`send`: with
 * `gmail.send`), unpaced; and the mailbox it reaches. `token`: signed in with that sign-in instead, given earlier by
 * `google.grant`, for a test that ends it (`google.expire`).
 */
export function connectGmail(google: FakeGoogle, address = ACCOUNT, { send = false, token }: { send?: boolean; token?: string } = {}) {
  const client = clientFor(SECRETS, token ?? google.grant(address, { send }));
  const pace = async () => {};
  return { api: createGmailApi(client, pace), mailbox: createGmailMailbox(client, pace), gmail: google.mailbox(address) };
}

const SITE = 'http://localhost:3000';

/** Every `/api/` route a `startSift` browser in this test file was answered 200 by, as `GET /api/rules`. */
export const answeredRoutes = new Set<string>();

/** pi-ai's faux provider as the person's model, for `startSift`: `answers` queues what its next calls reply, one a call. */
export function fauxModel(): { chosen: ChosenModel; answers: (...replies: FauxResponseStep[]) => void } {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  return { chosen: { spec: 'faux/model', models, model: faux.getModel(), reasoning: 'low' }, answers: (...replies) => faux.setResponses(replies) };
}

/** One browser's view of the app: its own cookies, and what each call answered. */
export type Browser = Awaited<ReturnType<Awaited<ReturnType<typeof startSift>>['browser']>>;

/**
 * Sift as a host puts it together, on a fresh store and home, reaching Google through `google` as it would Google itself,
 * and given `model` as its model stand-in. Work a request begins (`kick`, the tick) waits in `queued` until `work()` does
 * it, as a Workflow run would after the request answered. `browser()` is a browser with nobody signed in; `signIn` signs one
 * in through Google's consent screen as a mailbox: a new person, or with `addTo`, another mailbox of whoever that browser is.
 */
export async function startSift(google: FakeGoogle, options: { model?: ChosenModel; keys?: Keyring; now?: () => number; env?: Record<string, string> } = {}) {
  const config = loadConfig({ SIFT_HOME: tempDir(), ...options.env });
  installClient(config, JSON.stringify({ web: { client_id: SECRETS.clientId, client_secret: SECRETS.clientSecret } }));
  const store = await freshStore(options.keys);
  const queued: Work[] = [];
  const sift: Sift = await createSift({
    config,
    store,
    ephemeral: memoryEphemeral(),
    sessionSecret: 'secret',
    allowedHosts: [],
    signInAddresses: [],
    forwarded: true,
    log: () => {},
    limitMs: 60_000,
    begin: async (piece) => {
      queued.push(piece);
      return { begun: true };
    },
    ...(options.model ? { standIns: { model: options.model } } : {}),
  });

  const browser = () => {
    const cookies = new Map<string, string>();
    const call = async (method: 'GET' | 'POST', path: string, body?: unknown) => {
      const response = await sift.respond(
        new Request(`${SITE}${path}`, {
          method,
          headers: {
            host: 'localhost:3000',
            cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; '),
            ...(method === 'POST' ? { origin: SITE, 'content-type': 'application/json', 'x-sift': '1' } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'manual',
        }),
      );
      for (const set of response.headers.getSetCookie()) {
        const [pair] = set.split(';');
        const name = pair!.slice(0, pair!.indexOf('='));
        const value = pair!.slice(pair!.indexOf('=') + 1);
        if (value === '' || /max-age=0/i.test(set)) cookies.delete(name);
        else cookies.set(name, value);
      }
      if (response.status === 200 && path.startsWith('/api/')) answeredRoutes.add(`${method} ${new URL(path, SITE).pathname}`);
      const text = await response.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { text };
      }
      return { status: response.status, body: parsed, location: response.headers.get('location') };
    };
    /** Through Google's consent screen as `address`: `add` a mailbox to whoever is signed in, or `send` let it send. */
    const signIn = async (address: string, how: { add?: boolean; send?: boolean } = {}) => {
      const login = await call('GET', `/auth/login?${how.add ? 'add=1' : how.send ? `grant=send&mailbox=${encodeURIComponent(address)}` : ''}`);
      const state = new URL(login.location ?? '').searchParams.get('state');
      if (!state) throw new Error(`/auth/login did not go to Google: ${login.status} ${login.location}`);
      const back = await call('GET', `/auth/callback?state=${state}&code=${encodeURIComponent(google.consent(address, { send: how.send ?? false }))}`);
      if (back.location?.includes('signin=')) throw new Error(`Signing in as ${address} failed: ${back.location}`);
      return back;
    };
    return { call, signIn };
  };

  const signedIn = async (address: string) => {
    const b = browser();
    await b.signIn(address);
    return b;
  };
  const work = async () => {
    while (queued.length > 0) await sift.work(queued.shift()!);
  };
  const db = async (address: string) => await store.user((await userOf(store.central, address))!.id);
  return {
    sift,
    store,
    config,
    queued,
    browser,
    /** A browser signed in as a new person with this mailbox, the first of whom owns the install. */
    signedIn,
    /**
     * `signedIn`, with a label of their own (Receipts, archived) put in their record, without which Sift reads nothing of
     * their Gmail, and the work signing in began done.
     */
    settled: async (address: string) => {
      const b = await signedIn(address);
      await addLabels(await db(address), [{ name: 'Receipts', description: 'Receipts and order confirmations.', disposition: 'archive' }]);
      await work();
      return b;
    },
    /** The database of whoever has this mailbox: to seed what Sift would have recorded, such as the model's answer about a message. */
    db,
    /**
     * The model's answer that a message a pass recorded is `labelId`, recorded as a pass with Sift off records it: a
     * suggestion, waiting on the person. A pass here has no model of its own.
     */
    judged: async (address: string, messageId: string, labelId: string, disposition: Decision['disposition'] = 'archive') =>
      await recordDecision(await db(address), address, messageId, {
        stage: 'model',
        disposition,
        labelId,
        subscription: 'preserve',
        reason: 'The model read it as this label.',
        confidence: 0.9,
      }),
    /** Do the work that was begun, and what it begins in turn, until none is left. */
    work,
    /** The next tick: begin what is due, and do it. */
    tick: async () => {
      await sift.tick();
      await work();
    },
  };
}
