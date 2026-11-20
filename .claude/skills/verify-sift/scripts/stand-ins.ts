/**
 * Preloaded into the Next.js server `serve.ts` starts (`NODE_OPTIONS=--import`), before any of Sift loads: it
 * offers the app stand-ins for what Sift reaches outside this machine for (`StandIns`, src/sift/sift.ts). Everything
 * else is the real app on the seeded home.
 *
 * - Gmail: nothing has happened since the seed's last pass, and each mailbox's filters and messages' labels are a fake
 *   mailbox's, starting from those the seed left in the file `SIFT_STAND_INS` names and written back there as they change.
 *   Mail sent goes nowhere: each is added to `sent.json` beside that file, as `{ mailbox, id, threadId, raw }`.
 *   A search of the inbox finds nothing, or with `SIFT_STAND_INS_LISTING` set is still being listed for good, so
 *   applying a rule stays under way until it is stopped.
 * - The model that suggests labels, drafts rules and asks Inbox, a stand-in. Drafting looks up the second
 *   line of its prompt (the words the person typed), then fills in a rule archiving and marking read mail from the
 *   first sender found, with a note naming the second; nothing found fills in `nobody@example.com`. Asking looks up
 *   the words before any "about" the same way and narrows Inbox to the first sender found, searching for the words after it,
 *   or with neither says Sift cannot tell which mail you have answered. Suggesting gives Sales pitches when
 *   the words name pitches, Build results (Digest) when they name builds, and notes that Receipts and transactions
 *   covers receipts already when they name receipts; words naming none of these are an unusable answer. A pass is given no model.
 * - What Gmail would count: for Inbox's copy, 8,240 messages in the last year, 21,500 in three and 46,800 in all; an inbox
 *   of 2,412 messages (the newest 300 while setting up), three in four needing
 *   the model at about a tenth of a cent each; and for any rule about 1,240 messages it would decide, the newest
 *   five `Found in Gmail 1` to `5`, none needing the model.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { ExistingFilter } from '../../../../src/actions/filters.ts';
import type { StandIns } from '../../../../src/sift/sift.ts';
import type { GmailApi } from '../../../../src/gmail/api.ts';
import { PROPOSAL_TOOL } from '../../../../src/triage/proposal.ts';
import { FILL_TOOL, FIND_TOOL } from '../../../../src/triage/rule-draft.ts';
import { ASK_TOOL } from '../../../../src/triage/mail-ask.ts';
import { FakeMailbox } from '../../../../tests/helpers.ts';
import { seal } from '../../../../src/plain.ts';

const file = process.env['SIFT_STAND_INS'];
if (!file) throw new Error('SIFT_STAND_INS names no file of filters');
const saved = JSON.parse(readFileSync(file, 'utf8')) as { filters: Record<string, ExistingFilter[]>; labels: Record<string, Record<string, string[]>> };

const sentFile = join(dirname(file), 'sent.json');

/** A mailbox whose filters and labels are written back to the file each time they change, and whose sent mail is written down. */
class SavedMailbox extends FakeMailbox {
  readonly address: string;
  constructor(address: string) {
    super();
    this.address = address;
  }
  override async send(message: { raw: string; threadId?: string }) {
    const sent = await super.send(message);
    const before = existsSync(sentFile) ? (JSON.parse(readFileSync(sentFile, 'utf8')) as unknown[]) : [];
    writeFileSync(sentFile, JSON.stringify([...before, { mailbox: this.address, ...sent, raw: message.raw }], null, 1));
    return sent;
  }
  override async modifyLabels(...args: Parameters<FakeMailbox['modifyLabels']>) {
    const after = await super.modifyLabels(...args);
    save();
    return after;
  }
  override async createFilter(...args: Parameters<FakeMailbox['createFilter']>) {
    const made = await super.createFilter(...args);
    save();
    return made;
  }
  override async deleteFilter(id: string) {
    await super.deleteFilter(id);
    save();
  }
}
const mailboxes = new Map<string, SavedMailbox>();
const save = () =>
  writeFileSync(
    file,
    JSON.stringify(
      {
        filters: Object.fromEntries([...mailboxes].map(([id, m]) => [id, m.filters])),
        labels: Object.fromEntries([...mailboxes].map(([id, m]) => [id, Object.fromEntries(m.labels)])),
      },
      null,
      1,
    ),
  );
const mailboxOf = (address: string) => {
  let mailbox = mailboxes.get(address);
  if (!mailbox) {
    mailbox = new SavedMailbox(address);
    mailbox.filters = saved.filters[address] ?? [];
    mailbox.labels = new Map(Object.entries(saved.labels[address] ?? {}));
    mailboxes.set(address, mailbox);
  }
  return mailbox;
};

const listing = Boolean(process.env['SIFT_STAND_INS_LISTING']);
/** A Gmail where nothing has happened since the seed's last pass. */
const nothingNew = (address: string): GmailApi => ({
  getProfile: async () => ({ emailAddress: address, historyId: '1' }),
  listHistory: async () => ({ additions: [], historyId: '1' }),
  searchInbox: listing ? () => new Promise<never>(() => {}) : async () => ({ ids: [] }),
  inboxSize: async () => 0,
  searchMail: async () => ({ ids: [] }),
  mailboxSize: async () => 0,
  getMessage: async () => null,
  getMetadata: async () => null,
  getLabelIds: async () => null,
  listLabels: async () => [],
  getContent: async () => null,
  getThread: async () => null,
  listSendAs: async () => [address],
});

/** What the stand-in reads of a call: the tools it is given come in a message of their own. */
type Context = { messages: readonly { role: string; content: unknown; toolsAdded?: readonly { name: string }[] }[] };

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
/** The words the person typed: the second line of the prompt. */
const typed = (context: Context) => String(context.messages.find((m) => m.role === 'user')?.content).split('\n')[1] ?? '';
/** What an Ask is about: the words after "about", which it searches the mail for. */
const about = (context: Context) => (typed(context).split(' about ')[1] ?? '').split(/\s+/).filter((w) => w !== '');
// The rest of what `fill_rule` requires (src/model/draft-rule.ts), unused.
const blank = { reading: '', facts: [], name: '', label: '', onlyOnceLabelled: false, when: '', markRead: true, unsubscribe: false };
const PITCHES = {
  why: 'fewer pitches',
  name: 'Sales pitches',
  description: 'Unsolicited sales pitches from strangers and their follow-ups.',
  action: 'archive',
  markRead: false,
  unsubscribe: true,
};
const BUILDS = {
  why: 'builds only when one fails',
  name: 'Build results',
  description: 'Automated results of builds and test runs, passed or failed.',
  action: 'digest',
  markRead: false,
  unsubscribe: false,
};
const answer = (context: Context) => {
  // The stand-in takes a queue of answers, one a call: each puts the next in its place.
  faux.appendResponses([answer]);
  const tools = new Set(context.messages.flatMap((m) => m.toolsAdded ?? []).map((tool) => tool.name));
  if (tools.has(PROPOSAL_TOOL)) {
    const words = typed(context).toLowerCase();
    const note = words.includes('receipt') ? 'Your Receipts and transactions label covers receipts already.' : '';
    return fauxAssistantMessage(
      [fauxToolCall(PROPOSAL_TOOL, { labels: [...(words.includes('pitch') ? [PITCHES] : []), ...(words.includes('build') ? [BUILDS] : [])], note })],
      { stopReason: 'toolUse' },
    );
  }
  const found = () => [...JSON.stringify(context.messages.at(-1)?.content).matchAll(/<([^>\s]+@[^>\s]+)>|- ([^\s,<]+@[^\s,]+)/g)].map((m) => m[1] ?? m[2]);
  if (tools.has(ASK_TOOL) && context.messages.at(-1)?.role === 'toolResult') {
    const sender = found()[0];
    const words = about(context);
    const narrow = { reading: '', from: sender ? [sender] : [], domains: [], label: '', view: '', unread: false, since: '', words };
    const note = sender || words.length > 0 ? '' : 'Sift cannot tell which mail you have answered.';
    return fauxAssistantMessage([fauxToolCall(ASK_TOOL, { ...narrow, note })], { stopReason: 'toolUse' });
  }
  if (tools.has(FILL_TOOL) && context.messages.at(-1)?.role === 'toolResult') {
    const [first, second] = found();
    const note = second ? `Add another rule for ${second}.` : '';
    return fauxAssistantMessage(
      [fauxToolCall(FILL_TOOL, { ...blank, conditions: [{ by: 'from', value: first ?? 'nobody@example.com' }], action: 'archive', note })],
      { stopReason: 'toolUse' },
    );
  }
  if (tools.has(FIND_TOOL))
    return fauxAssistantMessage([fauxToolCall(FIND_TOOL, { query: tools.has(ASK_TOOL) ? typed(context).split(' about ')[0]! : typed(context) })], {
      stopReason: 'toolUse',
    });
  return fauxAssistantMessage('The stand-in model answers only for labels, rules and Ask.', { stopReason: 'error', errorMessage: 'stand-in' });
};
faux.setResponses([answer, answer]);

const standIns: StandIns = {
  gmail: (address) => ({ api: nothingNew(address), mailbox: mailboxOf(address) }),
  model: { spec: 'faux/stand-in', models, model: faux.getModel(), reasoning: 'low' },
  inbox: {
    inboxEstimate: async (_db, _mailboxes, reach) =>
      reach === 'inbox' ? { messages: 2412, model: 1830, cost: 3.1 } : { messages: 300, model: 228, cost: 0.39 },
    mailReach: async () => ({
      year: { messages: 8240, bytes: 247_200_000, minutes: 103 },
      three_years: { messages: 21_500, bytes: 645_000_000, minutes: 269 },
      all: { messages: 46_800, bytes: 1_404_000_000, minutes: 585 },
    }),
    ruleInbox: async () => ({
      examples: Array.from({ length: 5 }, (_, i) => ({
        accountId: 'me@example.org',
        messageId: `g${i + 1}`,
        subject: seal(`Found in Gmail ${i + 1}`),
        receivedAt: Date.now() - (i + 1) * 3_600_000,
      })),
      messages: 1240,
      reading: 0,
      exact: false,
      most: null,
      costEach: null,
    }),
  },
};
(globalThis as Record<symbol, unknown>)[Symbol.for('sift.stand-ins')] = standIns;
