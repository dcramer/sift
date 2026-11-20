#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Verification scaffolding: the real app, as `sift run` starts it, on a seeded home, reaching the fake Google the seed
 * left in <google.json> and a stand-in model (`stand-ins.ts`, which says what they answer).
 *
 *   node .claude/skills/verify-sift/scripts/serve.ts <home> <port> <google.json> [--listing]
 *
 * `--listing`: the inbox also holds 1,200 sales from the Store, and Gmail never answers a search's second page
 * (`SIFT_STAND_INS_LISTING`).
 *
 * The page is served from the build as it is: `pnpm build:web` first after changing it. There is no minute's tick;
 * what a person presses for (Check now, applying a rule) is begun at once, each piece a Workflow run, as under
 * `sift run`.
 */
import { resolve } from 'node:path';
import { startNext } from '../../../../src/cli/next.ts';
import { ui } from '../../../../src/cli/ui.ts';

const [home, port, googleFile, flag] = process.argv.slice(2);
if (!home || !port || !googleFile) throw new Error('usage: serve.ts <home> <port> <google.json> [--listing]');
const server = await startNext({
  dev: false,
  port: Number(port),
  hostname: '127.0.0.1',
  env: {
    SIFT_HOME: resolve(home),
    SIFT_STAND_INS: resolve(googleFile),
    ...(flag === '--listing' ? { SIFT_STAND_INS_LISTING: '1' } : {}),
    NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import=${resolve(import.meta.dirname, 'stand-ins.ts')}`.trim(),
  },
  inUse: `Port ${port} is already in use.`,
  print: (line) => ui.plain(line),
});
ui.info('Sift is running on the seeded home, with the fake Google and a stand-in model.');
const stop = () => void server.stop();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await server.exited;
