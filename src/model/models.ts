import { type Api, type AuthContext, type Model, type Models, type Provider, createModels } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway';
import { registerLazyOAuthFlows } from '@earendil-works/pi-ai/lazy-oauth';
import { type SignIns, credentialStore } from './credentials.ts';
import { Refusal } from '../refusal.ts';
import { tracedFetch } from '../telemetry.ts';
import type { Reasoning } from './reasoning.ts';

/** A person's chosen model, ready to call. */
export interface ChosenModel {
  spec: string;
  models: Models;
  model: Model<Api>;
  reasoning: Reasoning;
}

// Without this pi-ai imports its OAuth flows through a variable specifier, which Vercel's file
// tracing cannot follow, so the function is deployed without them and every refresh fails.
registerLazyOAuthFlows();

/** How an install signs people in to ChatGPT (`chatgptSignIn` in `Settings`). */
export type ChatGPTSignIn = 'device-code' | 'redirect';

/**
 * A way to reach a model. `provider` is a pi-ai provider id. `device-code` and `redirect` are the two
 * ChatGPT sign-ins, of which an install offers one; `key` takes an API key.
 */
export interface ModelChoice {
  provider: string;
  label: string;
  how: ChatGPTSignIn | 'key';
}

/** ChatGPT through Sign in with ChatGPT, under an id of its own so it can sit beside an OpenAI API key. */
const CHATGPT = 'chatgpt';

/** The ways in this install offers: one ChatGPT sign-in, then the API keys. */
export function modelChoices(chatgpt: ChatGPTSignIn): ModelChoice[] {
  return [
    { provider: chatgpt === 'redirect' ? CHATGPT : 'openai-codex', label: 'ChatGPT', how: chatgpt },
    { provider: 'openai', label: 'OpenAI API key', how: 'key' },
    { provider: 'anthropic', label: 'Anthropic API key', how: 'key' },
    { provider: 'openrouter', label: 'OpenRouter API key', how: 'key' },
    { provider: 'vercel-ai-gateway', label: 'Vercel AI Gateway API key', how: 'key' },
  ];
}

/** Providers that resell many labs' models. Their ids carry the lab: `anthropic/claude-haiku-5.5`. */
const RESELLERS = new Set(['openrouter', 'vercel-ai-gateway']);

/**
 * Whether to offer a model at all. A reseller lists hundreds; classifying mail wants a small, fast one, so
 * only the major labs' small families are offered, and not a batch variant or a moving "latest" alias.
 */
export function offerModel(provider: string, id: string): boolean {
  if (!RESELLERS.has(provider)) return true;
  return /^(openai\/gpt-[\w.-]*(mini|luna)|anthropic\/claude-haiku|google\/gemini-[\w.-]*flash)/.test(id) && !/batch|latest/.test(id);
}

/**
 * Each provider's families worth classifying mail with, cheapest first, by the word their model ids carry.
 * The first is the one to suggest; the rest are there for someone who wants a stronger model.
 */
const FAMILIES: Record<string, readonly string[]> = {
  openai: ['luna', 'terra', 'sol'],
  [CHATGPT]: ['luna', 'terra', 'sol'],
  'openai-codex': ['luna', 'terra', 'sol'],
  anthropic: ['haiku', 'sonnet', 'opus'],
  google: ['flash', 'pro'],
  openrouter: ['haiku', 'luna', 'flash'],
  'vercel-ai-gateway': ['haiku', 'luna', 'flash'],
};

/** The numbers in a model id up to the first that is a date (`3-5` in `claude-3-5-haiku-20241022`). */
const version = (id: string) => {
  const numbers = (id.match(/\d+/g) ?? []).map(Number);
  const date = numbers.findIndex((n) => n >= 1000);
  return date === -1 ? numbers : numbers.slice(0, date);
};

/** Newer first; between ids of the same version the shortest, which is the plain name over a dated or variant one. */
const newer = (a: string, b: string) => {
  const [va, vb] = [version(a), version(b)];
  for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((va[i] ?? -1) !== (vb[i] ?? -1)) return (vb[i] ?? -1) - (va[i] ?? -1);
  return a.length - b.length;
};

/**
 * The models to offer before the full list: the newest of each of the provider's families among the ids it
 * returned, cheapest family first, so the first is the one to suggest. Empty for a provider sift knows no
 * families of.
 */
export function shortlistModels(provider: string, ids: readonly string[]): string[] {
  return (FAMILIES[provider] ?? []).flatMap((family) => {
    const word = new RegExp(`(^|[^a-z])${family}([^a-z]|$)`, 'i');
    const newest = ids.filter((id) => word.test(id)).toSorted(newer)[0];
    return newest ? [newest] : [];
  });
}

/**
 * A classifying call, in tokens, as a catalog price is per million of them. In: a body cut at 4,000
 * characters (about 1,000 tokens), examples up to 1,200 (`SHOT_TOKEN_BUDGET`), and the instructions and
 * labels. Out: a label and a reason of at most 300 characters.
 */
const TYPICAL_CALL: Tokens = { input: 3000, output: 150 };

export interface Tokens {
  input: number;
  output: number;
}

/** What one call of `tokens` costs at a model's catalog price, in dollars; null when the catalog has no price. */
export function priceOf(cost: { input: number; output: number }, tokens: Tokens = TYPICAL_CALL): number | null {
  const each = (tokens.input * cost.input + tokens.output * cost.output) / 1_000_000;
  return each > 0 ? each : null;
}

/** Keys in the environment and files on disk would speak for everyone; each person's sign-in is their own. */
const NOTHING_AMBIENT: AuthContext = { env: async () => undefined, fileExists: async () => false };

/**
 * pi-ai's OpenAI provider, signed in with ChatGPT only. pi-ai recognises a ChatGPT token (and leaves out
 * the request fields OpenAI refuses with one) only on a model whose provider is `openai`, so each call
 * goes out as that provider's; the models and the sign-in stay under `chatgpt`.
 */
function chatgptProvider(): Provider {
  const openai: Provider = openaiProvider();
  const models = openai.getModels().map((model) => ({ ...model, provider: CHATGPT }));
  const asOpenAI = (model: Model<Api>) => ({ ...model, provider: openai.id });
  return {
    id: CHATGPT,
    name: 'ChatGPT',
    baseUrl: openai.baseUrl,
    auth: { oauth: openai.auth.oauth },
    getModels: () => models,
    stream: (model, context, options) => openai.stream(asOpenAI(model), context, options),
    streamSimple: (model, context, options) => openai.streamSimple(asOpenAI(model), context, options),
  };
}

/**
 * One person's providers, signed in with what they stored. Each is registered by name: pi-ai's
 * `providers/all` loads every provider's catalog, and a provider nobody can sign in to from sift is only
 * more to load and to trust. Only the install's own ChatGPT sign-in is registered, so a sign-in kept from
 * the other is not used.
 */
export function openModels(signIns: SignIns, chatgpt: ChatGPTSignIn): Models {
  const models = createModels({ credentials: credentialStore(signIns), authContext: NOTHING_AMBIENT });
  const viaChatGPT = chatgpt === 'redirect' ? chatgptProvider() : openaiCodexProvider();
  for (const provider of [viaChatGPT, openaiProvider(), anthropicProvider(), openrouterProvider(), vercelAIGatewayProvider()]) models.setProvider(provider);
  return models;
}

/** Look up a `provider/model-id` spec. Throws a message the user can act on. */
export function resolveModel(models: Models, spec: string): Model<Api> {
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) throw new Refusal(`The model must look like provider/model-id, not "${spec}".`);
  const model = models.getModel(spec.slice(0, slash), spec.slice(slash + 1));
  if (!model) throw new Refusal(`Unknown model "${spec}". Choose one in the dashboard, under Settings.`);
  return model;
}

/** Codex's device-code sign-in, as pi-ai's `openai-codex` login does it, so the credential is the one pi-ai refreshes. */
const DEVICE = {
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  userCode: 'https://auth.openai.com/api/accounts/deviceauth/usercode',
  poll: 'https://auth.openai.com/api/accounts/deviceauth/token',
  verify: 'https://auth.openai.com/codex/device',
  token: 'https://auth.openai.com/oauth/token',
  redirect: 'https://auth.openai.com/deviceauth/callback',
};
const DEVICE_CODE_MS = 15 * 60_000;

/** A ChatGPT device-code sign-in waiting on the person: what they are shown, and what asking about it takes. Plain data, kept between requests. */
export interface DeviceCode {
  code: string;
  url: string;
  expiresAt: number;
  intervalMs: number;
  deviceAuthId: string;
}

/** Ask OpenAI for a code for the person to enter. Nothing has to come back to this server, so it works wherever the dashboard is. */
export async function startChatGPTDeviceCode(now: () => number = Date.now): Promise<DeviceCode> {
  const response = await tracedFetch(DEVICE.userCode, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: DEVICE.clientId }),
  });
  if (!response.ok) throw new Refusal(`OpenAI would not give a sign-in code (${response.status}).`);
  const body = (await response.json()) as Record<string, unknown>;
  const interval = Number(body['interval']);
  if (typeof body['device_auth_id'] !== 'string' || typeof body['user_code'] !== 'string' || !Number.isFinite(interval) || interval < 0)
    throw new Refusal('OpenAI answered with a sign-in code Sift cannot use.');
  return { code: body['user_code'], url: DEVICE.verify, expiresAt: now() + DEVICE_CODE_MS, intervalMs: interval * 1000, deviceAuthId: body['device_auth_id'] };
}

/**
 * Ask OpenAI once whether the person has entered the code. When they have, store the sign-in as pi-ai's own
 * login would. `slow down` asks for a longer wait before the next question. Throws with what went wrong.
 */
export async function pollChatGPTDeviceCode(signIns: SignIns, device: DeviceCode, now: () => number = Date.now): Promise<'waiting' | 'slow down' | 'done'> {
  if (now() > device.expiresAt) throw new Refusal('That code expired. Start again.');
  const response = await tracedFetch(DEVICE.poll, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.code }),
  });
  if (response.status === 403 || response.status === 404) return 'waiting';
  if (!response.ok) {
    const error = ((await response.json().catch(() => ({}))) as { error?: string | { code?: string } }).error;
    const code = typeof error === 'object' ? error.code : error;
    if (code === 'deviceauth_authorization_pending') return 'waiting';
    if (code === 'slow_down') return 'slow down';
    throw new Refusal(`OpenAI refused the sign-in (${response.status}). Start again.`);
  }
  const granted = (await response.json()) as Record<string, unknown>;
  if (typeof granted['authorization_code'] !== 'string' || typeof granted['code_verifier'] !== 'string')
    throw new Error('OpenAI answered the sign-in with something Sift cannot use.');
  const exchanged = await tracedFetch(DEVICE.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: DEVICE.clientId,
      code: granted['authorization_code'],
      code_verifier: granted['code_verifier'],
      redirect_uri: DEVICE.redirect,
    }),
  });
  if (!exchanged.ok) throw new Error(`OpenAI refused the sign-in (${exchanged.status}). Start again.`);
  const token = (await exchanged.json()) as Record<string, unknown>;
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = token;
  const accountId = typeof access === 'string' ? chatgptAccount(access) : null;
  if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expiresIn !== 'number' || !accountId)
    throw new Error('OpenAI answered the sign-in with something Sift cannot use.');
  await credentialStore(signIns).modify('openai-codex', async () => ({ type: 'oauth', access, refresh, expires: now() + expiresIn * 1000, accountId }));
  return 'done';
}

/** The ChatGPT account an access token is for, from its claims, as pi-ai reads it. */
function chatgptAccount(access: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString()) as Record<string, { chatgpt_account_id?: unknown } | undefined>;
    const id = claims['https://api.openai.com/auth']?.chatgpt_account_id;
    return typeof id === 'string' && id !== '' ? id : null;
  } catch {
    return null;
  }
}

/** Sign in with ChatGPT, as OpenAI documents it for open-source apps: no client secret, and a client registered by each sign-in. */
const SIGN_IN = {
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  /** The only address OpenAI sends the browser back to. Nothing listens there: the person pastes it. */
  redirect: 'http://127.0.0.1:1455/auth/callback',
  resource: 'https://api.openai.com/v1',
  scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
};
/** How long a Sign in with ChatGPT waits for the address. */
const REDIRECT_WAIT_MS = 10 * 60_000;
/** pi-ai refreshes a token this long before it expires; a credential stored here keeps to the same. */
const EXPIRY_MARGIN_MS = 3 * 60_000;

const randomText = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

/** A Sign in with ChatGPT waiting on the person: where to sign in, and what finishing it takes. Plain data, kept between requests. */
export interface PendingRedirect {
  url: string;
  expiresAt: number;
  state: string;
  verifier: string;
}

/**
 * Start a Sign in with ChatGPT. OpenAI sends the browser back only to 127.0.0.1:1455 on the person's own
 * machine, and sift listens on no port for it: wherever the browser is, that page fails to load, and the
 * person pastes its address into `finishChatGPTRedirect`.
 */
export async function startChatGPTRedirect(deviceId: string, now: () => number = Date.now): Promise<PendingRedirect> {
  const verifier = randomText();
  const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
  const state = randomText();
  const url = new URL(SIGN_IN.authorize);
  url.search = new URLSearchParams({
    client_id: 'dynamic_agent_client',
    agent_name_hint: 'Sift',
    ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
    response_type: 'code',
    redirect_uri: SIGN_IN.redirect,
    resource: SIGN_IN.resource,
    scope: SIGN_IN.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce: randomText(),
  }).toString();
  return { url: url.toString(), expiresAt: now() + REDIRECT_WAIT_MS, state, verifier };
}

/**
 * Finish with the address the browser was sent back to, storing the sign-in as pi-ai's own would be, so
 * pi-ai refreshes it. Rejects with what to do when the address is not the one, or OpenAI refused; until it
 * expires, opening `url` again gives a new address the same sign-in takes.
 */
export async function finishChatGPTRedirect(signIns: SignIns, pending: PendingRedirect, address: string, now: () => number = Date.now): Promise<void> {
  if (now() > pending.expiresAt) throw new Refusal('That sign-in expired. Start again.');
  let back: URL;
  try {
    back = new URL(address);
  } catch {
    throw new Refusal("Paste the whole address from the browser's address bar.");
  }
  if (`${back.origin}${back.pathname}` !== SIGN_IN.redirect)
    throw new Refusal(`That is not the address ChatGPT sent you to, which starts ${SIGN_IN.redirect}.`);
  const refused = back.searchParams.get('error');
  if (refused) throw new Refusal(`ChatGPT did not sign you in (${refused}).`);
  if (back.searchParams.get('state') !== pending.state) throw new Refusal('That address is from an earlier sign-in. Open ChatGPT from here again.');
  const code = back.searchParams.get('code');
  const clientId = back.searchParams.get('client_id');
  if (!code || !clientId) throw new Refusal('That address is missing part of what ChatGPT sent. Copy all of it.');

  const response = await tracedFetch(SIGN_IN.token, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: pending.verifier,
      redirect_uri: SIGN_IN.redirect,
      resource: SIGN_IN.resource,
    }),
  });
  if (!response.ok) throw new Refusal(`OpenAI refused the sign-in (${response.status}). Open ChatGPT again.`);
  const token = (await response.json()) as Record<string, unknown>;
  const scopes = typeof token['scope'] === 'string' ? token['scope'].split(/\s+/).filter(Boolean) : [];
  const { access_token: access, refresh_token: refresh, expires_in: expiresIn } = token;
  if (typeof access !== 'string' || typeof refresh !== 'string' || typeof expiresIn !== 'number')
    throw new Refusal('OpenAI answered the sign-in with something Sift cannot use.');
  if (!scopes.includes('chatgpt.tokens.use.direct')) throw new Refusal('ChatGPT did not allow Sift to use your plan. Open ChatGPT again and allow it.');
  await credentialStore(signIns).modify(CHATGPT, async () => ({
    type: 'oauth',
    access,
    refresh,
    expires: now() + expiresIn * 1000 - EXPIRY_MARGIN_MS,
    clientId,
    scopes,
  }));
}

/** Store an API key for `provider`. */
export async function saveApiKey(signIns: SignIns, provider: string, key: string): Promise<void> {
  await credentialStore(signIns).modify(provider, async () => ({ type: 'api_key', key }));
}
