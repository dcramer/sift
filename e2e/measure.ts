#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * How fast the page draws, on verify-sift's seed served by its `serve.ts` from the production build:
 *
 *   node e2e/measure.ts [--runs 5] [--root <checkout>] [--out <file.json>] [--shots <dir>]
 *
 * Each sample is a fresh browser context (empty cache, no service worker). For `/`, `/rules` and a sender's page it
 * reads first and largest contentful paint, layout shift, the JavaScript fetched until the screen is ready (bytes on
 * the wire and unpacked), and when the screen's heading and then its rows showed, as the page saw them (`performance.now()`
 * in the page, polled each frame). The navigation sample loads `/`, waits for the network to rest, then presses Rules
 * among the sections and times the press to the Rules heading and its rows. Three profiles: a desktop, the same with the
 * CPU slowed four times, and a phone's width.
 * `--root` measures another checkout (its seed, its server and its build),
 * so two can be run side by side. `--shots` also saves `/` and `/rules` once their rows show, at each profile's width.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { type Browser, type BrowserContext, chromium, type Page } from '@playwright/test';
import { serveSeed } from './seeded.ts';

const { values } = parseArgs({
  options: { runs: { type: 'string', default: '5' }, root: { type: 'string' }, out: { type: 'string' }, shots: { type: 'string' } },
});
const RUNS = Number(values.runs);
const ROOT = resolve(values.root ?? join(import.meta.dirname, '..'));

const PAGES = [
  { name: '/', path: '/', heading: 'For review' },
  { name: '/rules', path: '/rules', heading: 'Rules' },
  { name: 'sender', path: `/sender/${encodeURIComponent('notifications@code.example.com')}`, heading: null },
] as const;
const PROFILES = [
  { name: 'desktop', viewport: { width: 1440, height: 900 }, cpu: 1 },
  { name: 'desktop, CPU ÷4', viewport: { width: 1440, height: 900 }, cpu: 4 },
  { name: 'phone', viewport: { width: 390, height: 844 }, cpu: 1 },
] as const;

/**
 * Runs in the page before its own scripts. `heading` is the first frame where the main heading reads `want` (any, for
 * `*`), and `rows` the first where the main region also has a table row outside a loading placeholder.
 */
const PROBE = `
  window.probe = { cls: 0, lcp: 0, heading: null, rows: null, want: WANT, pressed: null };
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!e.hadRecentInput) probe.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver((list) => { probe.lcp = list.getEntries().at(-1).startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  document.addEventListener('click', () => { probe.pressed = performance.now(); probe.heading = null; probe.rows = null; }, true);
  const look = () => {
    const h1 = document.querySelector('main h1');
    const named = h1 && (probe.want === '*' || h1.textContent.trim() === probe.want);
    if (named && probe.heading === null) probe.heading = performance.now();
    const rows = [...document.querySelectorAll('main tbody tr')].filter((tr) => !tr.closest('[aria-busy="true"]'));
    if (named && rows.length > 0 && probe.rows === null) probe.rows = performance.now();
    requestAnimationFrame(look);
  };
  requestAnimationFrame(look);
`;

interface Sample {
  /** When the document, the last script and the last /api/ reply the rows waited on had arrived: what the rows were waiting for. */
  doc: number;
  lastScript: number;
  lastApi: number;
  /** Script fetched by the time the rows showed, on the wire. */
  jsReadyWire: number;
  fcp: number;
  lcp: number;
  cls: number;
  heading: number;
  rows: number;
  jsWire: number;
  jsBytes: number;
  scripts: number;
  failed: number;
}

/** A resource timing entry, as the browser has it; e2e is typed without the DOM. */
interface Timing {
  name: string;
  responseEnd: number;
  encodedBodySize: number;
  decodedBodySize: number;
}

/**
 * From the page's own resource timing: the script it fetched (bytes on the wire and unpacked), and of what had arrived by
 * `until`, the script on the wire and when the last script and the last /api/ reply came.
 */
const fetched = (page: Page, until = Infinity) =>
  page.evaluate((until) => {
    const entries = (type: string) => performance.getEntriesByType(type as 'resource') as unknown as Timing[];
    const all = entries('resource');
    const scripts = all.filter((e) => new URL(e.name).pathname.endsWith('.js'));
    const before = (e: Timing) => e.responseEnd <= until;
    const api = all.filter((e) => new URL(e.name).pathname.startsWith('/api/'));
    return {
      wire: scripts.reduce((sum, e) => sum + e.encodedBodySize, 0),
      bytes: scripts.reduce((sum, e) => sum + e.decodedBodySize, 0),
      count: scripts.length,
      readyWire: scripts.filter(before).reduce((sum, e) => sum + e.encodedBodySize, 0),
      lastScript: Math.max(0, ...scripts.filter(before).map((e) => e.responseEnd)),
      lastApi: Math.max(0, ...api.filter(before).map((e) => e.responseEnd)),
      doc: entries('navigation')[0]?.responseEnd ?? -1,
    };
  }, until);

async function contextFor(browser: Browser, sift: { url: string; cookie: string }, profile: (typeof PROFILES)[number], want: string | null) {
  const context = await browser.newContext({ viewport: profile.viewport, serviceWorkers: 'block', locale: 'en-US' });
  await context.addCookies([{ name: 'sift_session', value: sift.cookie, url: sift.url, httpOnly: true }]);
  await context.addInitScript(PROBE.replace('WANT', JSON.stringify(want ?? '*')));
  return context;
}

async function open(context: BrowserContext, profile: (typeof PROFILES)[number]) {
  const page = await context.newPage();
  const failures: string[] = [];
  page.on('response', (response) => void (response.status() >= 400 && failures.push(`${response.status()} ${response.url()}`)));
  page.on('console', (message) => void (message.type() === 'error' && failures.push(message.text())));
  page.on('pageerror', (error) => failures.push(error.message));
  if (profile.cpu > 1) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  }
  return { page, failures };
}

// A function, not a string: the page's policy refuses evaluating a string as code.
const settledReady = (page: Page) =>
  page.waitForFunction(() => (globalThis as unknown as { probe: { rows: number | null } }).probe.rows !== null, null, { timeout: 30_000, polling: 50 });

async function cold(
  browser: Browser,
  sift: { url: string; cookie: string },
  profile: (typeof PROFILES)[number],
  target: (typeof PAGES)[number],
): Promise<Sample> {
  const context = await contextFor(browser, sift, profile, target.heading);
  const { page, failures } = await open(context, profile);
  await page.goto(sift.url + target.path);
  await settledReady(page);
  // Layout shift and the largest paint can still come after the rows: give them the network's rest to land.
  await page.waitForLoadState('networkidle');
  const m = await page.evaluate<{ cls: number; lcp: number; heading: number; rows: number }>('window.probe');
  const fcp = await page.evaluate<number>("performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? -1");
  const js = await fetched(page, m.rows);
  await context.close();
  return {
    doc: js.doc,
    lastScript: js.lastScript,
    lastApi: js.lastApi,
    jsReadyWire: js.readyWire,
    fcp,
    lcp: m.lcp,
    cls: m.cls,
    heading: m.heading,
    rows: m.rows,
    jsWire: js.wire,
    jsBytes: js.bytes,
    scripts: js.count,
    failed: failures.length,
  };
}

async function navigation(browser: Browser, sift: { url: string; cookie: string }, profile: (typeof PROFILES)[number]): Promise<Sample> {
  const context = await contextFor(browser, sift, profile, 'For review');
  const { page, failures } = await open(context, profile);
  await page.goto(sift.url + '/');
  await settledReady(page);
  await page.waitForLoadState('networkidle');
  // Whatever the page fetches ahead once it is idle is part of how it navigates: let it.
  await page.evaluate('new Promise((done) => requestIdleCallback(() => done(), { timeout: 5000 }))');
  await page.waitForLoadState('networkidle');
  const before = await fetched(page);
  await page.evaluate("window.probe.want = 'Rules'; window.probe.cls = 0");
  // On a phone the sections are behind the menu.
  if (profile.viewport.width < 768) await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Rules' }).click();
  await settledReady(page);
  const m = await page.evaluate<{ pressed: number; heading: number; rows: number; cls: number }>('window.probe');
  const after = await fetched(page, m.rows);
  await context.close();
  return {
    doc: -1,
    lastScript: after.lastScript > m.pressed ? after.lastScript - m.pressed : 0,
    lastApi: after.lastApi > m.pressed ? after.lastApi - m.pressed : 0,
    jsReadyWire: after.readyWire - before.readyWire,
    fcp: -1,
    lcp: -1,
    cls: m.cls,
    heading: m.heading - m.pressed,
    rows: m.rows - m.pressed,
    jsWire: after.wire - before.wire,
    jsBytes: after.bytes - before.bytes,
    scripts: after.count - before.count,
    failed: failures.length,
  };
}

const median = (xs: number[]) => {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const ms = (xs: number[]) => `${Math.round(median(xs))} (${Math.round(Math.min(...xs))}–${Math.round(Math.max(...xs))})`;
const kb = (xs: number[]) => `${Math.round(median(xs) / 1024)}`;
const shift = (xs: number[]) => `${median(xs).toFixed(3)} (max ${Math.max(...xs).toFixed(3)})`;

const sift = await serveSeed(ROOT);
const browser = await chromium.launch();
const results: Record<string, Sample[]> = {};
try {
  // Not counted: the server's first answers compile routes and fill caches no later visitor waits on.
  for (const target of PAGES) await cold(browser, sift, PROFILES[0], target);
  for (let run = 0; run < RUNS; run++) {
    for (const profile of PROFILES) {
      for (const target of PAGES) (results[`${profile.name} | ${target.name}`] ??= []).push(await cold(browser, sift, profile, target));
      (results[`${profile.name} | / → /rules`] ??= []).push(await navigation(browser, sift, profile));
    }
  }
  if (values.shots) {
    for (const profile of [PROFILES[0], PROFILES[2]]) {
      for (const target of PAGES.slice(0, 2)) {
        const context = await contextFor(browser, sift, profile, target.heading);
        const { page } = await open(context, profile);
        await page.goto(sift.url + target.path);
        await settledReady(page);
        await page.waitForLoadState('networkidle');
        await page.screenshot({ path: join(values.shots, `${target.name === '/' ? 'review' : 'rules'}-${profile.viewport.width}.png`), fullPage: true });
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await sift.stop();
}

const lines = [
  `${ROOT}, ${RUNS} runs a row, median (min–max); times in ms from the navigation's start, or from the press for / → /rules`,
  '',
  '| Profile | Page | FCP | LCP | Heading | Rows | CLS | JS wire KB at rows | JS wire KB at rest | JS KB at rest | Scripts | Failed | Document | Last script | Last /api/ |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...Object.entries(results).map(([key, samples]) => {
    const [profile, name] = key.split(' | ');
    const of = (field: keyof Sample) => samples.map((s) => s[field]);
    const nav = name!.includes('→');
    return `| ${profile} | ${name} | ${nav ? '' : ms(of('fcp'))} | ${nav ? '' : ms(of('lcp'))} | ${ms(of('heading'))} | ${ms(of('rows'))} | ${shift(of('cls'))} | ${kb(of('jsReadyWire'))} | ${kb(of('jsWire'))} | ${kb(of('jsBytes'))} | ${median(of('scripts'))} | ${of('failed').reduce((a, b) => a + b, 0)} | ${nav ? '' : ms(of('doc'))} | ${ms(of('lastScript'))} | ${ms(of('lastApi'))} |`;
  }),
];
process.stdout.write(lines.join('\n') + '\n');
if (values.out) writeFileSync(values.out, JSON.stringify({ root: ROOT, runs: RUNS, results }, null, 2));
