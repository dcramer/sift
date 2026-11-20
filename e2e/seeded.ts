import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const freePort = () =>
  new Promise<number>((done, fail) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? done(address.port) : fail(new Error('no port'))));
    });
  });

/**
 * verify-sift's seed served by its `serve.ts` from `root`'s production build, for a script that drives the page outside
 * the browser tests. `cookie` is the seeded person's session.
 */
export async function serveSeed(root: string): Promise<{ url: string; cookie: string; stop: () => Promise<void> }> {
  const SCRIPTS = join(root, '.claude/skills/verify-sift/scripts');
  const dir = mkdtempSync(join(tmpdir(), 'sift-measure-'));
  const { stdout } = await promisify(execFile)(
    'node',
    ['--disable-warning=ExperimentalWarning', join(SCRIPTS, 'seed.ts'), join(dir, 'home'), join(dir, 'gmail.json')],
    {
      cwd: root,
    },
  );
  const port = await freePort();
  const child: ChildProcess = spawn(
    'node',
    ['--disable-warning=ExperimentalWarning', join(SCRIPTS, 'serve.ts'), join(dir, 'home'), String(port), join(dir, 'gmail.json')],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SIFT_CLOUD: 'false' } },
  );
  let log = '';
  await new Promise<void>((ready, fail) => {
    const read = (chunk: Buffer) => {
      log += chunk.toString();
      if (log.includes('Sift is running on the seeded home')) ready();
    };
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
    child.once('exit', (code) => fail(new Error(`serve.ts exited ${code}:\n${log}`)));
  });
  return {
    url: `http://127.0.0.1:${port}`,
    cookie: stdout.trim(),
    stop: async () => {
      const exited = new Promise((done) => child.once('exit', done));
      child.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
