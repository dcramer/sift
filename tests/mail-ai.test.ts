import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import { askMail } from '../src/learn/mail.ts';
import { createMailAsker } from '../src/model/ask.ts';
import { loadKeyring } from '../src/secrets.ts';
import { recordSync } from '../src/store/accounts.ts';
import { ASK_TOOL, type MailAsker, readMailFilter } from '../src/triage/mail-ask.ts';
import { FIND_TOOL } from '../src/triage/rule-draft.ts';
import { personWith, raw } from './fixtures.ts';
import { SAMPLE_LABELS, facts } from './helpers.ts';

const reportError = vi.hoisted(() => vi.fn());
vi.mock('../src/telemetry.ts', async (actual) => ({ ...(await actual<object>()), reportError }));

const ACCOUNT = 'me@example.com';
const KEYS = loadKeyring({ SIFT_KEY: 'mail-ai-key' });
const LABELS = SAMPLE_LABELS.filter((l) => l.id === 'newsletter' || l.id === 'marketing');
const TODAY = '2026-11-19';
const BLANK = { reading: '', from: [], domains: [], label: '', view: '', unread: false, since: '', words: [], note: '' };
const FOUND = [{ address: 'billing@vendor.example.org', name: 'Vendor', listId: null, messages: 3, label: null, subject: 'Your invoice' }];
const usage = { model: 'p/m', inputTokens: 10, outputTokens: 20, costUsd: 0.01 };

function faux() {
  const provider = fauxProvider();
  const models = createModels();
  models.setProvider(provider.provider);
  return { provider, complete: vi.spyOn(models, 'completeSimple'), models, model: provider.getModel() };
}

describe('the filter the model makes', () => {
  const read = (args: Record<string, unknown>, found = FOUND) => {
    const result = readMailFilter({ ...BLANK, ...args }, { labels: LABELS, today: TODAY }, found);
    return 'answer' in result ? result.answer : result;
  };

  it('holds only what the list narrows by, with a label by its id and a day no later than today', () => {
    expect(
      read({
        from: ['Billing@Vendor.example.org'],
        domains: ['@vendor.example.org'],
        label: 'newsletters',
        view: 'needs me',
        unread: true,
        since: '2026-11-01',
        words: [' invoice ', 'invoice', ''],
        note: 'Sift does not know what you answered.',
      }),
    ).toEqual({
      filter: {
        from: ['billing@vendor.example.org'],
        domain: ['vendor.example.org'],
        label: 'newsletter',
        view: 'needs',
        unread: true,
        since: '2026-11-01',
        words: ['invoice'],
      },
      note: 'Sift does not know what you answered.',
    });
    expect(read({ label: 'Receipts' })).toEqual({ unusable: '`label` is not one of theirs' });
    expect(read({ since: '2026-12-01' })).toHaveProperty('unusable');
    expect(read({ since: '2026-02-30' })).toHaveProperty('unusable');
  });

  it('refuses a sender no look-up returned, rather than narrow the list to a guess', () => {
    expect(read({ from: ['invented@vendor.example.org'] })).toEqual({
      unusable: `${FIND_TOOL} did not return invented@vendor.example.org: look the sender up, or leave them out`,
    });
    expect(read({ domains: ['example.net'] }, [])).toHaveProperty('unusable');
  });

  it('says in words why nothing narrows the list when the model made no filter', () => {
    expect(read({ note: 'The list cannot tell what you replied to.' })).toEqual({ cannot: 'The list cannot tell what you replied to.' });
    expect(read({})).toEqual({ cannot: 'Nothing in that narrows the list.' });
  });
});

describe('the model turning words into a filter', () => {
  const input = { words: 'invoices from vendors this month', today: TODAY, labels: LABELS };

  it('looks senders up, is given today and their labels, and narrows to what it found', async () => {
    const { provider, complete, models, model } = faux();
    provider.setResponses([
      fauxAssistantMessage([fauxToolCall(FIND_TOOL, { query: 'invoice' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall(ASK_TOOL, { ...BLANK, domains: ['vendor.example.org'], since: '2026-11-01' })], { stopReason: 'toolUse' }),
    ]);
    const asked: string[] = [];
    const answer = await createMailAsker(models, model, 'low')(input, async (query) => (asked.push(query), FOUND));
    expect(answer).toMatchObject({ filter: { domain: ['vendor.example.org'], since: '2026-11-01' }, lookups: 1 });
    expect(asked).toEqual(['invoice']);
    const prompt = JSON.stringify(complete.mock.calls[0]?.[1].messages[0]?.content);
    expect(prompt).toContain(TODAY);
    expect(prompt).toContain('Newsletters');
    expect(complete.mock.calls[0]?.[1].tools?.map((t) => t.name)).toEqual([FIND_TOOL, ASK_TOOL]);
  });

  it('sends back a sender it made up, once, and fails when it makes one up again', async () => {
    const { provider, complete, models, model } = faux();
    const invented = fauxToolCall(ASK_TOOL, { ...BLANK, from: ['ap@vendor.example.org'] });
    provider.setResponses([
      fauxAssistantMessage([invented], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall(ASK_TOOL, { ...BLANK, from: ['ap@vendor.example.org'] })], { stopReason: 'toolUse' }),
    ]);
    expect(await createMailAsker(models, model, 'low')(input, async () => FOUND)).toMatchObject({
      failed: expect.stringContaining('did not return ap@vendor.example.org'),
    });
    expect(complete.mock.calls[1]?.[1].messages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: invented.id, isError: true });
  });

  it('asks once more when the model answers in words', async () => {
    const { provider, models, model } = faux();
    provider.setResponses([
      fauxAssistantMessage([fauxText('You want invoices.')]),
      fauxAssistantMessage([fauxToolCall(ASK_TOOL, { ...BLANK, words: ['invoice'] })], { stopReason: 'toolUse' }),
    ]);
    expect(await createMailAsker(models, model, 'low')(input, async () => [])).toMatchObject({ filter: { words: ['invoice'] }, lookups: 0 });
  });
});

describe('asking Inbox in words', () => {
  it('records the call with what it cost, its words and answer encrypted, after looking up only the person’s senders', async () => {
    const { db } = await personWith(KEYS, ACCOUNT);
    await recordSync(
      db,
      ACCOUNT,
      [facts({ accountId: ACCOUNT, messageId: 'm1', from: { address: 'billing@vendor.example.org', domain: 'vendor.example.org' } })],
      '2',
    );
    const ask: MailAsker = async (given, find) => {
      expect(given).toMatchObject({ words: 'Vendor bills', today: TODAY });
      expect((await find('vendor')).map((s) => s.address)).toEqual(['billing@vendor.example.org']);
      return { filter: { from: ['billing@vendor.example.org'] }, usage, lookups: 1 };
    };
    expect(await askMail({ db, ask, model: 'p/m', now: () => 5 }, { accountId: ACCOUNT, words: 'Vendor bills', today: TODAY })).toEqual({
      filter: { from: ['billing@vendor.example.org'] },
    });
    const row = await raw(db).get('SELECT * FROM mail_asks');
    expect(row).toMatchObject({ model: 'p/m', started_at: 5, finished_at: 5, lookups: 1, input_tokens: 10, cost_usd: 0.01, error: null });
    expect(JSON.stringify(row)).not.toContain('endor');
  });

  it('records a failed call and refuses with what went wrong', async () => {
    const { db } = await personWith(KEYS, ACCOUNT);
    const failing: MailAsker = async () => ({ failed: 'rate limited', usage, lookups: 0 });
    await expect(askMail({ db, ask: failing, model: 'p/m' }, { accountId: ACCOUNT, words: 'x', today: TODAY })).rejects.toThrow('rate limited');
    expect(reportError).toHaveBeenCalledWith(new Error('Asking failed: rate limited'));
    expect(await raw(db).all('SELECT error, answer, cost_usd FROM mail_asks')).toEqual([{ error: 'rate limited', answer: null, cost_usd: 0.01 }]);
  });
});
