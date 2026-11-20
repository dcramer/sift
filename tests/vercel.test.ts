import { globSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runKey } from '../src/sift/sift.ts';
import { READS, WRITES } from '../src/dashboard/api/index.ts';
import { listAccounts, recordSync } from '../src/store/accounts.ts';
import type { Store } from '../src/store/store.ts';
import { cron, respond } from '../src/sift/instance.ts';
import { MAX_DURATION_S } from '../src/vercel/host.ts';
import type { Work } from '../src/work/run.ts';
import { onePerson, raw } from './fixtures.ts';
import { ACCOUNT, facts, tempDir } from './helpers.ts';

// What only a deploy has: its Postgres (this test's database, or a refusal while `store` is unset), its Redis
// (memory) and Workflow's queue (`begun`).
const deploy = vi.hoisted(() => ({ store: undefined as Store | undefined, begun: [] as [Work, string][] }));
vi.mock('../src/store/store.ts', async (actual) => ({
  ...(await actual<object>()),
  openStore: async () => deploy.store ?? Promise.reject(new Error('connect ECONNREFUSED')),
}));
vi.mock('../src/ephemeral/open.ts', async () => {
  const { memoryEphemeral } = await import('../src/ephemeral/ephemeral.ts');
  return { openEphemeral: async () => memoryEphemeral() };
});
vi.mock('../src/sift/flow.ts', () => ({
  begin: async (piece: Work, key: string) => (deploy.begun.push([piece, key]), { begun: true }),
}));

const SET_UP = {
  DATABASE_URL: 'postgres://nobody@db.invalid/sift',
  REDIS_URL: 'redis://redis.invalid',
  SIFT_GOOGLE_CLIENT_ID: 'id',
  SIFT_GOOGLE_CLIENT_SECRET: 'secret',
  SIFT_SESSION_SECRET: 'synthetic-session',
  CRON_SECRET: 'synthetic-cron',
  VERCEL_URL: 'sift-abc123.vercel.app',
  VERCEL_BRANCH_URL: 'sift-git-main.vercel.app',
  VERCEL_PROJECT_PRODUCTION_URL: 'sift.example.com',
  SIFT_URL: 'https://mail.example.org',
};

beforeEach(() => vi.stubEnv('VERCEL', '1'));

/** A new Vercel instance of a project that is set up: Sift's modules loaded afresh, and nothing of the last kept in the process. */
async function instance(over: Record<string, string> = {}) {
  for (const [name, value] of Object.entries({ ...SET_UP, SIFT_HOME: tempDir(), ...over })) vi.stubEnv(name, value);
  deploy.begun = [];
  vi.resetModules();
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('sift.host')];
  return await import('../src/sift/instance.ts');
}

/** `vercel.json`: what Vercel does without sift seeing the request. */
const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string }[] };
/** Next.js's own routes under `/api/` (`app/api/`), by path. */
const ownRoutes = globSync('app/api/*/route.ts').map((file) => `/${file.replace(/^app\//, '').replace(/\/route\.ts$/, '')}`);

describe('the Vercel host', () => {
  it('ticks each minute, every route within the time limit the code assumes', () => {
    expect(vercel.crons).toEqual([{ path: '/api/cron', schedule: '* * * * *' }]);
    const routes = globSync('app/**/route.ts');
    expect(routes.length).toBeGreaterThan(0);
    for (const file of routes) expect(readFileSync(file, 'utf8'), file).toContain(`export const maxDuration = ${MAX_DURATION_S};`);
  });

  // Vercel's Next.js builder takes either for the page's own app/ and looks there for each route's source. It then
  // misses Workflow's `config.json` beside the flow route, so the flow function gets no queue trigger and no run is
  // ever delivered.
  it('has no src/app or src/pages', () => {
    expect(globSync('src/{app,pages}')).toEqual([]);
  });

  it('ticks only for a call carrying CRON_SECRET, and for none while it is unset', async () => {
    const url = 'https://sift.example.com/api/cron';
    await expect(cron(new Request(url))).rejects.toThrow('CRON_SECRET');
    vi.stubEnv('CRON_SECRET', 'synthetic-secret');
    expect((await cron(new Request(url))).status).toBe(401);
    expect((await cron(new Request(url, { headers: { authorization: 'Bearer wrong' } }))).status).toBe(401);
    expect((await cron(new Request(url, { headers: { authorization: 'Bearer synthetic-secre' } }))).status).toBe(401);
  });

  it('until it is set up, says to whoever opens it every variable still missing, before opening anything', async () => {
    vi.stubEnv('SIFT_HOME', tempDir());
    const missing = async () => {
      const reply = await respond(new Request('https://sift.example.com/api/session'));
      expect(reply.status).toBe(503);
      return ((await reply.json()) as { missing: string[] }).missing;
    };
    const given = {
      DATABASE_URL: 'postgres://nobody@db.invalid/sift',
      REDIS_URL: 'redis://redis.invalid',
      SIFT_GOOGLE_CLIENT_ID: 'id',
      SIFT_GOOGLE_CLIENT_SECRET: 'secret',
      SIFT_SESSION_SECRET: 'synthetic',
    };
    expect(await missing()).toEqual([...Object.keys(given), 'CRON_SECRET']);
    for (const [name, value] of Object.entries(given)) vi.stubEnv(name, value);
    expect(await missing()).toEqual(['CRON_SECRET']);
  });

  it("names no dashboard route as one of Next.js's own, which would answer it instead", () => {
    expect(ownRoutes.toSorted()).toEqual(['/api/[...path]', '/api/cron']);
    for (const route of [...READS, ...WRITES]) expect(ownRoutes).not.toContain(route.path);
  });
});

describe('a Vercel instance of a project that is set up', () => {
  it("answers at the deployment's own names and the project's domain, and refuses any other", async () => {
    deploy.store = (await onePerson(ACCOUNT)).store;
    const { respond } = await instance();
    const at = async (host: string) => await respond(new Request(`https://${host}/api/session`, { headers: { host } }));
    for (const host of ['sift-abc123.vercel.app', 'sift-git-main.vercel.app', 'sift.example.com', 'mail.example.org']) {
      const reply = await at(host);
      expect(reply.status, host).toBe(200);
      expect(await reply.json(), host).toMatchObject({ canSignIn: true, addresses: ['https://mail.example.org'] });
    }
    expect((await at('sift.example.net')).status).toBe(403);
  });

  it('is opened at the production domain when SIFT_URL does not say', async () => {
    deploy.store = (await onePerson(ACCOUNT)).store;
    const { respond } = await instance({ SIFT_URL: '' });
    const reply = await respond(new Request('https://sift.example.com/api/session', { headers: { host: 'sift.example.com' } }));
    expect(await reply.json()).toMatchObject({ addresses: ['https://sift.example.com'] });
  });

  it('fails a request while its database cannot be reached, and opens it again for the next', async () => {
    deploy.store = undefined;
    const { respond } = await instance();
    const request = () => new Request('https://sift.example.com/api/session', { headers: { host: 'sift.example.com' } });
    // Its words name the database: they go to Sentry, never the page.
    const failed = await respond(request());
    expect([failed.status, await failed.json()]).toEqual([500, { error: 'Sift could not do that.' }]);
    deploy.store = (await onePerson(ACCOUNT)).store;
    expect((await respond(request())).status).toBe(200);
  });

  it("begins, on Vercel Cron's call, a run for each piece due, keyed as every instance keys it", async () => {
    const { store, db } = await onePerson(ACCOUNT);
    deploy.store = store;
    const { cron } = await instance();
    const reply = await cron(new Request('https://sift.example.com/api/cron', { headers: { authorization: 'Bearer synthetic-cron' } }));
    expect(reply.status).toBe(204);
    const person = db.person!;
    const due: Work[] = [
      { kind: 'upkeep', person },
      { kind: 'pass', person, mailbox: (await listAccounts(db))[0]!.number },
    ];
    expect(deploy.begun).toEqual(due.map((piece) => [piece, runKey(piece)]));
  });

  it("does a Workflow run's piece with the instance's own Sift", async () => {
    const { store, db } = await onePerson(ACCOUNT);
    deploy.store = store;
    await recordSync(db, ACCOUNT, [facts({ messageId: 'waiting', receivedAt: 0 })], '1', 0);
    await raw(db).run(`INSERT INTO read_bodies (account_id, message_id, body_text, fetched_at) VALUES (?, 'waiting', 'Old text.', 0)`, ACCOUNT);
    const { work } = await instance();
    await work({ kind: 'upkeep', person: db.person! });
    expect(await raw(db).all('SELECT message_id FROM read_bodies')).toEqual([]);
  });
});
