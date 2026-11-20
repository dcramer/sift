// JavaScript, not TypeScript: Next.js announces loading a TypeScript config on the terminal `sift run` prints to.
import { randomUUID } from 'node:crypto';
import { withWorkflow } from 'workflow/next';
import { PAGE_HEADERS } from './src/dashboard/policy.ts';

/**
 * Which build this is, written into the page and the server alike: a page left open across an update finds the server's
 * differs (`/api/session`) and loads itself again. Not a secret: Next.js puts a deploy's id in every file's address.
 */
const BUILD = process.env.VERCEL_DEPLOYMENT_ID ?? randomUUID();

const WORLD_VERSION = 'node_modules/.pnpm/@workflow+world-local@*/node_modules/@workflow/world-local/package.json';

/** @type {import('next').NextConfig} */
export default withWorkflow({
  // `pnpm typecheck` checks the page and the server with their own settings (tsconfig.web.json, tsconfig.json).
  typescript: { tsconfigPath: 'tsconfig.web.json', ignoreBuildErrors: true },
  poweredByHeader: false,
  env: { SIFT_BUILD: BUILD },
  // Each screen is built once and only the dashboard's frame is drawn per request (app/(dashboard)/layout.tsx), so a
  // link fetches the screen behind it ahead, from the build's files, and pressing it waits on nothing.
  cacheComponents: true,
  partialPrefetching: true,
  // The image runs the server Next.js traces here, with only the files it loads (docker/Dockerfile). Vercel builds its own.
  output: 'standalone',
  // Nothing uses next/image, so /_next/image optimizes nothing for anyone.
  images: { unoptimized: true },
  // The page and its files. The API and sign-in send their own (src/dashboard/server.ts), the message frame's among them.
  headers: async () => [{ source: '/((?!api/|auth/).*)', headers: Object.entries(PAGE_HEADERS).map(([key, value]) => ({ key, value })) }],
  // Workflow builds a route that resumes a run waiting on a webhook. Sift creates none, so a request there finds no page.
  rewrites: async () => ({
    beforeFiles: [
      { source: '/.well-known/workflow/v1/webhook/:path*', destination: '/.well-known/workflow/v1/no-webhook' },
      { source: '/sender/:address', destination: '/sender' },
      { source: '/domain/:domain', destination: '/domain' },
      // A rule's and a label's own address: its list, with it open, read from the path in the browser.
      { source: '/rules/:id', destination: '/rules' },
      { source: '/labels/:id', destination: '/labels' },
    ],
    afterFiles: [],
    fallback: [],
  }),
  // Loaded from node_modules as they are, not bundled: PGlite and pi-ai load files beside their own modules,
  // and pi-ai names provider SDKs that pnpm-workspace.yaml leaves out of the install.
  serverExternalPackages: [
    '@electric-sql/pglite',
    '@earendil-works/pi-ai',
    '@sentry/node',
    '@googleapis/gmail',
    'google-auth-library',
    'drizzle-orm',
    'pg',
    'redis',
  ],
  // The migrations are read at run time (`src/store/db.ts`), and Workflow's flow route opens the database too. The
  // Local World reads its own package.json to compare with the version its data was written by, which tracing misses.
  outputFileTracingIncludes: {
    '/api/**': ['src/store/migrations/**', WORLD_VERSION],
    '/auth/**': ['src/store/migrations/**', WORLD_VERSION],
    '/.well-known/workflow/**': ['src/store/migrations/**', WORLD_VERSION],
  },
});
