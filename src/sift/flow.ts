import { getRun, start } from 'workflow/api';
import { HookConflictError } from 'workflow/errors';
import type { Work } from '../work/run.ts';
import type { Beginning } from './sift.ts';

// One workflow per kind of piece: Workflow's dashboards list a run by its workflow's function name.
// Workflow's build registers only an exported workflow.

/** @public */
export async function mailboxPass(piece: Work): Promise<void> {
  'use workflow';
  await doPiece(piece);
}

/** @public */
export async function inboxRun(piece: Work): Promise<void> {
  'use workflow';
  await doPiece(piece);
}

/** @public */
export async function testRun(piece: Work): Promise<void> {
  'use workflow';
  await doPiece(piece);
}

/** @public */
export async function upkeep(piece: Work): Promise<void> {
  'use workflow';
  await doPiece(piece);
}

/** @public */
export async function mailboxCopy(piece: Work): Promise<void> {
  'use workflow';
  await doPiece(piece);
}

/** @public */
export async function dailyDigests(piece: Work): Promise<void> {
  'use workflow';
  await doPiece(piece);
}

const FLOWS = { pass: mailboxPass, inbox: inboxRun, copy: mailboxCopy, eval: testRun, upkeep, digest: dailyDigests } satisfies Record<Work['kind'], unknown>;

/** Runs in the process Workflow delivered the run to, with that process's Sift. */
async function doPiece(piece: Work): Promise<void> {
  'use step';
  // Not a static import: the hosts that instance.ts opens import `begin` from here.
  await (await import('./instance.ts')).work(piece);
}

/** Starts a run for `piece`, holding `key` until it ends; refused while a run holds it already. */
export async function begin(piece: Work, key: string): Promise<Beginning> {
  try {
    await start(FLOWS[piece.kind], [piece], {
      experimental_hook: { token: key },
      // Nothing of the run is kept once it ends: its input names the mailbox, and Vercel bills what it keeps.
      experimental_retention: 0,
      // Kept after that, in plain text, so the run can be found by its person or mailbox: numbers only.
      attributes: Object.fromEntries(Object.entries(piece).map(([name, value]) => [name, String(value)])),
    });
    return { begun: true };
  } catch (error) {
    if (!HookConflictError.is(error)) throw error;
    const holder = error.conflictingRunId;
    return holder ? { begun: false, since: (await getRun(holder).createdAt).getTime() } : { begun: false };
  }
}
