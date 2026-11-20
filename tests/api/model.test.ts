import { describe, expect, it, vi } from 'vitest';
import { type Browser, fakeGoogle, startSift } from '../fixtures.ts';
import { everyRouteAnswered } from './areas.ts';

const fake = fakeGoogle();
const ME = 'me@example.org';
const OTHER = 'other@example.com';
const CALLBACK = 'http://127.0.0.1:1455/auth/callback';

const modelOf = async (b: Browser) => (await b.call('GET', '/api/manage')).body['model'] as Record<string, unknown>;

/** OpenAI's sign-in, answering Sift's requests to it; every other request goes where it would, Google's to the fake. */
function openAI() {
  const asked: string[] = [];
  const through = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('https://auth.openai.com/')) return await through(input, init);
    asked.push(new URL(url).pathname);
    if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'da', user_code: 'ABCD-1234', interval: 5 });
    return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: 'openid resource.invoke chatgpt.tokens.use.direct' });
  });
  return asked;
}

describe('a model by API key', () => {
  it('is signed in to with a key, offers that provider’s models, and is chosen, tuned and signed out of', async () => {
    const sift = await startSift(fake.google);
    const me = await sift.settled(ME);
    expect((await me.call('GET', '/api/models')).body).toEqual({ models: [], shortlist: {}, costs: {} });

    expect((await me.call('POST', '/api/model/key', { provider: 'anthropic', key: ' sk-ant-test ' })).status).toBe(200);
    expect(sift.queued).toContainEqual({ kind: 'pass', person: 1, mailbox: 1 });
    expect(await modelOf(me)).toMatchObject({ signedIn: ['anthropic'] });
    const offered = (await me.call('GET', '/api/models')).body as { models: string[]; shortlist: Record<string, string[]> };
    expect(offered.models.length).toBeGreaterThan(0);
    expect(offered.models.every((m) => m.startsWith('anthropic/'))).toBe(true);
    expect(offered.shortlist['anthropic']!.every((m) => offered.models.includes(m))).toBe(true);

    expect((await me.call('POST', '/api/model', { model: offered.models[0] })).status).toBe(200);
    expect((await me.call('POST', '/api/model/reasoning', { reasoning: 'high' })).status).toBe(200);
    expect(await modelOf(me)).toMatchObject({ chosen: offered.models[0], reasoning: 'high' });
    expect((await me.call('POST', '/api/model', { model: 'no-provider' })).status).toBe(400);

    expect((await me.call('POST', '/api/model/signout', { provider: 'anthropic' })).status).toBe(200);
    expect(await modelOf(me)).toMatchObject({ signedIn: [] });
    expect((await me.call('POST', '/api/model', { model: null })).status).toBe(200);
    expect(await modelOf(me)).toMatchObject({ chosen: null });
  });

  it('is refused for a provider that takes no key', async () => {
    const me = await (await startSift(fake.google)).settled(ME);
    expect(await me.call('POST', '/api/model/key', { provider: 'openai-codex', key: 'sk-test' })).toMatchObject({
      status: 409,
      body: { error: 'That provider does not take an API key.' },
    });
  });

  it('is each person’s own', async () => {
    const sift = await startSift(fake.google);
    const me = await sift.settled(ME);
    await me.call('POST', '/api/model/key', { provider: 'anthropic', key: 'sk-ant-test' });
    await me.call('POST', '/api/model', { model: 'anthropic/claude-sonnet-4-5' });
    const other = await sift.settled(OTHER);
    expect(await modelOf(other)).toMatchObject({ chosen: null, signedIn: [] });
    expect((await other.call('GET', '/api/models')).body).toMatchObject({ models: [] });
    await other.call('POST', '/api/model/signout', { provider: 'anthropic' });
    expect(await modelOf(me)).toMatchObject({ chosen: 'anthropic/claude-sonnet-4-5', signedIn: ['anthropic'] });
  });
});

describe('ChatGPT', () => {
  it('signs in by a device code, which Settings shows while it waits', async () => {
    const asked = openAI();
    const me = await (await startSift(fake.google)).settled(ME);
    const started = await me.call('POST', '/api/model/chatgpt', {});
    expect(started).toMatchObject({ status: 200, body: { code: 'ABCD-1234', url: expect.stringMatching(/^https:\/\/auth\.openai\.com\//) } });
    expect(asked).toEqual(['/api/accounts/deviceauth/usercode']);
    expect(await modelOf(me)).toMatchObject({ pending: { code: 'ABCD-1234' } });
    expect(await me.call('POST', '/api/model/chatgpt/finish', { address: `${CALLBACK}?code=c` })).toMatchObject({
      status: 409,
      body: { error: 'No ChatGPT sign-in is waiting. Start again.' },
    });
  });

  it('signs in by the address ChatGPT sends the browser back to, and says what is wrong with one that is not it', async () => {
    const asked = openAI();
    const sift = await startSift(fake.google, { env: { SIFT_CHATGPT_SIGN_IN: 'redirect' } });
    const me = await sift.settled(ME);
    const started = await me.call('POST', '/api/model/chatgpt', {});
    expect(started.status).toBe(200);
    const state = new URL((started.body as { url: string }).url).searchParams.get('state');

    expect(await me.call('POST', '/api/model/chatgpt/finish', { address: `http://localhost:1455/auth/callback?code=c&state=${state}` })).toMatchObject({
      status: 409,
      body: { error: `That is not the address ChatGPT sent you to, which starts ${CALLBACK}.` },
    });
    expect(await me.call('POST', '/api/model/chatgpt/finish', { address: `${CALLBACK}?code=c&state=earlier&client_id=app` })).toMatchObject({
      status: 409,
      body: { error: 'That address is from an earlier sign-in. Open ChatGPT from here again.' },
    });
    expect(asked).toEqual([]);

    expect((await me.call('POST', '/api/model/chatgpt/finish', { address: ` ${CALLBACK}?code=c&state=${state}&client_id=app ` })).status).toBe(200);
    expect(asked).toEqual(['/api/accounts/oauth/token']);
    expect(await modelOf(me)).toMatchObject({ signedIn: ['chatgpt'], pending: null });
  });
});

everyRouteAnswered('model');
