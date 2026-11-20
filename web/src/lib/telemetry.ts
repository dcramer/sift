import type { Session } from './api.ts';
import { opening, stopCarrying } from './trace.ts';

/**
 * How long the page took to load and to go between screens, and what failed in it, sent to the server's Sentry project
 * (`telemetry` in the session). The SDK is reached only from here (`telemetry-sdk.ts`), so everything sent passes `scrub`.
 * Each `/api/` call carries the trace it is part of, so the server's work is under the load or the press that asked.
 */

const ADDRESS = /[^\s@<>()[\]"'`,;:/\\]+(?:@|%40)[^\s@<>()[\]"'`,;:/\\]+\.[a-z]{2,}/gi;
// A link's query names a message, an account or a sender (`?message=…`); the path is kept without it.
const QUERY = /(\/[^\s?#"]*)\?[^\s#"]*/g;
const QUERY_KEYS = new Set(['http.query', 'url.query', 'http.fragment', 'url.fragment']);

// A sender's or domain's page names them in its path, and a rule's or label's its id; each is named by its route
// instead, so one route is one name. The API's own paths (`/api/rules/inbox`) are not pages.
const ADDRESSED = /(?<!\/api)\/(sender|domain|rules|labels)\/[^/\s?#"]+/g;
const PARAM = { sender: 'address', domain: 'domain', rules: 'id', labels: 'id' } as const;
const routeOf = (text: string) => text.replace(ADDRESSED, (_, page: keyof typeof PARAM) => `/${page}/:${PARAM[page]}`);

/** `value` with every link's query, every sender's or domain's page and every address taken out, at any depth. */
function scrub<T>(value: T): T {
  // The query first: an address in it would otherwise take its `?` with it.
  if (typeof value === 'string') return routeOf(value.replace(QUERY, '$1')).replace(ADDRESS, '[address]') as T;
  if (Array.isArray(value)) return value.map(scrub) as T;
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, inner]) => (QUERY_KEYS.has(key) ? [] : [[key, scrub(inner)]]))) as T;
}

/**
 * Start sending where the server said, once. The SDK is fetched only then, apart from the page's own code: the calls
 * made before it arrives already carry the page load's trace (`traceHeaders`, `web/src/lib/trace.ts`).
 */
export function startTelemetry(where: Session['telemetry']): void {
  if (!where) stopCarrying();
  if (!where || !opening || document.querySelector('meta[name="sentry-trace"]')) return;
  const meta = document.createElement('meta');
  meta.name = 'sentry-trace';
  meta.content = opening;
  document.head.append(meta);
  void import('./telemetry-sdk.ts')
    .then(({ browserTracingIntegration, init }) => {
      init({
        dsn: where.dsn,
        ...(where.release ? { release: where.release } : {}),
        ...(where.environment ? { environment: where.environment } : {}),
        integrations: [browserTracingIntegration({ beforeStartSpan: (span) => ({ ...span, name: routeOf(span.name) }) })],
        // One person's dashboard: every load is worth having.
        tracesSampleRate: 1,
        // What was clicked and logged can quote the mail on screen.
        beforeBreadcrumb: () => null,
        beforeSend: (event) => scrub(event),
        beforeSendSpan: (span) => scrub(span),
      });
      stopCarrying();
    })
    .catch(() => {});
}

/** A failure the page caught itself (`Failed`), which the SDK would otherwise never see. Dropped when nothing was started. */
export function reportError(error: unknown): void {
  void import('./telemetry-sdk.ts').then(({ captureException }) => captureException(error)).catch(() => {});
}
