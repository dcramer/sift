import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { People } from '../store/people.ts';
import type { z } from 'zod';
import type { Ephemeral } from '../ephemeral/ephemeral.ts';
import { FRAMES, READS, WRITES } from './api/index.ts';
import type { Context, Write } from './api/route.ts';
import { frameNote } from './mail-html.ts';
import { Refusal } from '../refusal.ts';
import { asked, forThePage, identify, httpStatus, reportError, traced } from '../telemetry.ts';
import type { Controls, SignIn } from './controls.ts';
import { type Scope, narrow, scopeFor, sees } from './scope.ts';
import { FRAME_POLICY, NOSNIFF } from './policy.ts';

/** A message's own HTML, in a frame on the page (`FRAMES`). A link it opens learns nothing of where it was opened from. */
const FRAME_HEADERS = {
  'content-security-policy': FRAME_POLICY,
  ...NOSNIFF,
  'referrer-policy': 'no-referrer',
  // A link's host would otherwise be looked up ahead of a click, which tells its DNS the message was opened.
  'x-dns-prefetch-control': 'off',
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Answered here rather than by a route module. */
const SIGN_IN_PATHS = new Set(['/auth/login', '/auth/callback', '/api/session', '/api/signout']);
/** A sign-in in flight: the PKCE verifier, whose mailbox it adds or lets send, and where to return to. */
type PendingSignIn = { verifier: string; redirectUri: string; addTo: string | null; send: string | null; to: string; expires: number };

// Data, fetched by the page: a policy or a referrer policy would govern nothing.
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...NOSNIFF, 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });

/** A path on this site: not `//host` or `/\host`, which a browser reads as another site. */
const LOCAL_PATH = /^\/(?![/\\])[^\s\\]{0,2000}$/;

const redirect = (location: string, ...cookies: string[]) => {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 303, headers });
};

const MAX_BODY = 20_000;

/**
 * What was wrong with a request, for whoever sent it: the first field refused and why. It names the
 * field, never its value.
 */
const refusedBy = (error: z.ZodError) => {
  const issue = error.issues[0];
  const field = issue?.path.join('.');
  return field ? `${field}: ${issue?.message}` : (issue?.message ?? 'That request is not well formed.');
};

/**
 * A reply that does not match its route's schema is sift's own mistake: it is not sent, since what it
 * would send is not what the page was promised.
 */
const replied = (schema: z.ZodType, body: unknown): { status: number; body: unknown } => {
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { status: 200, body: parsed.data }
    : { status: 500, body: { error: `The reply did not match its schema (${refusedBy(parsed.error)}).` } };
};

/** Read a small JSON body. Null if it is too large or not a JSON object. */
async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  let body = '';
  if (request.body) {
    const decoder = new TextDecoder();
    for await (const chunk of request.body) {
      body += decoder.decode(chunk, { stream: true });
      if (body.length > MAX_BODY) return null;
    }
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface DashboardOptions {
  /** Names and addresses, besides localhost, that the dashboard answers to. */
  allowedHosts?: readonly string[];
  /** False: the scheme in a request's URL, which says only what a proxy claimed, is not believed, and the request is taken as plain HTTP. */
  forwarded?: boolean;
  /**
   * Google sign-in. When given, the dashboard's data and controls are only for someone signed in as a
   * connected account. Without it (tests, tools) there is no check.
   */
  signIn?: SignIn;
  /** Signs session cookies. Required with `signIn`. */
  sessionSecret?: string;
  /** Where a sign-in waits between leaving for Google and coming back, which may reach another instance. Required with `signIn`. */
  ephemeral?: Ephemeral;
  /** Addresses Google can sign the user in at, to suggest when they opened the dashboard at one it cannot. */
  signInAddresses?: readonly string[];
  /** `SIFT_CLOUD`: this Sift is a service for other people, with terms, a privacy policy and a security page. */
  cloud?: boolean;
  /** Which build of the page this server came with (`SIFT_BUILD`, next.config.js), for a page left open across an update to notice. */
  build?: string | null;
  /** What the dashboard can ask the rest of sift to do. Without it the page can look but not manage. */
  controls?: Controls;
  /** Where an error goes that is Sift's own, not a `Refusal`: the page is told only that something failed. */
  log?: (line: string) => void;
  now?: () => number;
}

export interface Dashboard {
  /** Whether a request with this Host header is for the dashboard. One that is not is refused by `handle`. */
  answers: (host: string | null | undefined) => boolean;
  /** Everything but the page's own files. The scheme is the URL's, where `forwarded` believes it. */
  handle: (request: Request) => Promise<Response>;
}

const SESSION_DAYS = 30;
/** A session in use is issued again once this old, so someone who opens Sift within the month is never signed out. */
const RENEW_MS = 86_400_000;
const b64 = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** A session cookie value: which mailbox, whose, until when, signed so it cannot be forged or altered. */
function signSession(session: { email: string; person: number }, secret: string, now: number): string {
  const body = b64(JSON.stringify({ e: session.email, p: session.person, x: now + SESSION_DAYS * 86_400_000 }));
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

/** The mailbox and person a session cookie was issued to, and when it ends, or null if it is missing, forged or expired. */
function readSession(value: string | undefined, secret: string, now: number): { email: string; person: number; expires: number } | null {
  const [body, signature] = (value ?? '').split('.');
  if (!body || !signature) return null;
  const expected = Buffer.from(createHmac('sha256', secret).update(body).digest('base64url'));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const { e, p, x } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { e?: unknown; p?: unknown; x?: unknown };
    return typeof e === 'string' && typeof p === 'number' && typeof x === 'number' && x > now ? { email: e, person: p, expires: x } : null;
  } catch {
    return null;
  }
}

/** How long a sign-in started here may take to come back from Google. */
const SIGN_IN_MS = 600_000;

const same = (a: string, b: string) => {
  const [x, y] = [Buffer.from(a), Buffer.from(b)];
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
};

const cookie = (request: Request, name: string) =>
  (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];

const hostname = (host: string | null | undefined) => (host ?? '').replace(/:\d+$/, '').toLowerCase();

/**
 * The dashboard: where the user watches sift, teaches it and manages it.
 *
 * Who may use it: someone signed in with Google as a connected account. That one sign-in is also what
 * gives sift its access to the account. Requests must be addressed to localhost or one of this
 * machine's own names (which stops another website reaching it through DNS rebinding), and every write
 * must come from the dashboard's own page. The page's static files, its app manifest and service worker
 * among them, are public, hold no data and are served by the adapter; everything under `/api/` needs the
 * session.
 *
 * What it may do: change what sift has been taught and how it is set up. It never reaches Gmail itself;
 * the few things that do (signing in, undo, reading the inbox) are handed in and audited as usual.
 */
export function createDashboard(people: People, options: DashboardOptions = {}): Dashboard {
  const now = options.now ?? Date.now;
  const hosts = new Set([...LOCAL_HOSTS, ...(options.allowedHosts ?? []).map((h) => h.toLowerCase())]);
  const answers = (host: string | null | undefined) => hosts.has(hostname(host));
  const { controls, signIn } = options;
  const secret = options.sessionSecret ?? '';
  if (signIn && secret === '') throw new Error('signIn needs a sessionSecret');
  const { ephemeral } = options;
  if (signIn && !ephemeral) throw new Error('signIn needs an ephemeral store');
  const log = options.log ?? (() => {});
  const cloud = options.cloud ?? false;
  const build = options.build ?? null;
  const report = (request: Request, error: unknown) =>
    log(`${request.method} ${new URL(request.url).pathname}: ${error instanceof Error ? error.message : String(error)}`);
  /** What the page is told of an error: a refusal's own words, anything else only that it failed. */
  const failed = (request: Request, error: unknown): { status: number; error: string } => {
    if (error instanceof Refusal) return { status: 409, error: error.message };
    report(request, error);
    reportError(error);
    return { status: 500, error: 'Sift could not do that. Why is in its log.' };
  };
  /** A sign-in in flight, by the state Google echoes back: the PKCE verifier and where to return to. */
  const pendingKey = (state: string) => `signin:google:${state}`;

  const refuse = async (id: number): Promise<never> => {
    throw new Error(`Nobody is signed in to open person ${id}'s database.`);
  };
  const reads = new Map(READS.map((route) => [route.path, route]));
  const frames = new Map(FRAMES.map((route) => [route.path, route]));
  const writes = new Map(WRITES.map((route) => [route.path, route]));
  /** Why this person may not make this write, or null if they may. Someone else's data is reported as not there. */
  const refusal = async (route: Write, ctx: Context, body: unknown, scope: Scope, someone: boolean): Promise<{ status: number; error: string } | null> => {
    const whose = await route.touches(ctx, body);
    if (whose === 'self') return someone ? null : { status: 401, error: 'Sign in to use the dashboard.' };
    if (whose === null || whose === 'anyone' || sees(scope, whose.account)) return null;
    return { status: 404, error: 'There is no such thing here.' };
  };

  /** Named by its route, never by a path a stranger chose. */
  const routeOf = (path: string) => (reads.has(path) || writes.has(path) || frames.has(path) || SIGN_IN_PATHS.has(path) ? path : 'other');

  const handle = async (request: Request): Promise<Response> => {
    // The Host header, not the URL: a `node:http` adapter cannot always build a URL from it.
    const hostHeader = request.headers.get('host');
    if (!answers(hostHeader)) {
      return new Response('The Sift dashboard does not answer to this address. Set SIFT_URL to it.', {
        status: 403,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const host = hostname(hostHeader);

    const url = new URL(request.url);
    const query = url.searchParams;

    const https = options.forwarded !== false && url.protocol === 'https:';
    const origin = `${https ? 'https' : 'http'}://${hostHeader ?? ''}`;
    // Google only returns a browser to localhost or to an HTTPS address.
    const googleCanReturnHere = https || LOCAL_HOSTS.has(host);
    const issued = signIn ? readSession(cookie(request, 'sift_session'), secret, now()) : null;
    // A session is for one person: once its mailbox has been removed, and perhaps signed in to again by someone new, it is no one's.
    const found = issued !== null ? await people.signedIn(issued.email) : null;
    const known = found?.id === issued?.person ? found : null;
    const session = known ? issued!.email : null;
    // What this request may see: the mailboxes of whoever is signed in, in their own database and no
    // one else's. With no sign-in set up (tests, tools) it is the owner's.
    const person = signIn ? known : await people.owner();
    if (person) identify({ id: person.id, email: session });
    const whole = person ? scopeFor(person.accounts, person.owner) : scopeFor([], !signIn);
    const ctx: Context = {
      db: person ? await person.open(person.id) : people.nobody,
      open: person ? person.open : refuse,
      person,
      signedInAs: session,
      controls,
      said: (error) => failed(request, error).error,
      now,
    };
    const sessionCookie = (value: string, maxAge: number) =>
      `sift_session=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
    // The sign-in under way in this browser. Google's return carries the state; only the browser that
    // started the sign-in also holds it here, so a consent link sent to someone else completes nothing.
    const signInCookie = (state: string, maxAge: number) =>
      `sift_signin=${state}; Path=/auth; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${https ? '; Secure' : ''}`;
    const { method } = request;

    if (signIn && method === 'GET' && url.pathname === '/api/session') {
      const reason = !signIn.hasClient() ? 'no-client' : !googleCanReturnHere ? 'address' : null;
      // The page asks every few minutes while it is open, which is when a session is renewed.
      const renewed: Record<string, string> =
        session && issued && issued.expires - now() < SESSION_DAYS * 86_400_000 - RENEW_MS
          ? { 'set-cookie': sessionCookie(signSession({ email: session, person: issued.person }, secret, now()), SESSION_DAYS * 86_400) }
          : {};
      return json(
        200,
        {
          required: true,
          email: session,
          canSignIn: reason === null,
          reason,
          addresses: options.signInAddresses ?? [],
          cloud,
          telemetry: forThePage(),
          build,
        },
        renewed,
      );
    }
    if (signIn && method === 'GET' && url.pathname === '/auth/login') {
      // Letting Sift send is for a mailbox of whoever is signed in.
      const send = query.get('grant') === 'send' ? (query.get('mailbox') ?? '') : null;
      if (!signIn.hasClient() || !googleCanReturnHere || (send !== null && !person?.accounts.includes(send))) return redirect('/');
      const state = randomBytes(16).toString('hex');
      const verifier = randomBytes(32).toString('base64url');
      const redirectUri = `${origin}/auth/callback`;
      // Adding a second account is only for someone already signed in. `to` is where the browser started, and only
      // ever a path on this site: anything else would make the sign-in a way to send someone elsewhere.
      const to = query.get('to') ?? '';
      const pending: PendingSignIn = {
        verifier,
        redirectUri,
        addTo: query.get('add') === '1' && send === null ? session : null,
        send,
        to: LOCAL_PATH.test(to) ? to : '/',
        expires: now() + SIGN_IN_MS,
      };
      await ephemeral!.set(pendingKey(state), pending, SIGN_IN_MS);
      return redirect(signIn.url(redirectUri, state, createHash('sha256').update(verifier).digest('base64url'), send), signInCookie(state, SIGN_IN_MS / 1000));
    }
    if (signIn && method === 'GET' && url.pathname === '/auth/callback') {
      const state = query.get('state') ?? '';
      // Taken, so it completes once.
      const entry = state ? await ephemeral!.take<PendingSignIn>(pendingKey(state)) : null;
      // Someone still signed in was adding a mailbox or signing in again, so it is said in Settings, where mailboxes are; the sign-in page is only for someone signed out.
      const fail = (message: string) => redirect(`/?${session ? 'settings=1&' : ''}signin=${encodeURIComponent(message)}`, signInCookie('', 0));
      const code = query.get('code');
      if (!entry || entry.expires < now()) return fail('That sign-in expired. Try again.');
      if (!same(cookie(request, 'sift_signin') ?? '', state)) return fail('That sign-in was started in another browser. Start it again here.');
      // A mailbox joins whoever started adding it, so that person must still be the one signed in here.
      if (entry.addTo !== null && session !== entry.addTo) return fail('Sign in again, then add the mailbox.');
      if (entry.send !== null && !person?.accounts.includes(entry.send)) return fail('Sign in again, then let Sift send.');
      if (!code) return fail(query.get('error') === 'access_denied' ? 'Google did not grant access.' : 'Google did not complete the sign-in.');
      try {
        const email = await signIn.complete(entry.redirectUri, code, entry.verifier, entry.addTo, entry.send);
        if (entry.send !== null) return redirect(entry.to, signInCookie('', 0));
        const who = await people.signedIn(email);
        if (!who) return fail('Google did not complete the sign-in.');
        // A mailbox added joins whoever is signed in, who stays signed in as themselves, back in Settings where they added it.
        // One already someone else's never changes hands, and signing in as them instead is not what was asked.
        if (entry.addTo !== null)
          return who.id === person?.id ? redirect('/?settings=1', signInCookie('', 0)) : fail(`${email} is already connected to Sift by someone else.`);
        return redirect(entry.to, sessionCookie(signSession({ email, person: who.id }, secret, now()), SESSION_DAYS * 86_400), signInCookie('', 0));
      } catch (error) {
        if (error instanceof Refusal) return fail(error.message);
        report(request, error);
        return fail('Google did not complete the sign-in.');
      }
    }
    if (signIn && session === null && url.pathname.startsWith('/api/')) return json(401, { error: 'Sign in to use the dashboard.' });
    if (signIn && method === 'POST' && url.pathname === '/api/signout') return json(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
    if (!signIn && method === 'GET' && url.pathname === '/api/session')
      return json(200, { required: false, email: null, canSignIn: false, reason: null, addresses: [], cloud, telemetry: forThePage(), build });

    if (method === 'POST') {
      const handler = writes.get(url.pathname);
      // A write must come from the dashboard's own page: a browser sends Origin on every cross-site
      // request, and another site cannot set a custom header or a JSON content type without a preflight
      // this server never approves.
      let origin: string | null = null;
      try {
        origin = new URL(request.headers.get('origin') ?? '').hostname.toLowerCase();
      } catch {
        origin = null;
      }
      const fromOwnPage = origin !== null && hosts.has(origin.includes(':') ? `[${origin}]` : origin);
      if (!handler) return json(405, { error: 'Not something this dashboard does.' });
      if (!fromOwnPage || request.headers.get('x-sift') !== '1' || !(request.headers.get('content-type') ?? '').startsWith('application/json')) {
        return json(403, { error: 'This request did not come from the dashboard.' });
      }
      try {
        const raw = await readJson(request);
        if (raw === null) return json(400, { error: 'That request is not well formed.' });
        const body = handler.body.safeParse(raw);
        if (!body.success) return json(400, { error: refusedBy(body.error) });
        const refused = await refusal(handler, ctx, body.data, whole, person !== null);
        if (refused) return json(refused.status, { error: refused.error });
        const result: unknown = await handler.run(ctx, body.data, whole);
        if (result === null) return json(400, { error: 'That request is not well formed.' });
        const reply = replied(handler.reply, result);
        if (reply.status === 200 && handler.endsSession?.(reply.body)) return json(200, reply.body, { 'set-cookie': sessionCookie('', 0) });
        return json(reply.status, reply.body);
      } catch (error) {
        const { status, ...body } = failed(request, error);
        return json(status, body);
      }
    }
    if (method !== 'GET') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });

    const shown = frames.get(url.pathname);
    if (shown) {
      const mailbox = query.get('mailbox');
      const scope = mailbox ? narrow(whole, mailbox) : whole;
      const params = shown.query.safeParse(Object.fromEntries(query));
      const reply = !scope
        ? { status: 404, html: frameNote('There is no such message here.') }
        : !params.success
          ? { status: 400, html: frameNote(refusedBy(params.error)) }
          : await shown.run(ctx, scope, params.data).catch((error: unknown) => {
              const { status, error: note } = failed(request, error);
              return { status, html: frameNote(note) };
            });
      return new Response(reply.html, { status: reply.status, headers: FRAME_HEADERS });
    }
    if (url.pathname.startsWith('/api/')) {
      const route = reads.get(url.pathname);
      if (!route) return json(404, { error: 'Not found' });
      // `mailbox` narrows any read to one of the person's own mailboxes.
      const mailbox = query.get('mailbox');
      const scope = mailbox ? narrow(whole, mailbox) : whole;
      if (!scope) return json(404, { error: 'No such mailbox' });
      const params = route.query.safeParse(Object.fromEntries(query));
      if (!params.success) return json(400, { error: refusedBy(params.error) });
      try {
        const reply = await route.run(ctx, scope, params.data);
        const sent = reply.status === 200 ? replied(route.reply, reply.body) : reply;
        return json(sent.status, sent.body);
      } catch (error) {
        const { status, ...body } = failed(request, error);
        return json(status, body);
      }
    }
    return new Response('Not found', { status: 404, headers: { ...NOSNIFF, 'content-type': 'text/plain' } });
  };

  return {
    answers,
    handle: (request) => {
      const { pathname, protocol } = new URL(request.url);
      const route = routeOf(pathname);
      const server = {
        'http.request.method': request.method,
        'http.route': route,
        'url.scheme': protocol.slice(0, -1),
        'user_agent.original': request.headers.get('user-agent') ?? undefined,
      };
      return asked(request.headers, () =>
        traced('http.server', `${request.method} ${route}`, server, async (span) => {
          const response = await handle(request).catch((error: unknown) => {
            const { status, ...body } = failed(request, error);
            return json(status, body);
          });
          httpStatus(span, response.status);
          return response;
        }),
      );
    },
  };
}
