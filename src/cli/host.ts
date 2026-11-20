import { type Config, type Env, loadConfig, loadEnvFiles, resolveHome } from '../config.ts';
import { sessionSecret } from './session.ts';
import { openEphemeral } from '../ephemeral/open.ts';
import { begin } from '../sift/flow.ts';
import type { Host, StandIns } from '../sift/sift.ts';
import { openStore } from '../store/store.ts';
import { startTelemetry } from '../telemetry.ts';
import { fromHere, machineNames, signInAddresses } from './network.ts';

/** How long a piece of work in `sift run` may start work: as a host's function would cut it off, so the same path runs. */
const LIMIT_MS = 5 * 60_000;

/** What the dashboard answers to on this machine: any name or address that is this machine, and SIFT_URL's. */
function dashboardAddresses(config: Config, port: number) {
  const { url } = config.settings;
  return {
    url: url ?? `http://localhost:${port}`,
    allowedHosts: [...machineNames(), ...(url ? [new URL(url).hostname] : [])],
    signInAddresses: signInAddresses(port, url),
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** What a test host's preload offers in place of the model (`StandIns`); nothing does otherwise. */
const STAND_INS = Symbol.for('sift.stand-ins');

/**
 * `sift run`'s host, in the Next.js server it starts: this machine and its home directory, with the settings the
 * command line read and the address it listens on (`HOSTNAME`, as Next.js's standalone server takes it, and `PORT`,
 * which Next.js sets once listening).
 */
export async function localHost(env: Env = process.env): Promise<Host> {
  loadEnvFiles(resolveHome(env));
  const config = loadConfig(env);
  startTelemetry(config.settings.sentryDsn);
  const port = Number(env['PORT']);
  const listen = env['HOSTNAME'] ?? '127.0.0.1';
  // The World keeps its runs in the home and delivers each to this listener, whatever address it is on.
  env['WORKFLOW_LOCAL_DATA_DIR'] = config.workflowDir;
  env['WORKFLOW_LOCAL_BASE_URL'] = fromHere(listen, port);
  const store = await openStore(config);
  const standIns = (globalThis as { [STAND_INS]?: StandIns })[STAND_INS];
  return {
    config,
    store,
    ephemeral: await openEphemeral(config.settings.redisUrl),
    sessionSecret: sessionSecret(config, env),
    ...dashboardAddresses(config, port),
    forwarded: LOOPBACK.has(listen),
    log: (line) => process.stdout.write(`${line}\n`),
    begin,
    limitMs: LIMIT_MS,
    ...(standIns ? { standIns } : {}),
  };
}
