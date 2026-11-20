import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { buildPage } from '../src/cli/next.ts';
import { heldValues } from './held.ts';
import { HELD, SEED, TEMPLATES, type Variant } from './sift.ts';

/**
 * Builds the page once (Next.js's cache keeps that to seconds when little changed), and seeds each variant once through verify-sift's real passes (several seconds each);
 * every test then starts from a copy of one.
 */
export default async function setup() {
  await buildPage();
  const root = mkdtempSync(join(tmpdir(), 'sift-e2e-'));
  const variants: Record<Variant, string[]> = { full: [], bare: ['--bare'], on: ['--on'], chatgpt: ['--chatgpt'], inbox: ['--inbox'] };
  await Promise.all(
    Object.entries(variants).map(async ([name, args]) => {
      const dir = join(root, name);
      const { stdout } = await promisify(execFile)('node', [
        '--disable-warning=ExperimentalWarning',
        SEED,
        join(dir, 'home'),
        join(dir, 'google.json'),
        ...args,
      ]);
      process.env[`${TEMPLATES}_${name}`] = JSON.stringify({ dir, cookie: stdout.trim() });
    }),
  );
  process.env[HELD] = JSON.stringify(await heldValues(join(root, 'full', 'home')));
  return () => rmSync(root, { recursive: true, force: true });
}
