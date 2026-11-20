import { type Api, type Model, type Models, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { memoryEphemeral, tracedEphemeral } from '../src/ephemeral/ephemeral.ts';
import { getFacts } from '../src/store/messages.ts';
import { continueEval, startEval } from '../src/learn/evals.ts';
import { calls } from '../src/gmail/call.ts';
import { proposeLabels } from '../src/learn/labels.ts';
import { draftRule } from '../src/learn/rules.ts';
import { createRuleDrafter } from '../src/model/draft-rule.ts';
import { createJudge } from '../src/model/judge.ts';
import { createHighlighter } from '../src/model/digest.ts';
import { HIGHLIGHT_TOOL } from '../src/triage/digest.ts';
import { createProposer } from '../src/model/propose.ts';
import { connectAccount, recordSync } from '../src/store/accounts.ts';
import { hashOf, traceIds } from '../src/store/content.ts';
import { VERDICT_TOOL } from '../src/triage/prompt.ts';
import { PROPOSAL_PROMPT, PROPOSAL_TOOL } from '../src/triage/proposal.ts';
import { FILL_TOOL, FIND_TOOL } from '../src/triage/rule-draft.ts';
import { deriveFacts } from '../src/triage/facts.ts';
import { loadKeyring } from '../src/secrets.ts';
import {
  asked,
  checkedIn,
  flushTelemetry,
  forThePage,
  identify,
  invokeAgent,
  logged,
  reportError,
  scrub,
  startTelemetry,
  traced,
  tracedFetch,
} from '../src/telemetry.ts';
import { triageAccount } from '../src/work/triage.ts';
import { connectGmail, fakeGoogle, firstAccount, freshStore, openUserDb, personWith, raw } from './fixtures.ts';
import { ACCOUNT, facts, SAMPLE_LABELS, storeExample } from './helpers.ts';

const fake = fakeGoogle();

const SENDER = 'billing@shop.example.com';
const SUBJECT = 'Your invoice 8812 is overdue';
const BODY = 'Pay 4,200 by Friday or your account at Acme closes.';
const REASON = 'An overdue invoice from Acme.';

type Span = { name: string; status: string; trace_id: string; span_id: string; parent_span_id?: string; attributes: Record<string, { value: unknown }> };
type Envelope = [unknown, [{ type: string }, unknown][]];

/** Everything sent to Sentry, as the transport was handed it. */
const sent: Envelope[] = [];

beforeAll(() => {
  startTelemetry('https://key@o0.ingest.example.org/1', {
    transport: () => ({ send: async (envelope) => (sent.push(envelope), {}), flush: async () => true }),
  });
});
beforeEach(() => void sent.splice(0));

/** Spans and events sent so far, after waiting for them. */
async function delivered() {
  await flushTelemetry();
  const items = sent.flatMap(([, items]) => items);
  const spans = items.filter(([header]) => header.type === 'span').flatMap(([, body]) => (body as { items: Span[] }).items);
  const events = items.filter(([header]) => header.type === 'event').map(([, body]) => body);
  const attributes = (name: string) => {
    const span = spans.find((s) => s.name === name);
    if (!span) throw new Error(`no span ${name} in ${spans.map((s) => s.name).join(', ')}`);
    return Object.fromEntries(Object.entries(span.attributes).map(([key, { value }]) => [key, value]));
  };
  const of = (type: string) => items.filter(([header]) => header.type === type).map(([, body]) => body);
  return { spans, events, attributes, of, text: JSON.stringify(sent) };
}

/** A person's database with a key, so hashes are hashes. */
async function keyedPerson() {
  const { store, db } = await personWith(loadKeyring({ SIFT_KEY: 'telemetry-key' }), ACCOUNT);
  const other = await store.user(await connectAccount(store, 'you@example.org', '1', 0));
  return { db, other };
}

const message = facts({
  messageId: 'abc123',
  from: { address: SENDER, domain: 'shop.example.com', name: 'Acme Billing' },
  subject: SUBJECT,
});

/** A provider that answers once, with a verdict and what it cost. */
function answering(): { models: Models; model: Model<Api> } {
  const model = fauxProvider().getModel();
  const answer = {
    ...fauxAssistantMessage([fauxToolCall(VERDICT_TOOL, { reason: REASON, label: 'transactional', confidence: 0.9 })], {
      stopReason: 'toolUse',
      responseId: 'resp_1',
    }),
    usage: {
      input: 900,
      output: 40,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 1040,
      cost: { input: 0.0009, output: 0.0004, cacheRead: 0.00001, cacheWrite: 0, total: 0.00131 },
    },
  };
  return { models: { completeSimple: async () => answer } as unknown as Models, model };
}

describe('the model call, as Sentry is sent it', () => {
  it('carries the model, tokens, cost and how it stopped, under the names Sentry reads, and none of the mail', async () => {
    const { models, model } = answering();
    const verdict = await createJudge(
      models,
      model,
      'low',
    )({
      evidence: { facts: message, known: deriveFacts(message), body: BODY, sender: { messagesSeen: 1, userHasWritten: false } },
      labels: SAMPLE_LABELS,
    });
    expect(verdict).toMatchObject({ label: 'transactional' });

    const { spans, attributes, text } = await delivered();
    expect(attributes(`chat ${model.id}`)).toMatchObject({
      'sentry.op': 'gen_ai.chat',
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': model.provider,
      'gen_ai.request.model': model.id,
      'gen_ai.response.finish_reasons': '["tool_call"]',
      'gen_ai.usage.input_tokens': 1000,
      'gen_ai.usage.cache_read.input_tokens': 100,
      'gen_ai.usage.output_tokens': 40,
      'gen_ai.usage.total_tokens': 1040,
      'gen_ai.cost.input_tokens': expect.closeTo(0.00091, 8),
      'gen_ai.cost.output_tokens': 0.0004,
      'gen_ai.cost.total_tokens': 0.00131,
    });
    expect(attributes(`execute_tool ${VERDICT_TOOL}`)).toMatchObject({ 'sentry.op': 'gen_ai.execute_tool', 'gen_ai.tool.name': VERDICT_TOOL });
    expect(spans).toHaveLength(2);
    for (const content of [SUBJECT, BODY, REASON, SENDER, 'Acme Billing', 'transactional', 'shop.example.com']) expect(text).not.toContain(content);
  });

  it('is found by the run it was recorded as, and its message by keyed hashes', async () => {
    const { db } = await keyedPerson();
    await recordSync(db, ACCOUNT, [message], '2', 0);
    const { models, model } = answering();
    await triageAccount(
      { db, mailbox: null, model: { judge: createJudge(models, model, 'low'), model: 'faux/model' }, sources: connectGmail(fake.google) },
      await firstAccount(db),
    );

    const { attributes, text } = await delivered();
    const run = await raw(db).get<{ id: number }>('SELECT id FROM model_runs');
    const decision = await raw(db).get<{ id: number; disposition: string }>('SELECT id, disposition FROM decisions');
    const ids = { 'sift.message': hashOf(db, 'abc123'), 'sift.sender': hashOf(db, SENDER), 'sift.domain': hashOf(db, 'shop.example.com') };
    expect(attributes('triage')).toMatchObject({ ...ids, 'sift.decision_id': decision!.id, 'sift.stage': 'model' });
    const conversation = { 'gen_ai.agent.name': 'triage', 'gen_ai.conversation.id': `triage-${db.person}-${run!.id}` };
    expect(attributes('invoke_agent triage')).toMatchObject({ ...ids, ...conversation, 'sentry.op': 'gen_ai.invoke_agent', 'sift.run_id': run!.id });
    expect(attributes(`chat ${model.id}`)).toMatchObject({ ...ids, ...conversation, 'sift.run_id': run!.id });
    expect(attributes(`execute_tool ${VERDICT_TOOL}`)).toMatchObject(conversation);
    expect(attributes('model')).toMatchObject({ 'sentry.op': 'sift.tier', 'sift.outcome': decision!.disposition });
    for (const content of [SUBJECT, SENDER, 'abc123']) expect(text).not.toContain(content);
  });
});

describe('each conversation with the model', () => {
  /** A provider that gives `answers` in turn. */
  function scripted(...answers: ReturnType<typeof fauxAssistantMessage>[]) {
    const provider = fauxProvider();
    const models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses(answers);
    return { models, model: provider.getModel() };
  }
  const GOAL = 'Archive the Acme digest';

  it('is a rule draft: its turns and each tool the model used, all under one id, with none of what was asked', async () => {
    const { db } = await keyedPerson();
    const { models, model } = scripted(
      fauxAssistantMessage([fauxToolCall(FIND_TOOL, { query: 'acme digest' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(
        [
          fauxToolCall(FILL_TOOL, {
            conditions: [{ by: 'from', value: 'shop.example.com' }],
            facts: [],
            name: '',
            label: '',
            onlyOnceLabelled: false,
            when: '',
            action: 'archive',
            markRead: false,
            unsubscribe: false,
            note: '',
          }),
        ],
        { stopReason: 'toolUse' },
      ),
    );
    await draftRule({ db, draft: createRuleDrafter(models, model, 'low'), model: 'faux/model' }, { accountId: ACCOUNT, goal: GOAL });

    const { spans, text } = await delivered();
    const draft = await raw(db).get<{ id: number }>('SELECT id FROM rule_drafts');
    const id = `rules-${db.person}-${draft!.id}`;
    expect(spans.map((s) => [s.name, s.attributes['gen_ai.conversation.id']?.value, s.attributes['gen_ai.agent.name']?.value])).toEqual(
      expect.arrayContaining([
        ['invoke_agent rules', id, 'rules'],
        [`chat ${model.id}`, id, 'rules'],
        [`execute_tool ${FIND_TOOL}`, id, 'rules'],
        [`execute_tool ${FILL_TOOL}`, id, 'rules'],
      ]),
    );
    expect(spans.filter((s) => s.name === `chat ${model.id}`)).toHaveLength(2);
    for (const content of [GOAL, 'acme digest', 'shop.example.com']) expect(text).not.toContain(content);
  });

  it('is a test run’s message, named by where it is in the run', async () => {
    const { db } = await keyedPerson();
    await storeExample(db, ACCOUNT, { id: 'abc123', from: SENDER, label: 'transactional', subject: SUBJECT, body: BODY });
    const { models, model } = answering();
    const deps = { db, judge: createJudge(models, model, 'low'), model: 'faux/model' };
    const run = await startEval(deps, { accountId: ACCOUNT, fewShot: false });
    expect(await continueEval(deps, run, Infinity)).toBe(true);

    const { attributes, text } = await delivered();
    const conversation = { 'gen_ai.agent.name': 'eval', 'gen_ai.conversation.id': `eval-${db.person}-${run}-0` };
    expect(attributes('invoke_agent eval')).toMatchObject({ ...conversation, 'sift.eval_run': run, 'sift.message': hashOf(db, 'abc123') });
    expect(attributes(`chat ${model.id}`)).toMatchObject(conversation);
    for (const content of [SUBJECT, BODY, SENDER, 'abc123']) expect(text).not.toContain(content);
  });

  it('is a digest’s picks, shown mail, so none of what it was asked or answered', async () => {
    const { db } = await keyedPerson();
    const { models, model } = scripted(fauxAssistantMessage([fauxToolCall(HIGHLIGHT_TOOL, { picks: [{ item: 1, why: REASON }] })], { stopReason: 'toolUse' }));
    const highlight = createHighlighter(models, model, 'low');
    const answer = await invokeAgent('digest', [db.person, 4], { 'sift.digest': 4 }, () =>
      highlight({
        label: { name: 'Bills', description: 'Invoices.' },
        lines: [{ fromName: 'Acme Billing', fromAddress: SENDER, subject: SUBJECT, received: 'Wed 6:00 AM' }],
      }),
    );
    expect(answer).toMatchObject({ picks: [{ item: 1, why: REASON }] });

    const { spans, attributes, text } = await delivered();
    const id = `digest-${db.person}-4`;
    expect(attributes('invoke_agent digest')).toMatchObject({ 'gen_ai.agent.name': 'digest', 'gen_ai.conversation.id': id, 'sift.digest': 4 });
    expect(spans.filter((s) => s.attributes['gen_ai.conversation.id']?.value === id).map((s) => s.name)).toEqual(
      expect.arrayContaining(['invoke_agent digest', `chat ${model.id}`, `execute_tool ${HIGHLIGHT_TOOL}`]),
    );
    for (const content of [SUBJECT, SENDER, REASON, 'Acme Billing']) expect(text).not.toContain(content);
  });

  it('is a label proposal, and the next one is another', async () => {
    const { db } = await keyedPerson();
    const PITCHES = { why: 'w', name: 'Sales pitches', description: 'Pitches.', action: 'archive', markRead: false, unsubscribe: true };
    const answer = () => fauxAssistantMessage([fauxToolCall(PROPOSAL_TOOL, { labels: [PITCHES] })], { stopReason: 'toolUse' });
    const { models, model } = scripted(answer(), answer());
    const propose = createProposer(models, model, 'low');
    await proposeLabels({ db, propose, model: 'faux/model' }, { accountId: ACCOUNT, goal: GOAL });
    await proposeLabels({ db, propose, model: 'faux/model' }, { accountId: ACCOUNT, goal: GOAL });

    const { spans, text } = await delivered();
    const ids = (await raw(db).all<{ id: number }>('SELECT id FROM label_proposals ORDER BY id')).map((p) => `labels-${db.person}-${p.id}`);
    expect(ids).toHaveLength(2);
    for (const id of ids)
      expect(spans.filter((s) => s.attributes['gen_ai.conversation.id']?.value === id).map((s) => s.name)).toEqual(
        expect.arrayContaining(['invoke_agent labels', `chat ${model.id}`, `execute_tool ${PROPOSAL_TOOL}`]),
      );
    // Never shown mail, so its prompt and answer are on the call's span, in OpenTelemetry's form.
    const call = spans.find((s) => s.name === `chat ${model.id}`)!.attributes;
    const read = (key: string) => JSON.parse(String(call[key]?.value)) as unknown;
    expect(read('gen_ai.system_instructions')).toEqual([{ type: 'text', content: PROPOSAL_PROMPT }]);
    expect(read('gen_ai.input.messages')).toEqual([{ role: 'user', parts: [{ type: 'text', content: expect.stringContaining(GOAL) }] }]);
    expect(read('gen_ai.tool.definitions')).toEqual([expect.objectContaining({ type: 'function', name: PROPOSAL_TOOL })]);
    expect(read('gen_ai.output.messages')).toEqual([
      {
        role: 'assistant',
        parts: [expect.objectContaining({ type: 'tool_call', name: PROPOSAL_TOOL, arguments: { labels: [PITCHES] } })],
        finish_reason: 'tool_call',
      },
    ]);
    expect(text).toContain('Sales pitches');
  });
});

describe('whom a trace is for', () => {
  it('is the person a request or piece of work says, on every span and error in it and none beside it', async () => {
    const OTHER = 'you@example.org';
    const request = (id: number, email: string) =>
      traced('http.server', `GET ${id}`, {}, async () => {
        identify({ id, email });
        await new Promise((resolve) => setTimeout(resolve, 5));
        await traced('sift.action', `change ${id}`, {}, async () => reportError(new Error(`refused ${id}`)));
      });
    await Promise.all([request(1, ACCOUNT), request(2, OTHER)]);

    const { attributes, events } = await delivered();
    expect(attributes('GET 1')).toMatchObject({ 'user.id': '1', 'user.email': ACCOUNT });
    expect(attributes('change 1')).toMatchObject({ 'user.id': '1', 'user.email': ACCOUNT });
    expect(attributes('GET 2')).toMatchObject({ 'user.id': '2', 'user.email': OTHER });
    expect(attributes('change 2')).toMatchObject({ 'user.id': '2', 'user.email': OTHER });
    const users = Object.fromEntries(
      (events as { exception: { values: { value: string }[] }; user: unknown }[]).map((e) => [e.exception.values[0]!.value, e.user]),
    );
    expect(users).toEqual({ 'refused 1': { id: '1', email: ACCOUNT }, 'refused 2': { id: '2', email: OTHER } });
  });
});

describe('a request from the page', () => {
  const TRACE = '0123456789abcdef0123456789abcdef';
  const PAGE_SPAN = '0123456789abcdef';
  const fromPage = new Headers({ 'sentry-trace': `${TRACE}-${PAGE_SPAN}-1`, baggage: `sentry-trace_id=${TRACE},sentry-sampled=true` });

  it('is under the page load or press that made it', async () => {
    await asked(fromPage, () => traced('http.server', 'GET /api/suggestions', {}, async () => {}));
    const { spans } = await delivered();
    expect(spans.map((s) => [s.name, s.trace_id, s.parent_span_id])).toEqual([['GET /api/suggestions', TRACE, PAGE_SPAN]]);
  });

  it('read for the frame stays under the frame', async () => {
    await traced('sift.frame', 'frame', {}, () => asked(fromPage, () => traced('http.server', 'GET /api/session', {}, async () => {})));
    const { spans } = await delivered();
    const frame = spans.find((s) => s.name === 'frame')!;
    expect(frame.trace_id).not.toBe(TRACE);
    expect(spans.find((s) => s.name === 'GET /api/session')).toMatchObject({ trace_id: frame.trace_id, parent_span_id: frame.span_id });
  });

  it('is told where the page sends its own', () => {
    expect(forThePage()).toMatchObject({ dsn: 'https://key@o0.ingest.example.org/1' });
  });
});

describe('a Gmail request', () => {
  const call = calls(async () => {});
  const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

  it('is named by its path with the ids left out, and a message that is gone is an answer, not a failure', async () => {
    expect(await call('users.messages.get', 20, async () => ({ data: 'labels', status: 200 }))).toBe('labels');
    const gone = Object.assign(new Error('Not Found'), { status: 404 });
    await expect(call('users.threads.get', 40, () => Promise.reject(gone))).rejects.toBe(gone);
    await expect(call('users.labels.list', 1, () => Promise.reject(Object.assign(new Error('Backend Error'), { status: 500 })))).rejects.toThrow();

    const { spans, attributes } = await delivered();
    expect(attributes(`GET ${GMAIL}/messages/{id}`)).toMatchObject({
      'sentry.op': 'http.client',
      'http.request.method': 'GET',
      'server.address': 'gmail.googleapis.com',
      'server.port': 443,
      'url.template': '/gmail/v1/users/me/messages/{id}',
      'http.response.status_code': 200,
      'sift.quota_units': 20,
    });
    expect(attributes(`GET ${GMAIL}/labels`)).toMatchObject({ 'http.response.status_code': 500, 'error.type': '500' });
    expect(spans.map((s) => [s.name, s.status])).toEqual([
      [`GET ${GMAIL}/messages/{id}`, 'ok'],
      [`GET ${GMAIL}/threads/{id}`, 'ok'],
      [`GET ${GMAIL}/labels`, 'error'],
    ]);
  });
});

describe('the rest of what a trace shows', () => {
  it('has each database statement, without its values, and only under a span', async () => {
    const db = await openUserDb(ACCOUNT);
    await recordSync(db, ACCOUNT, [message], '2', 0);
    await traced('sift.work', 'pass', {}, async () => void (await getFacts(db, ACCOUNT, 'abc123')));

    const { spans, text } = await delivered();
    const queries = spans.filter((s) => s.attributes['sentry.op']?.value === 'db');
    expect(queries.length).toBeGreaterThan(0);
    const select = queries.find((s) => s.attributes['db.operation.name']?.value === 'SELECT')!;
    expect(select.name).toMatch(/\$1/);
    expect(select.attributes).toMatchObject({ 'db.system.name': { value: 'postgresql' }, 'db.query.text': { value: select.name } });
    // The sync ran outside any span: its statements are not traces of their own.
    expect(new Set(spans.map((s) => s.trace_id)).size).toBe(1);
    for (const content of [SUBJECT, SENDER, 'abc123']) expect(text).not.toContain(content);
  });

  it('has each short-lived read and write, named by the kind of key alone', async () => {
    const ephemeral = tracedEphemeral(memoryEphemeral());
    await traced('sift.work', 'pass', {}, async () => {
      await ephemeral.get('signin:secret-state');
      await ephemeral.set('signin:secret-state', { a: 1 }, 60_000);
      await ephemeral.take('signin:secret-state');
      await ephemeral.claim('upkeep:1:20000', 1000);
    });

    const { spans, text } = await delivered();
    expect(spans.map((s) => [s.name, s.attributes['sentry.op']?.value, s.attributes['cache.hit']?.value])).toEqual([
      ['signin', 'cache.get', false],
      ['signin', 'cache.put', undefined],
      ['signin', 'cache.get', true],
      ['SET upkeep', 'db', undefined],
      ['pass', 'sift.work', undefined],
    ]);
    for (const content of ['secret-state', ACCOUNT]) expect(text).not.toContain(content);
  });

  it('names a call out by its address, and leaves the query off', async () => {
    const server = createServer((_request, response) => response.writeHead(202).end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await traced('sift.work', 'pass', {}, () => tracedFetch(`http://127.0.0.1:${port}/token?code=secret`, { method: 'POST' }));
    } finally {
      server.close();
    }

    const { attributes, text } = await delivered();
    const url = `http://127.0.0.1:${port}/token`;
    expect(attributes(`POST ${url}`)).toMatchObject({ 'sentry.op': 'http.client', 'url.full': url, 'server.port': port, 'http.response.status_code': 202 });
    expect(text).not.toContain('secret');
  });

  it('says what kind of error failed a span, never its words', async () => {
    await expect(traced('sift.work', 'pass', {}, async () => Promise.reject(new TypeError(`bad ${SENDER}`)))).rejects.toThrow();
    const { attributes } = await delivered();
    expect(attributes('pass')).toMatchObject({ 'error.type': 'TypeError' });
  });

  it('sends what the host logs, scrubbed, and checks the tick in', async () => {
    await checkedIn(async () => logged(`${SENDER}: pass failed`));
    const { of, text } = await delivered();
    expect(JSON.stringify(of('log'))).toContain('[address]: pass failed');
    expect(of('check_in').map((c) => [(c as { monitor_slug: string }).monitor_slug, (c as { status: string }).status])).toEqual([
      ['tick', 'in_progress'],
      ['tick', 'ok'],
    ]);
    expect(text).not.toContain(SENDER);
  });
});

describe('the hashes a trace names a message by', () => {
  it('are the ones its record is found by, the same each time, and differ for another person', async () => {
    const { db, other } = await keyedPerson();
    const ids = traceIds(db, 'abc123', message.from);
    expect(traceIds(db, 'abc123', message.from)).toEqual(ids);
    expect(ids['sift.sender']).toBe(hashOf(db, SENDER));
    await recordSync(db, ACCOUNT, [message], '2', 0);
    expect(await raw(db).get('SELECT sender_hash, domain_hash FROM messages')).toEqual({ sender_hash: ids['sift.sender'], domain_hash: ids['sift.domain'] });
    expect(Object.values(ids).join(' ')).not.toMatch(/abc123|example/);
    expect(traceIds(other, 'abc123', message.from)['sift.sender']).not.toBe(ids['sift.sender']);
  });

  it('are left out without a key, where a hash would be the address itself', async () => {
    const store = await freshStore();
    const db = await store.user(await connectAccount(store, ACCOUNT, '1', 0));
    expect(traceIds(db, 'abc123', message.from)).toEqual({});
  });
});

describe('the scrubber', () => {
  it('replaces any address, anywhere, except the account the span is for, and drops prompt and answer', () => {
    expect(
      scrub({
        name: `triage for ${SENDER}`,
        attributes: {
          'user.email': { value: ACCOUNT },
          note: { value: `from a%40example.com and <${SENDER}>` },
          'gen_ai.input.messages': { value: BODY },
          'gen_ai.output.messages': { value: REASON },
        },
        list: [[`x ${SENDER}`]],
      }),
    ).toEqual({
      name: 'triage for [address]',
      attributes: { 'user.email': { value: ACCOUNT }, note: { value: 'from [address] and <[address]>' } },
      list: [['x [address]']],
    });
  });

  it('lets a prompt out only from an agent never shown mail, with its addresses replaced all the same', async () => {
    for (const agent of ['labels', 'triage', 'rules'])
      await traced('gen_ai.chat', `chat ${agent}`, { 'gen_ai.agent.name': agent, 'gen_ai.input.messages': `${BODY} ${SENDER}` }, async () => {});
    const { attributes } = await delivered();
    expect(attributes('chat labels')['gen_ai.input.messages']).toBe(`${BODY} [address]`);
    expect(attributes('chat triage')).not.toHaveProperty('gen_ai.input.messages');
    expect(attributes('chat rules')).not.toHaveProperty('gen_ai.input.messages');
  });

  it('runs on every span and error on the way out', async () => {
    await traced('sift.work', `pass ${SENDER}`, { 'user.email': ACCOUNT, slipped: `sender ${SENDER}`, 'gen_ai.input.messages': BODY }, async () => {
      reportError(new Error(`Gmail refused the change for ${SENDER}`));
    });
    const { events, attributes, text } = await delivered();
    expect(attributes('pass [address]')).toMatchObject({ 'user.email': ACCOUNT, slipped: 'sender [address]' });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).toContain('Gmail refused the change for [address]');
    for (const content of [SENDER, BODY]) expect(text).not.toContain(content);
  });
});
