import { createHash } from 'node:crypto';
import { unsubscribe } from '../actions/unsubscribe.ts';
import type { Config } from '../config.ts';
import { type PassResult, type RunOptions, type Work, describeWork, dueWork, runWork } from '../work/run.ts';
import { createDashboard } from '../dashboard/server.ts';
import type { Ephemeral } from '../ephemeral/ephemeral.ts';
import { listAccounts, personOf } from '../store/accounts.ts';
import { people } from '../store/people.ts';
import type { Sql } from '../store/sql.ts';
import type { Store } from '../store/store.ts';
import type { Mailbox } from '../actions/mailbox.ts';
import type { Controls } from '../dashboard/controls.ts';
import type { GmailApi } from '../gmail/api.ts';
import type { ChosenModel } from '../model/models.ts';
import { buildControls, gmailFor, openModelTier } from './controls.ts';
import { buildSignIn } from './google-sign-in.ts';
import { logged, reportError } from '../telemetry.ts';

/** A piece begun, or refused while a run holds its key: the one begun at `since`, when Workflow says which. */
export type Beginning = { begun: true } | { begun: false; since?: number };

/**
 * What a test host puts in place of what Sift reaches outside this machine for (verify-sift's `stand-ins.ts`):
 * each mailbox's Gmail, the model that suggests labels and drafts rules, and what Gmail would count in an inbox
 * that the stand-in does not hold. A pass is given no model, so the record a test starts from is not judged again.
 */
export interface StandIns {
  gmail: (email: string) => { api: GmailApi; mailbox: Mailbox };
  model: ChosenModel;
  inbox: Pick<Controls, 'inboxEstimate' | 'mailReach' | 'ruleInbox'>;
}

/** What a host gives sift: `sift run` on a machine, or a function on Vercel (docs/runtime.md). */
export interface Host {
  config: Config;
  store: Store;
  ephemeral: Ephemeral;
  /** Signs session cookies; ChatGPT also knows this install by an id derived from it. */
  sessionSecret: string;
  /** Names besides localhost the dashboard answers to. */
  allowedHosts: readonly string[];
  /** Where people open the dashboard, for links in what Sift puts in their Gmail. */
  url?: string;
  /** Addresses Google can sign someone in at, suggested when the dashboard is opened at one it cannot. */
  signInAddresses: readonly string[];
  /**
   * Whether the scheme a request's URL says was used is believed. Next.js takes it from `X-Forwarded-Proto`,
   * whoever sent it, so `sift run` believes it only while it listens on loopback, where every peer is this
   * machine (`tailscale serve` among them). Vercel's edge sets the header itself.
   */
  forwarded: boolean;
  log: (line: string) => void;
  /** Starts a Workflow run for a piece (`src/sift/flow.ts`) that holds `key` until it ends; refused while one holds it already. */
  begin: (piece: Work, key: string) => Promise<Beginning>;
  /** How long one piece of work may start work, short of what the host would cut a call off at. */
  limitMs: number;
  standIns?: StandIns;
}

export interface Sift {
  /** A request to the API or sign-in. The page is Next.js's (`app/`). */
  respond: (request: Request) => Promise<Response>;
  /** Do one piece of what is due, within the host's limit: what a Workflow run's step calls. */
  work: (work: Work) => Promise<PassResult | null>;
  /** Begin a run for each piece due, for these people or everyone. */
  tick: (people?: readonly number[]) => Promise<void>;
}

/**
 * The key a piece's run holds, so each piece has one run at a time wherever it was begun. Workflow keeps keys
 * unencrypted, so a mailbox is named by its number, never its address. Upkeep's names no day: the claim it makes
 * inside keeps it to once a day.
 */
export function runKey(piece: Work): string {
  switch (piece.kind) {
    case 'pass':
      return `pass:${piece.mailbox}`;
    case 'inbox':
      return `inbox:${piece.mailbox}:${piece.run}`;
    case 'copy':
      return `copy:${piece.mailbox}`;
    case 'eval':
      return `eval:${piece.person}:${piece.run}`;
    case 'upkeep':
      return `upkeep:${piece.person}`;
    case 'digest':
      return `digest:${piece.person}`;
  }
}

/**
 * Longer than any run lasts: its step's four tries, each cut off at the host's limit. A run holding a piece's key
 * for longer will not end by itself, and its piece is never begun again (docs/runtime.md).
 */
const STUCK_MS = 30 * 60_000;

/** The id ChatGPT registers this install's sign-ins under: a UUID, the same on every instance. */
const deviceId = (secret: string) => {
  const hex = createHash('sha256').update(`sift chatgpt device:${secret}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

/** sift, put together from what the host gives it. Holds nothing between calls but what `host` does. */
export async function createSift(host: Host): Promise<Sift> {
  const { config, store, ephemeral, standIns } = host;
  // What the host writes is a log in Sentry too, beside the trace it was written in.
  const log = (line: string) => {
    logged(line);
    host.log(line);
  };
  // Why each person's model could not be reached, so a log says it once rather than every pass. Only the log forgets it.
  const unreachable = new Map<number, string>();
  const options: RunOptions = {
    ephemeral,
    log,
    ...(host.url ? { dashboard: host.url } : {}),
    ...(standIns
      ? {}
      : {
          model: async (db: Sql) => {
            const person = await personOf(db);
            try {
              const tier = await openModelTier(config, ephemeral, db);
              unreachable.delete(person);
              return tier && { judge: tier.judge, highlight: tier.highlight, model: tier.spec };
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              if (unreachable.get(person) !== message) log(`${(await listAccounts(db)).map((a) => a.email).join(', ')}: ${message}`);
              unreachable.set(person, message);
              return null;
            }
          },
        }),
    unsubscribe: (db, accountId, messageId) => unsubscribe({ db }, accountId, messageId),
    connect: async (db, account) => standIns?.gmail(account.email) ?? (await gmailFor(config, ephemeral, db, account.email)),
  };
  const { begin } = host;
  const tick = async (who?: readonly number[]) => {
    for (const piece of await dueWork(store, options, who)) {
      // What is not begun is due again at the next tick.
      const beginning = await begin(piece, runKey(piece)).catch((error: unknown) => {
        reportError(error);
        log(`Could not begin ${piece.kind}, will retry: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (!beginning || beginning.begun || beginning.since === undefined || Date.now() - beginning.since < STUCK_MS) continue;
      const minutes = Math.round((Date.now() - beginning.since) / 60_000);
      reportError(new Error(`A ${piece.kind} run has held its key for ${minutes} minutes`));
      log(`${describeWork(piece)} is held back by a run begun ${minutes} minutes ago that has not ended`);
    }
  };
  const controls = await buildControls(config, {
    ephemeral,
    deviceId: deviceId(host.sessionSecret),
    // What a person starts in the dashboard (check now, a test run, going through the inbox) begins now, not at the next tick.
    kick: (person: number) => tick([person]),
    ...(standIns ? { standIns } : {}),
  });
  const dashboard = createDashboard(people(store), {
    allowedHosts: host.allowedHosts,
    forwarded: host.forwarded,
    controls: { ...controls, ...standIns?.inbox },
    signIn: buildSignIn(config, store, { ephemeral, kick: (person) => tick([person]) }),
    sessionSecret: host.sessionSecret,
    signInAddresses: host.signInAddresses,
    ...(config.settings.cloud ? { cloud: true } : {}),
    build: process.env.SIFT_BUILD ?? null,
    ephemeral,
    log,
  });
  return {
    respond: dashboard.handle,
    work: (piece) => runWork(store, piece, options, Date.now() + host.limitMs),
    tick,
  };
}
