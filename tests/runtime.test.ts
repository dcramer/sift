import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createSift, runKey } from '../src/sift/sift.ts';
import { loadConfig } from '../src/config.ts';
import { fromHere } from '../src/cli/network.ts';
import { type Ephemeral, memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import type { RunOptions } from '../src/work/run.ts';
import { startInboxRuns } from '../src/store/inbox.ts';
import { listAccounts } from '../src/store/accounts.ts';
import { people } from '../src/store/people.ts';
import { setModel } from '../src/store/preferences.ts';
import type { Store } from '../src/store/store.ts';
import { googleSignIn, onePerson, startDashboard } from './fixtures.ts';
import { ACCOUNT, FakeMailbox, codeSignIn, tempDir, testModel, workDue } from './helpers.ts';

/**
 * Module state that holds between calls, allowed because any instance computes the same: a cache, not a
 * record of what happened (docs/runtime.md).
 */
const CACHES: Record<string, string[]> = {
  // Keys derived from SIFT_KEY.
  'src/secrets.ts': ['derived', 'hashKeys', 'searchKeys'],
  // Sift put together over the process's host, again by each copy of the module `next dev` loads.
  'src/sift/instance.ts': ['opened'],
};

describe('nothing is kept in module memory between calls', () => {
  it('outside the hosts, no module holds a variable or an empty collection to fill', () => {
    const unexpected: string[] = [];
    for (const file of globSync('src/**/*.ts')) {
      // The hosts: `sift run` is one long-lived process with its terminal; a Vercel instance keeps its connections.
      if (file.startsWith('src/cli/') || file.startsWith('src/vercel/')) continue;
      const held = /^(?:export )?(?:let|var) (\w+)|^(?:export )?const (\w+) = new (?:Map|Set|WeakMap|WeakSet)(?:<[^\n]*>)?\(\)/gm;
      for (const match of readFileSync(file, 'utf8').matchAll(held)) {
        const name = match[1] ?? match[2]!;
        if (!CACHES[file]?.includes(name)) unexpected.push(`${file}: ${name}`);
      }
    }
    expect(unexpected).toEqual([]);
  });
});

describe('a flow whose steps reach different instances', () => {
  /** Sign in on one dashboard and come back from Google to another; true when the second signs the browser in. */
  const signInAcross = async (first: Ephemeral, second: Ephemeral) => {
    const { store } = await onePerson(ACCOUNT);
    const options = { signIn: codeSignIn, sessionSecret: 'secret' };
    const one = await startDashboard(people(store), { ...options, ephemeral: first });
    const two = await startDashboard(people(store), { ...options, ephemeral: second });
    const back = await googleSignIn(one, ACCOUNT, two);
    return String(back.headers['set-cookie']).includes('sift_session=ey');
  };

  it('signs in with Google when the callback reaches another instance that shares the ephemeral store', async () => {
    const shared = memoryEphemeral();
    expect(await signInAcross(shared, shared)).toBe(true);
    // What the test would catch: a sign-in kept in one instance's memory.
    expect(await signInAcross(memoryEphemeral(), memoryEphemeral())).toBe(false);
  });

  it('goes through an inbox one instance was asked to, on another', async () => {
    const { store, db } = await onePerson(ACCOUNT);
    const ephemeral = memoryEphemeral();
    const searched: string[] = [];
    // Each instance builds its own options; only the store and the ephemeral store are shared.
    const instance = (): RunOptions => ({
      ephemeral,
      log: () => {},
      model: async () => testModel(),
      connect: () => ({
        api: {
          getProfile: async () => ({ emailAddress: ACCOUNT, historyId: '1' }),
          listHistory: async () => ({ additions: [], historyId: '1' }),
          searchInbox: async (query) => (searched.push(query), { ids: [] }),
          inboxSize: async () => 0,
          searchMail: async () => ({ ids: [] }),
          mailboxSize: async () => 0,
          getMessage: async () => null,
          getMetadata: async () => null,
          getLabelIds: async () => null,
          listLabels: async () => [],
          getContent: async () => null,
          getThread: async () => null,
          listSendAs: async () => [ACCOUNT],
        },
        mailbox: new FakeMailbox(),
      }),
    });
    await startInboxRuns(db, [ACCOUNT], { acts: false, most: 10, now: 0 });
    await workDue(store, instance(), Infinity);
    await workDue(store, instance(), Infinity);
    expect(searched).toEqual(['']);
  });
});

describe("a piece's run key", () => {
  it('names a mailbox by its number, never its address, since Workflow keeps keys unencrypted', async () => {
    const { db } = await onePerson(ACCOUNT, 'me@work.example.org');
    const [one, two] = await listAccounts(db);
    const pass = (mailbox: number) => runKey({ kind: 'pass', person: db.person!, mailbox });
    expect([pass(one!.number), pass(two!.number)].join()).not.toContain('example.org');
    expect(pass(one!.number)).not.toBe(pass(two!.number));
    expect(runKey({ kind: 'inbox', person: db.person!, mailbox: one!.number, run: 1 })).not.toBe(pass(one!.number));
    expect((await listAccounts(db)).map((a) => a.number)).toEqual([one!.number, two!.number]);
  });
});

/** Sift as a host puts it together, writing its log to `logged`. */
const siftOn = (store: Store, logged: string[], begin?: Parameters<typeof createSift>[0]['begin']) =>
  createSift({
    config: loadConfig({ SIFT_HOME: tempDir() }),
    store,
    ephemeral: memoryEphemeral(),
    sessionSecret: 'secret',
    allowedHosts: [],
    signInAddresses: [],
    forwarded: true,
    log: (line) => logged.push(line),
    limitMs: 60_000,
    begin: begin ?? (async () => ({ begun: true })),
  });

describe('a piece whose key a run holds', () => {
  it('is said in the log once that run has gone on longer than any run lasts', async () => {
    const { store } = await onePerson(ACCOUNT);
    const logged: string[] = [];
    let since = Date.now() - 60_000;
    const sift = await siftOn(store, logged, async () => ({ begun: false, since }));
    const held = () => logged.filter((line) => line.includes('has not ended'));
    await sift.tick();
    expect(held()).toEqual([]);
    since = Date.now() - 2 * 3_600_000;
    await sift.tick();
    expect(held()).toContain('Deleting old records is held back by a run begun 120 minutes ago that has not ended');
  });
});

describe('a piece that could not be begun', () => {
  it('is said in the log and begun at the next tick, and does not hold back the others', async () => {
    const { store } = await onePerson(ACCOUNT);
    const logged: string[] = [];
    const begun: string[] = [];
    let queue = 'down';
    const sift = await siftOn(store, logged, async (piece) => {
      if (piece.kind === 'upkeep' && queue === 'down') throw new Error('queue unavailable');
      begun.push(piece.kind);
      return { begun: true };
    });
    await sift.tick();
    expect(begun).toEqual(['pass']);
    expect(logged).toContain('Could not begin upkeep, will retry: queue unavailable');
    queue = 'up';
    await sift.tick();
    expect(begun).toEqual(['pass', 'upkeep', 'pass']);
  });
});

describe("a person's model that cannot be reached", () => {
  it('is said in the log once, not at every pass, and again when the reason changes', async () => {
    const { store, db } = await onePerson(ACCOUNT);
    const logged: string[] = [];
    const sift = await siftOn(store, logged);
    const pass = { kind: 'pass', person: db.person!, mailbox: (await listAccounts(db))[0]!.number } as const;
    // Each pass also fails for want of a Gmail sign-in, and says so each time.
    const said = () => logged.filter((line) => !line.includes('pass failed'));
    await setModel(db, 'openai/gpt-5-mini');
    await sift.work(pass);
    await sift.work(pass);
    expect(said()).toEqual([`${ACCOUNT}: Not signed in to openai. Sign in under Settings in the dashboard.`]);
    await setModel(db, 'openai/no-such-model');
    await sift.work(pass);
    expect(said()).toHaveLength(2);
  });
});

describe('where the Local World delivers runs under sift run', () => {
  it('is the listener’s own address, a wildcard at its own family’s loopback', () => {
    expect(fromHere('::', 8787)).toBe('http://[::1]:8787');
    expect(fromHere('0.0.0.0', 8787)).toBe('http://127.0.0.1:8787');
    expect(fromHere('fd7a:115c::1', 8787)).toBe('http://[fd7a:115c::1]:8787');
    expect(fromHere('127.0.0.1', 8787)).toBe('http://127.0.0.1:8787');
  });
});
