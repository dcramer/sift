// The service worker: keeps the page and its files so the installed app opens when Sift cannot be reached,
// and then says so. It never keeps anything under /api/ or /auth/: that is private mail data and sign-in.

const CACHE = 'sift-shell-2';
/** A sender's and a domain's page is one page for all of them. */
const pageOf = (url) => url.pathname.replace(/^\/(sender|domain)\/.*/, '/$1');
/** Only a page drawn the same for everyone is kept: a screen drawn for whoever asked is theirs, and says so (`no-store`). */
const forEveryone = (response) => response.ok && !/no-store|private/.test(response.headers.get('cache-control') ?? '');
/** Drawn for everyone, and with no session to read says Sift cannot be reached: where a screen not kept falls back to. */
const SHELL = '/sender';

/**
 * How long a page is waited for. A network that connects but never answers (a weak signal, a captive portal) would
 * otherwise leave the installed app blank; a server starting cold answers well inside it.
 */
const PATIENCE = 8000;

/** A built file's path, as pages, scripts and styles name it (a script names the chunks it loads later without `/_next/`). */
const BUILT = /static\/(?:chunks|media|css)\/[\w.~-]+/g;

/**
 * Drops each built file no kept page reaches, through the scripts and styles it names: otherwise every new build
 * of Sift would add its files and none would go. A page kept from an older build keeps that build's files until
 * it is drawn again.
 */
async function prune() {
  const cache = await caches.open(CACHE);
  const kept = new Map((await cache.keys()).map((request) => [new URL(request.url).pathname, request]));
  const reached = new Set();
  const next = [...kept.keys()].filter((path) => !path.startsWith('/_next/'));
  while (next.length > 0) {
    const response = await cache.match(kept.get(next.pop()));
    for (const [name] of (await response?.text())?.matchAll(BUILT) ?? []) {
      const path = `/_next/${name}`;
      if (reached.has(path)) continue;
      reached.add(path);
      if (kept.has(path) && !/\.(woff2?|png|svg|ico)$/.test(path)) next.push(path);
    }
  }
  await Promise.all([...kept].filter(([path]) => path.startsWith('/_next/') && !reached.has(path)).map(([, request]) => cache.delete(request)));
}

self.addEventListener('install', (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.add(SHELL)).then(() => self.skipWaiting())));

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || /^\/(api|auth)\//.test(url.pathname)) return;

  // The server's copy when it answers in time, since it may be newer; otherwise the one kept for that page, or else the
  // shell, which says Sift cannot be reached and loads the page once it can.
  if (request.mode === 'navigate') {
    const page = pageOf(url);
    const fetched = fetch(request).then((response) => {
      const copy = forEveryone(response) ? response.clone() : null;
      event.waitUntil(caches.open(CACHE).then(async (cache) => (copy ? await cache.put(page, copy) : undefined)).then(prune));
      return response;
    });
    const late = new Promise((resolve) => setTimeout(resolve, PATIENCE, null));
    event.respondWith(
      Promise.race([fetched.catch(() => null), late]).then(
        async (response) =>
          response ?? (await caches.match(page, { cacheName: CACHE })) ?? (await caches.match(SHELL, { cacheName: CACHE })) ?? Response.error(),
      ),
    );
    return;
  }

  // Built files are named by their content, so a kept one is never out of date.
  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const kept = await cache.match(request);
        if (kept) return kept;
        const response = await fetch(request);
        if (response.ok) void cache.put(request, response.clone());
        return response;
      }),
    );
  }
});
