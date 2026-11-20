/**
 * Preloaded into the Next.js server `serve.ts` starts (`NODE_OPTIONS=--import`), before any of Sift loads. Everything is
 * the real app on the seeded home, Sift's own Gmail client among it, but for what Sift reaches outside this machine for:
 *
 * - Google: the fake the unit tests use (tests/google.ts), answering Google's own addresses in this process. It starts
 *   from what the seed left in the file `SIFT_STAND_INS` names, Gmail as the seed's last pass left it, and is written
 *   back there after each request that changes it, so a test reads what Gmail holds, and what was sent, from that file.
 *   With `SIFT_STAND_INS_LISTING` set, me@example.org's inbox also holds 1,200 sales from the Store from before Sift,
 *   `Found in Gmail 1` the newest, and Gmail never answers a search's second page, so applying a rule to them stays
 *   under way until it is stopped.
 * - The model that suggests labels, drafts rules and asks Inbox (`StandIns`, src/sift/sift.ts). Drafting looks up the second
 *   line of its prompt (the words the person typed), then fills in a rule archiving and marking read mail from the
 *   first sender found, with a note naming the second; nothing found fills in `nobody@example.com`. Asking looks up
 *   the words before any "about" the same way and narrows Inbox to the first sender found, searching for the words after it,
 *   or with neither says Sift cannot tell which mail you have answered. Suggesting gives Sales pitches when
 *   the words name pitches, Build results (Digest) when they name builds, and notes that Receipts and transactions
 *   covers receipts already when they name receipts; words naming none of these are an unusable answer. A pass is given no model.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import type { StandIns } from '../../../../src/sift/sift.ts';
import { PROPOSAL_TOOL } from '../../../../src/triage/proposal.ts';
import { FILL_TOOL, FIND_TOOL } from '../../../../src/triage/rule-draft.ts';
import { ASK_TOOL } from '../../../../src/triage/mail-ask.ts';
import { FakeGoogle, serveGoogle } from '../../../../tests/google.ts';

const file = process.env['SIFT_STAND_INS'];
if (!file) throw new Error('SIFT_STAND_INS names no file of what Google holds');
const google = FakeGoogle.restore(JSON.parse(readFileSync(file, 'utf8')) as ReturnType<FakeGoogle['save']>);
// Whole or not at all, for a test reading it meanwhile.
const save = () => {
  writeFileSync(`${file}.next`, JSON.stringify(google.save()));
  renameSync(`${file}.next`, file);
};
if (process.env['SIFT_STAND_INS_LISTING']) {
  const gmail = google.mailbox('me@example.org');
  const before = Date.now() - 2 * 86_400_000;
  for (let i = 1; i <= 1200; i++)
    gmail.deliver(
      {
        from: 'Store <sale@store.example.com>',
        to: 'me@example.org',
        subject: `Found in Gmail ${i}`,
        labelIds: ['INBOX', 'CATEGORY_PROMOTIONS'],
        at: before - i * 60_000,
        headers: { 'List-Id': '<store.example.com>' },
      },
      { quietly: true },
    );
  gmail.holdPages = true;
  save();
}
google.onChange = save;
serveGoogle(() => google).listen();

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

const standIns: StandIns = { model: { spec: 'faux/stand-in', models, model: faux.getModel(), reasoning: 'low' } };
(globalThis as Record<symbol, unknown>)[Symbol.for('sift.stand-ins')] = standIns;
