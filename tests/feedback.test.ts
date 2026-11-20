import type { Sql } from '../src/store/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { keepWaitingText, readingOnce } from '../src/work/bodies.ts';
import { READ_KEEP_DAYS, purgeRead } from '../src/store/kept.ts';
import { captureExamples } from '../src/work/examples.ts';
import { triageAccount } from '../src/work/triage.ts';
import { listSuggestions, suggestionDetail } from '../src/dashboard/queries/suggestions.ts';
import { messageDetail } from '../src/dashboard/queries/messages.ts';
import { summarize } from '../src/dashboard/queries/summary.ts';
import { people } from '../src/store/people.ts';
import { accuracy, applyFeedback, pendingSuggestions } from '../src/learn/feedback.ts';
import { listAccounts, recordSync } from '../src/store/accounts.ts';
import { recordDecision } from '../src/store/decisions.ts';
import { senderFacts } from '../src/store/senders.ts';
import { dismissProposal, listProposals, madeFromProposal } from '../src/store/proposals.ts';
import { MAX_ATTEMPTS, startRun } from '../src/store/runs.ts';
import { addRule, listRules, setRule } from '../src/store/rules.ts';
import { redecideWaiting } from '../src/learn/redecide.ts';
import type { Decision, Disposition } from '../src/triage/types.ts';
import { ACCOUNT, DAY, everything, facts, FakeMailbox, quietSources, testModel } from './helpers.ts';
import { firstAccount, raw, startDashboard, onePerson, withReason } from './fixtures.ts';
import type { Store } from '../src/store/store.ts';

let db: Sql;
let store: Store;
let serial = 0;

/** Record a message from `address` and what sift would do with it, as a suggestion. */
async function suggest(address: string, disposition: Disposition, extra: Partial<Decision> = {}): Promise<number> {
  const id = `m${++serial}`;
  await recordSync(db, ACCOUNT, [facts({ messageId: id, from: { address, domain: address.split('@')[1] ?? '' }, subject: `Subject ${id}` })], '2');
  return await recordDecision(db, ACCOUNT, id, { disposition, subscription: 'preserve', stage: 'model', reason: 'looks like it', ...extra }, { now: serial });
}

/** Answer each of a sender's waiting messages in turn, as pressing every row would. */
async function answerEach(sender: string, label: string, now = Date.now()): Promise<void> {
  for (const { messageId } of await pendingSuggestions(db, { accountId: ACCOUNT, sender }))
    await applyFeedback(db, { accountId: ACCOUNT, sender, label, messageId }, now);
}

beforeEach(async () => {
  ({ store, db } = await onePerson(ACCOUNT));
  serial = 0;
});

describe('leaving mail in the inbox', () => {
  it('is what the owner said of that sender afterwards, and moves nothing out', async () => {
    await suggest('bills@example.com', 'archive', { labelId: 'newsletter' });
    await suggest('bills@example.com', 'archive', { labelId: 'newsletter' });
    // As the dashboard answers: carried out, so the answer is a decision of its own.
    for (const messageId of ['m1', 'm2'])
      await applyFeedback(db, { accountId: ACCOUNT, sender: 'bills@example.com', label: 'everything_else', messageId, carryOut: true });
    expect((await senderFacts(db, [ACCOUNT], 'bills@example.com')).answered).toEqual([{ id: 'everything_else', messages: 2 }]);
    await expect(
      applyFeedback(db, { accountId: ACCOUNT, sender: 'bills@example.com', label: 'everything_else', disposition: 'archive', messageId: 'm1' }),
    ).rejects.toThrow('stays there');
  });
});

/** The rule sift holds for one sender, without its bookkeeping. */
const ruleFor = async (address: string) =>
  (await listRules(db))
    .filter((r) => r.match.from?.[0] === address)
    .map(({ labelId, whenLabel, disposition, source }) => ({
      ...(labelId ? { labelId } : {}),
      ...(whenLabel ? { whenLabel } : {}),
      ...(disposition ? { disposition } : {}),
      source,
    }));

const NEWS = { labelId: 'newsletter', gmailLabel: 'sift/newsletters' } as const;

describe('suggestions', () => {
  it('are the current decision for each message recorded as a suggestion, newest first', async () => {
    await suggest('news@example.com', 'archive', NEWS);
    const second = await suggest('news@example.com', 'archive', NEWS);
    await recordDecision(
      db,
      ACCOUNT,
      'm2',
      { disposition: 'keep', subscription: 'preserve', stage: 'model', reason: 'changed its mind', labelId: 'personal' },
      { now: 9 },
    );
    await recordSync(db, ACCOUNT, [facts({ messageId: 'acted' })], '3');
    await recordDecision(db, ACCOUNT, 'acted', { disposition: 'archive', subscription: 'preserve', stage: 'model', reason: 'r' }, { carryOut: true });

    const pending = await pendingSuggestions(db);
    expect(pending.map((s) => [s.messageId, s.disposition, s.labelId])).toEqual([
      ['m2', 'keep', 'personal'],
      ['m1', 'archive', 'newsletter'],
    ]);
    expect(pending.map((s) => s.decisionId)).not.toContain(second);
  });

  it("leave out what a rule of the user's decided, but not what a rule sift learned did", async () => {
    const mine = await addRule(db, { match: { from: ['rule@example.com'] }, labelId: 'newsletter' }, 'user');
    const corrected = await addRule(db, { match: { from: ['taught@example.com'] }, labelId: 'newsletter' }, 'correction');
    const learned = await addRule(db, { match: { from: ['learned@example.com'] }, labelId: 'newsletter' }, 'learned');
    await suggest('rule@example.com', 'archive', { ...NEWS, stage: 'rules', ruleId: mine });
    await suggest('taught@example.com', 'archive', { ...NEWS, stage: 'rules', ruleId: corrected });
    await suggest('learned@example.com', 'archive', { ...NEWS, stage: 'rules', ruleId: learned });
    await suggest('gone@example.com', 'archive', { ...NEWS, stage: 'rules', ruleId: 'r-removed' });
    expect((await pendingSuggestions(db)).map((s) => s.fromAddress)).toEqual(['learned@example.com']);
  });

  it('are listed one per message, newest first, with the label named, without kept mail unless asked', async () => {
    await suggest('a@example.com', 'archive', NEWS);
    await suggest('b@example.com', 'archive', NEWS);
    await suggest('b@example.com', 'archive', NEWS);
    await suggest('b@example.com', 'archive', { labelId: 'marketing' });
    await suggest('b@example.com', 'review');
    await suggest('c@example.com', 'keep', { labelId: 'personal' });

    const { items, waiting, labels } = await listSuggestions(db, await everything(db));
    expect(waiting).toBe(5);
    expect(items.map((i) => [i.sender, i.subject, i.labelName, i.disposition])).toEqual([
      ['b@example.com', 'Subject m5', null, 'review'],
      ['b@example.com', 'Subject m4', 'Marketing', 'archive'],
      ['b@example.com', 'Subject m3', 'Newsletters', 'archive'],
      ['b@example.com', 'Subject m2', 'Newsletters', 'archive'],
      ['a@example.com', 'Subject m1', 'Newsletters', 'archive'],
    ]);
    // What else it might be: the sender's mail's other labels, most first.
    expect(items[1]?.alternatives).toEqual([{ id: 'newsletter', name: 'Newsletters', share: 2 / 3 }]);
    expect(items[2]?.alternatives).toEqual([{ id: 'marketing', name: 'Marketing', share: 1 / 3 }]);
    expect(labels).toContainEqual({ id: 'newsletter', name: 'Newsletters', disposition: 'archive' });
    expect((await listSuggestions(db, await everything(db), { includeKept: true })).waiting).toBe(6);
  });

  it('are listed newest received first, however late Sift decided them', async () => {
    const at = { older: 2 * DAY, newer: 3 * DAY };
    for (const [id, receivedAt] of [
      ['newer', at.newer],
      ['older', at.older],
    ] as const)
      await recordSync(db, ACCOUNT, [facts({ messageId: id, from: { address: `${id}@example.com`, domain: 'example.com' }, receivedAt })], '2');
    await recordDecision(
      db,
      ACCOUNT,
      'newer',
      { disposition: 'archive', subscription: 'preserve', stage: 'model', reason: 'looks like it', ...NEWS },
      { now: 1 },
    );
    await recordDecision(
      db,
      ACCOUNT,
      'older',
      { disposition: 'archive', subscription: 'preserve', stage: 'model', reason: 'looks like it', ...NEWS },
      { now: 2 },
    );
    expect((await listSuggestions(db, await everything(db))).items.map((i) => i.messageId)).toEqual(['newer', 'older']);
  });

  it('carry the start of the text sift holds for each, on one line', async () => {
    await suggest('a@example.com', 'archive', NEWS);
    await suggest('b@example.com', 'archive', NEWS);
    await raw(db).run(
      'INSERT INTO read_bodies (account_id, message_id, body_text, fetched_at) VALUES (?, ?, ?, 0)',
      ACCOUNT,
      'm1',
      'Five stories\n\n  about   widgets.',
    );
    const { items } = await listSuggestions(db, await everything(db));
    expect(items.map((i) => [i.messageId, i.preview])).toEqual([
      ['m2', null],
      ['m1', 'Five stories about widgets.'],
    ]);
  });
});

describe('teaching', () => {
  it('saying what a message is corrects sift and teaches by example, with no rule tying the sender to a label', async () => {
    const decisionId = await suggest('ada@example.org', 'archive', { labelId: 'marketing' });
    const result = await applyFeedback(db, { accountId: ACCOUNT, sender: 'ada@example.org', label: 'personal', decisionId, messageId: 'm1' }, 50);

    expect(result).toEqual({ corrected: null, carrying: 0, asked: [] });
    expect(await listRules(db)).toEqual([]);
    expect(await raw(db).all('SELECT verdict, disposition, label_id FROM feedback')).toEqual([{ verdict: 'wrong', disposition: 'keep', label_id: 'personal' }]);
    // The message itself is what the model is shown next time.
    expect(await raw(db).get('SELECT label_id FROM examples')).toEqual({ label_id: 'personal' });
    expect(await accuracy(db)).toMatchObject({ reviewed: 1, right: 0 });
  });

  it('answering mail sift could not place does not count as a mistake', async () => {
    await suggest('cold@example.net', 'review');
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'cold@example.net', label: 'newsletter', messageId: 'm1' });
    expect(await raw(db).get('SELECT verdict, disposition, label_id FROM feedback')).toEqual({
      verdict: 'answered',
      disposition: 'archive',
      label_id: 'newsletter',
    });
    expect(await accuracy(db)).toMatchObject({ reviewed: 0, right: 0 });
    expect(await listRules(db)).toEqual([]);
  });

  it('keeps a relabelled message as an example of the label it was given', async () => {
    const decisionId = await suggest('scam@example.net', 'archive', { labelId: 'marketing' });
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'scam@example.net', label: 'phishing', decisionId, messageId: 'm1' });
    expect(await raw(db).get('SELECT label_id FROM examples')).toEqual({ label_id: 'phishing' });
  });

  it('an answer about one message is recorded but makes no rule', async () => {
    const decisionId = await suggest('news@example.com', 'archive', NEWS);
    await suggest('news@example.com', 'archive', NEWS);
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'news@example.com', label: 'personal', decisionId, messageId: 'm1' });
    expect(await listRules(db)).toEqual([]);
    expect(await pendingSuggestions(db)).toHaveLength(1);
  });

  it('rejects a label that does not exist and an answer about nothing that is waiting', async () => {
    await suggest('news@example.com', 'archive', NEWS);
    await expect(applyFeedback(db, { accountId: ACCOUNT, sender: 'news@example.com', label: 'nonsense', messageId: 'm1' })).rejects.toThrow('no label');
    await expect(applyFeedback(db, { accountId: ACCOUNT, sender: 'nobody@example.com', label: 'newsletter', messageId: 'missing' })).rejects.toThrow(
      'no longer waiting',
    );
    expect(await raw(db).get('SELECT count(*) AS n FROM feedback')).toEqual({ n: 0 });
    expect(await listRules(db)).toEqual([]);
  });
});

describe('an answer pressed in the dashboard', () => {
  it('is carried out on its message even while sift is off, and makes no rule', async () => {
    const decisionId = await suggest('news@example.com', 'archive', NEWS);
    // sift's own decision, left over from when it was on: while off it must still be left alone.
    await recordSync(db, ACCOUNT, [facts({ messageId: 'left', from: { address: 'other@example.com', domain: 'example.com' } })], '3');
    await recordDecision(
      db,
      ACCOUNT,
      'left',
      { disposition: 'archive', subscription: 'preserve', stage: 'model', reason: 'looks like it' },
      { carryOut: true },
    );

    const result = await applyFeedback(
      db,
      { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', decisionId, messageId: 'm1', carryOut: true },
      50,
    );
    expect(result).toMatchObject({ carrying: 1 });
    expect(await ruleFor('news@example.com')).toEqual([]);

    const mailbox = new FakeMailbox();
    mailbox.labels.set('m1', ['INBOX']);
    mailbox.labels.set('left', ['INBOX']);
    await triageAccount({ db, mailbox: null, answers: mailbox }, await firstAccount(db));
    expect(mailbox.labels.get('m1')).not.toContain('INBOX');
    expect(mailbox.labels.get('left')).toEqual(['INBOX']);
    expect(await raw(db).get(`SELECT by_user, carry_out, outcome FROM decisions WHERE message_id = 'm1' ORDER BY id DESC LIMIT 1`)).toEqual({
      by_user: true,
      carry_out: true,
      outcome: 'done',
    });
  });

  it('answers mail the model could never judge before a pass leaves it to the user, as mail sift had no suggestion for', async () => {
    await recordSync(db, ACCOUNT, [facts({ messageId: 'stuck', from: { address: 'news@example.com', domain: 'example.com' } })], '3');
    for (let i = 0; i < MAX_ATTEMPTS; i++) await startRun(db, { accountId: ACCOUNT, messageId: 'stuck', model: 'test/model', now: 0 });
    await expect(
      applyFeedback(db, { accountId: ACCOUNT, sender: 'other@example.com', label: 'newsletter', messageId: 'stuck', carryOut: true }),
    ).rejects.toThrow('not from that sender');

    const result = await applyFeedback(db, { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', messageId: 'stuck', carryOut: true }, 50);
    expect(result).toMatchObject({ carrying: 1, corrected: null });
    expect(await raw(db).all(`SELECT stage, disposition, label_id, by_user, carry_out, run_id FROM decisions WHERE message_id = 'stuck'`)).toEqual([
      { stage: 'rules', disposition: 'archive', label_id: 'newsletter', by_user: true, carry_out: true, run_id: null },
    ]);
    expect(await raw(db).get(`SELECT verdict, disposition, label_id, via FROM feedback`)).toEqual({
      verdict: 'answered',
      disposition: 'archive',
      label_id: 'newsletter',
      via: 'dashboard',
    });
    expect(await raw(db).get(`SELECT label_id FROM examples WHERE message_id = 'stuck'`)).toEqual({
      label_id: 'newsletter',
    });
    expect(await accuracy(db)).toMatchObject({ reviewed: 0 });

    const mailbox = new FakeMailbox();
    mailbox.labels.set('stuck', ['INBOX']);
    await triageAccount({ db, mailbox: null, answers: mailbox }, await firstAccount(db));
    expect(mailbox.labels.get('stuck')).not.toContain('INBOX');
  });

  it('answers that go with the label propose no rule: one would do what already happens', async () => {
    for (let i = 0; i < 4; i++) {
      const decisionId = await suggest('news@example.com', 'archive', NEWS);
      await applyFeedback(
        db,
        { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', decisionId, messageId: `m${serial}`, carryOut: true },
        50 + i,
      );
    }
    expect(await listProposals(db, ACCOUNT)).toEqual([]);
  });

  it('can keep a message under the label that would move it: the label counts as right, and nothing is unsubscribed', async () => {
    const decisionId = await suggest('news@example.com', 'archive', { ...NEWS, subscription: 'unsubscribe' });
    await applyFeedback(
      db,
      { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', disposition: 'keep', decisionId, messageId: 'm1', carryOut: true },
      50,
    );
    expect(
      withReason(
        await raw(db).get(`SELECT disposition, subscription, label_id, by_user, reason FROM decisions WHERE message_id = 'm1' ORDER BY id DESC LIMIT 1`),
      ),
    ).toEqual({ disposition: 'keep', subscription: 'preserve', label_id: 'newsletter', by_user: true, reason: 'you said this is Newsletters, and to keep it' });
    expect(await raw(db).get(`SELECT verdict, disposition, label_id FROM feedback`)).toEqual({ verdict: 'right', disposition: 'keep', label_id: 'newsletter' });

    const mailbox = new FakeMailbox();
    mailbox.labels.set('m1', ['INBOX']);
    await triageAccount({ db, mailbox: null, answers: mailbox }, await firstAccount(db));
    expect(mailbox.labels.get('m1')).toContain('INBOX');
  });

  it('keeps the message a "when it is this label, keep" rule was made from, as the panel does after adding it', async () => {
    const decisionId = await suggest('news@example.com', 'archive', { ...NEWS, subscription: 'unsubscribe' });
    await setRule(db, { from: ['news@example.com'] }, { whenLabel: 'newsletter', disposition: 'keep' }, 'user', 40);
    await redecideWaiting(db, ACCOUNT, 41);
    await applyFeedback(
      db,
      { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', disposition: 'keep', decisionId, messageId: 'm1', carryOut: true },
      50,
    );
    expect(await raw(db).get(`SELECT disposition, subscription, label_id FROM decisions WHERE message_id = 'm1' ORDER BY id DESC LIMIT 1`)).toEqual({
      disposition: 'keep',
      subscription: 'preserve',
      label_id: 'newsletter',
    });
    expect(await raw(db).get(`SELECT verdict, disposition, label_id FROM feedback`)).toEqual({ verdict: 'right', disposition: 'keep', label_id: 'newsletter' });
    expect(await raw(db).get(`SELECT label_id FROM examples WHERE message_id = 'm1'`)).toEqual({ label_id: 'newsletter' });
  });

  /** The user keeping (or archiving) a sender's message of `label` that the label would do otherwise, as moving it in Gmail does. */
  const against = async (sender: string, label: string, disposition: 'keep' | 'archive', at: number) => {
    const decisionId = await suggest(sender, 'archive', { labelId: label });
    await applyFeedback(db, { accountId: ACCOUNT, sender, label, disposition, decisionId, messageId: `m${serial}`, via: 'gmail' }, at);
  };
  /** Each proposal standing: who it is for, its label, and how many answers it rests on. */
  const proposed = async () => (await listProposals(db, ACCOUNT)).map((p) => [p.match.from?.[0], p.labelId, p.agreed]);

  it("two answers giving a label's mail another action propose a rule that does that, made only in the rule dialog", async () => {
    await against('news@example.com', 'newsletter', 'keep', 50);
    expect(await proposed()).toEqual([]);
    await against('news@example.com', 'newsletter', 'keep', 51);
    expect(await ruleFor('news@example.com')).toEqual([]);
    const [proposal] = await listProposals(db, ACCOUNT);
    expect(proposal).toMatchObject({ match: { from: ['news@example.com'] }, labelId: 'newsletter', disposition: 'keep', agreed: 2 });
    // A third refreshes the count; it opens no second proposal.
    await against('news@example.com', 'newsletter', 'keep', 52);
    expect(await listProposals(db, ACCOUNT)).toMatchObject([{ id: proposal!.id, agreed: 3 }]);

    expect(await madeFromProposal(db, proposal!.id)).toBe(true);
    expect(await madeFromProposal(db, proposal!.id)).toBe(false);
    expect(await listProposals(db, ACCOUNT)).toEqual([]);
  });

  it('counts a run per label, broken by an answer that went with the label', async () => {
    await against('news@example.com', 'newsletter', 'keep', 50);
    await against('news@example.com', 'marketing', 'keep', 51);
    expect(await proposed()).toEqual([]);
    const decisionId = await suggest('news@example.com', 'archive', NEWS);
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', decisionId, messageId: `m${serial}` }, 52);
    await against('news@example.com', 'newsletter', 'keep', 53);
    expect(await proposed()).toEqual([]);
    await against('news@example.com', 'newsletter', 'keep', 54);
    expect(await proposed()).toEqual([['news@example.com', 'newsletter', 2]]);
  });

  it('does not propose again what the user dismissed, nor where the sender has a rule for all their mail or that label', async () => {
    await against('news@example.com', 'newsletter', 'keep', 50);
    await against('news@example.com', 'newsletter', 'keep', 51);
    expect(await dismissProposal(db, (await listProposals(db, ACCOUNT))[0]!.id)).toBe(true);
    await against('news@example.com', 'newsletter', 'keep', 52);
    expect(await proposed()).toEqual([]);

    await addRule(db, { match: { from: ['shop@example.com'] }, labelId: 'marketing' }, 'user');
    await addRule(db, { match: { from: ['alerts@example.com'] }, whenLabel: 'notification', disposition: 'spam' }, 'user');
    for (const at of [60, 61]) {
      await against('shop@example.com', 'marketing', 'keep', at);
      await against('alerts@example.com', 'notification', 'keep', at);
    }
    expect(await proposed()).toEqual([]);
    // A rule for another of the sender's labels leaves this one open.
    await against('alerts@example.com', 'marketing', 'keep', 62);
    expect(await proposed()).toEqual([]);
    await against('alerts@example.com', 'marketing', 'keep', 63);
    expect(await proposed()).toEqual([['alerts@example.com', 'marketing', 2]]);
  });
});

describe('accuracy', () => {
  it('is reported per tier and per label, with what was mixed up, for answers in the window', async () => {
    await suggest('news@example.com', 'archive', NEWS);
    await suggest('news@example.com', 'archive', NEWS);
    await suggest('sales@example.com', 'archive', NEWS);
    await suggest('shop@example.com', 'archive', { labelId: 'marketing', stage: 'rules' });
    await suggest('ada@example.org', 'review');
    const answer = async (sender: string, label: string, at: number, messageId: string) =>
      await applyFeedback(db, { accountId: ACCOUNT, sender, label, messageId }, at);
    await answer('news@example.com', 'newsletter', 100, 'm1');
    await answer('news@example.com', 'newsletter', 100, 'm2');
    await answer('sales@example.com', 'marketing', 200, 'm3');
    // Decided by a rule of the user's, so it is not waiting; it is answered by naming the message.
    await answer('shop@example.com', 'marketing', 200, 'm4');
    await answer('ada@example.org', 'personal', 200, 'm5');

    expect(await accuracy(db)).toEqual({
      reviewed: 4,
      right: 3,
      byStage: [
        { stage: 'model', reviewed: 3, right: 2 },
        { stage: 'rules', reviewed: 1, right: 1 },
      ],
      byLabel: [
        { labelId: 'newsletter', labelName: 'Newsletters', reviewed: 3, right: 2 },
        { labelId: 'marketing', labelName: 'Marketing', reviewed: 1, right: 1 },
      ],
      confusion: [{ suggested: 'newsletter', correct: 'marketing', count: 1 }],
    });
    expect(await accuracy(db, 150)).toMatchObject({
      reviewed: 2,
      right: 1,
      byLabel: [{ labelId: 'marketing' }, { labelId: 'newsletter', reviewed: 1, right: 0 }],
    });

    const summary = await summarize(db, await everything(db), 7, 200);
    expect(summary.accuracy).toMatchObject({ reviewed: 4, right: 3, confusion: [{ suggested: 'newsletter', correct: 'marketing', count: 1 }] });
    expect(summary.accuracy.byStage).toEqual([
      { stage: 'rules', reviewed: 1, right: 1 },
      { stage: 'classifier', reviewed: 0, right: 0 },
      { stage: 'model', reviewed: 3, right: 2 },
      { stage: 'fallback', reviewed: 0, right: 0 },
    ]);
    expect((await summarize(db, await everything(db), 7, 200 + 30 * DAY)).accuracy).toMatchObject({ reviewed: 0, right: 0, byLabel: [] });
  });
});

describe('correcting a decision that is not waiting', () => {
  /** A message sift already acted on. */
  async function acted(address: string, labelId: string) {
    const id = `a${++serial}`;
    await recordSync(db, ACCOUNT, [facts({ messageId: id, from: { address, domain: address.split('@')[1] ?? '' }, subject: `Subject ${id}` })], '2');
    await recordDecision(
      db,
      ACCOUNT,
      id,
      { disposition: 'archive', subscription: 'preserve', stage: 'model', reason: 'r', labelId },
      { carryOut: true, now: serial },
    );
    return id;
  }
  const decisionsFor = async (id: string) =>
    (await raw(db).all('SELECT stage, disposition, label_id, carry_out, outcome, reason FROM decisions WHERE message_id = ? ORDER BY id', id)).map(withReason);

  it('records what the user said as a new decision, makes no rule, and names the message to put right', async () => {
    const id = await acted('bids@example.com', 'marketing');
    expect(await pendingSuggestions(db)).toEqual([]);
    const result = await applyFeedback(db, { accountId: ACCOUNT, sender: 'bids@example.com', label: 'personal', messageId: id, carryOut: true }, 50);
    expect(result).toEqual({ carrying: 1, asked: [], corrected: id });
    expect(await decisionsFor(id)).toEqual([
      { stage: 'model', disposition: 'archive', label_id: 'marketing', carry_out: true, outcome: null, reason: 'r' },
      // Waiting to be carried out, which the next pass does once the earlier change has been taken back.
      { stage: 'rules', disposition: 'keep', label_id: 'personal', carry_out: true, outcome: null, reason: 'you said this is Personal' },
    ]);
    expect(await listRules(db)).toEqual([]);
    expect(await raw(db).get('SELECT verdict, disposition, label_id FROM feedback')).toEqual({ verdict: 'wrong', disposition: 'keep', label_id: 'personal' });
    expect(await raw(db).get('SELECT label_id FROM examples')).toEqual({ label_id: 'personal' });
    expect(await accuracy(db)).toMatchObject({ reviewed: 1, right: 0 });
  });

  it('can be answered again, and for this message only', async () => {
    const id = await acted('bids@example.com', 'marketing');
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'bids@example.com', label: 'personal', messageId: id });
    expect(await applyFeedback(db, { accountId: ACCOUNT, sender: 'bids@example.com', label: 'newsletter', messageId: id })).toMatchObject({ corrected: id });
    expect((await decisionsFor(id)).map((d) => (d as { label_id: string }).label_id)).toEqual(['marketing', 'personal', 'newsletter']);
    // While sift is off, the new decision is a record, not something to carry out.
    expect((await decisionsFor(id)).at(-1)).toMatchObject({ carry_out: false, outcome: null });
    expect(await pendingSuggestions(db)).toEqual([]);
  });

  it('agreeing with a decision leaves the message alone', async () => {
    const id = await acted('news@example.com', 'newsletter');
    const result = await applyFeedback(db, { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', messageId: id, carryOut: true });
    expect(result).toEqual({ carrying: 0, asked: [], corrected: null });
    expect(await decisionsFor(id)).toHaveLength(1);
    expect(await raw(db).get('SELECT verdict FROM feedback')).toEqual({ verdict: 'right' });
  });

  it("corrects only that message, leaving the sender's waiting mail, and refuses a message from someone else", async () => {
    const id = await acted('bids@example.com', 'marketing');
    await suggest('bids@example.com', 'archive', { labelId: 'marketing' });
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'bids@example.com', label: 'personal', messageId: id });
    expect(await raw(db).get('SELECT count(*) AS n FROM feedback')).toEqual({ n: 1 });
    expect(await pendingSuggestions(db)).toHaveLength(1);
    await expect(applyFeedback(db, { accountId: ACCOUNT, sender: 'other@example.com', label: 'personal', messageId: id })).rejects.toThrow(
      'not from that sender',
    );
  });
});

describe('an answer given without its decision', () => {
  it("settles only the message it names, never the sender's other waiting mail, and makes no rule", async () => {
    await suggest('news@example.com', 'archive', NEWS);
    await suggest('news@example.com', 'archive', NEWS);
    expect(await applyFeedback(db, { accountId: ACCOUNT, sender: 'news@example.com', label: 'personal', messageId: 'm1' })).toEqual({
      carrying: 0,
      asked: [],
      corrected: null,
    });
    expect(await listRules(db)).toEqual([]);
    expect(await raw(db).all('SELECT verdict, disposition, label_id FROM feedback')).toEqual([{ verdict: 'wrong', disposition: 'keep', label_id: 'personal' }]);
    expect((await pendingSuggestions(db)).map((s) => s.messageId)).toEqual(['m2']);
  });
});

describe('reading a suggestion', () => {
  it('reads the text of waiting mail it would move or could not place once, and keeps it a month whatever becomes of it', async () => {
    await suggest('news@example.com', 'archive', NEWS); // m1
    await suggest('ada@example.org', 'review'); // m2
    await suggest('kept@example.com', 'keep', { labelId: 'personal' }); // m3
    await suggest('gone@example.com', 'archive', NEWS); // m4
    const fetched: string[] = [];
    const content = (id: string) => ({ text: `Text of ${id}`, html: id === 'm1' ? `<p>Text of ${id}</p>` : null, facts: { hasAttachments: false } });
    const api = { getContent: async (id: string) => (fetched.push(id), id === 'm4' ? null : content(id)) };
    const reader = () => readingOnce(db, ACCOUNT, api, () => 1000);
    const stored = async () => await raw(db).all('SELECT message_id, body_text, body_html FROM read_bodies ORDER BY message_id');

    expect(await keepWaitingText(db, reader(), ACCOUNT, () => 1000)).toBe(3);
    expect(await stored()).toEqual([
      { message_id: 'm1', body_text: 'sift-plain:Text of m1', body_html: 'sift-plain:<p>Text of m1</p>' },
      { message_id: 'm2', body_text: 'sift-plain:Text of m2', body_html: null },
      { message_id: 'm4', body_text: 'sift-plain:', body_html: null },
    ]);
    expect(await keepWaitingText(db, reader(), ACCOUNT, () => 1000)).toBe(0);
    expect(fetched.toSorted()).toEqual(['m1', 'm2', 'm4']);
    expect(await messageDetail(db, await everything(db), 'm1')).toMatchObject({ body: 'Text of m1', hasHtml: true });
    expect(await messageDetail(db, await everything(db), 'm2')).toMatchObject({ body: 'Text of m2', hasHtml: false });
    expect(await messageDetail(db, await everything(db), 'm3')).toMatchObject({ body: null, hasHtml: false });

    // Answered: the example takes a copy, and the text stays for its month.
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', messageId: 'm1' });
    expect(await raw(db).get(`SELECT status, body_text FROM examples WHERE message_id = 'm1'`)).toEqual({
      status: 'captured',
      body_text: 'sift-plain:Text of m1',
    });
    expect((await stored()).map((r) => (r as { message_id: string }).message_id)).toEqual(['m1', 'm2', 'm4']);

    // A month after reading, it goes, and is not read again.
    expect(await purgeRead(db, 1000 - 1)).toBe(0);
    expect(await purgeRead(db, 1000 + 1)).toBe(3);
    expect(await keepWaitingText(db, reader(), ACCOUNT, () => 1000 + READ_KEEP_DAYS * DAY)).toBe(0);
    expect(fetched).toHaveLength(3);
  });

  it("shows one sender's waiting mail, in every mailbox, newest first", async () => {
    await suggest('news@example.com', 'archive', NEWS);
    await suggest('news@example.com', 'archive', NEWS);
    await suggest('other@example.com', 'archive', NEWS);

    const detail = await suggestionDetail(db, await everything(db), 'news@example.com');
    expect(detail.messages.map((m) => [m.messageId, m.subject, m.labelId])).toEqual([
      ['m2', 'Subject m2', 'newsletter'],
      ['m1', 'Subject m1', 'newsletter'],
    ]);
    expect(await suggestionDetail(db, await everything(db), 'stranger@example.net')).toEqual({ messages: [] });
  });
});

describe('examples', () => {
  it('queues each marked message with the answer', async () => {
    await suggest('news@example.com', 'archive', NEWS);
    await suggest('news@example.com', 'keep', { labelId: 'personal' });
    await answerEach('news@example.com', 'newsletter', 50);
    expect(await raw(db).all('SELECT message_id, label_id, status, body_text FROM examples ORDER BY message_id')).toEqual([
      { message_id: 'm1', label_id: 'newsletter', status: 'pending', body_text: null },
      { message_id: 'm2', label_id: 'newsletter', status: 'pending', body_text: null },
    ]);
  });

  it('keeps an answer without the text once Sift has let it go, rather than read Gmail again', async () => {
    await suggest('news@example.com', 'archive', NEWS); // m1
    const fetched: string[] = [];
    const api = { getContent: async (id: string) => (fetched.push(id), { text: `Text of ${id}`, html: null, facts: { hasAttachments: false } }) };
    await keepWaitingText(
      db,
      readingOnce(db, ACCOUNT, api, () => 1000),
      ACCOUNT,
      () => 1000,
    );
    await purgeRead(db, 1000 + READ_KEEP_DAYS * DAY);
    await answerEach('news@example.com', 'newsletter', 50);
    expect(await captureExamples(db, readingOnce(db, ACCOUNT, api), ACCOUNT)).toBe(0);
    expect(fetched).toEqual(['m1']);
    expect(await raw(db).get(`SELECT status, body_text FROM examples WHERE message_id = 'm1'`)).toEqual({ status: 'gone', body_text: null });
  });

  it('takes the text Sift read, and reads only what it never read', async () => {
    await suggest('news@example.com', 'archive', NEWS); // m1: kept
    await suggest('news@example.com', 'archive', NEWS); // m2: gone from Gmail when its text was fetched
    await keepWaitingText(
      db,
      readingOnce(db, ACCOUNT, {
        getContent: async (id) => (id === 'm2' ? null : { text: `Text of ${id}`, html: `<p>${id}</p>`, facts: { hasAttachments: false } }),
      }),
      ACCOUNT,
      () => 1000,
    );
    await suggest('news@example.com', 'archive', NEWS); // m3: not kept yet
    await answerEach('news@example.com', 'newsletter', 50);
    expect(await raw(db).all('SELECT message_id, status, body_text, body_html FROM examples ORDER BY message_id')).toEqual([
      { message_id: 'm1', status: 'captured', body_text: 'sift-plain:Text of m1', body_html: 'sift-plain:<p>m1</p>' },
      { message_id: 'm2', status: 'pending', body_text: null, body_html: null },
      { message_id: 'm3', status: 'pending', body_text: null, body_html: null },
    ]);

    const fetched: string[] = [];
    await captureExamples(
      db,
      { getContent: async (id) => (fetched.push(id), id === 'm2' ? null : { text: 'Hi', html: null, facts: { hasAttachments: false } }) },
      ACCOUNT,
    );
    // m2 was read once and had gone; only m3 was never read.
    expect(fetched).toEqual(['m3']);
    expect(await raw(db).get(`SELECT status FROM examples WHERE message_id = 'm2'`)).toEqual({ status: 'gone' });
  });

  it('stores the text on the next pass, and keeps the answer when the message is gone', async () => {
    await suggest('news@example.com', 'archive', NEWS);
    await suggest('news@example.com', 'archive', NEWS);
    await suggest('news@example.com', 'archive', NEWS);
    await answerEach('news@example.com', 'newsletter');

    let failing = true;
    const api = {
      getContent: async (id: string) => {
        if (id === 'm3' && failing) throw new Error('network');
        return id === 'm2' ? null : { text: 'Hello there.', html: '<p>Hello there.</p>', facts: { hasAttachments: false } };
      },
    };
    await expect(captureExamples(db, api, ACCOUNT)).rejects.toThrow('network');
    const stored = await raw(db).all('SELECT message_id, status, body_text, body_html FROM examples ORDER BY message_id');
    expect(stored).toEqual([
      { message_id: 'm1', status: 'captured', body_text: 'sift-plain:Hello there.', body_html: 'sift-plain:<p>Hello there.</p>' },
      { message_id: 'm2', status: 'gone', body_text: null, body_html: null },
      { message_id: 'm3', status: 'pending', body_text: null, body_html: null },
    ]);

    failing = false;
    expect(await captureExamples(db, api, ACCOUNT)).toBe(1);
    expect(await captureExamples(db, api, ACCOUNT)).toBe(0);
    expect(await raw(db).all('SELECT message_id, status FROM examples ORDER BY message_id')).toEqual([
      { message_id: 'm1', status: 'captured' },
      { message_id: 'm2', status: 'gone' },
      { message_id: 'm3', status: 'captured' },
    ]);
  });
});

describe('feedback endpoint', () => {
  async function start() {
    const { call, port } = await startDashboard(people(store), { allowedHosts: ['homebox'] });
    const post = async (body: unknown, headers?: Record<string, string>) => {
      const { status, body: reply } = await call('POST', '/api/feedback', body, headers);
      return { status, body: reply };
    };
    return { post, port };
  }

  const answer = { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', messageId: 'm1' };

  it('records an answer sent by the dashboard page', async () => {
    await suggest('news@example.com', 'archive', NEWS);
    const { post, port } = await start();
    expect(await post(answer)).toEqual({ status: 200, body: { notFixed: null } });
    expect(await raw(db).get('SELECT created_at FROM feedback')).toEqual({ created_at: 77 });
    expect(await raw(db).get('SELECT status FROM examples')).toEqual({ status: 'pending' });
    const suggestions = (await (await fetch(`http://127.0.0.1:${port}/api/suggestions`)).json()) as { waiting: number; accuracy: unknown };
    expect(suggestions).toMatchObject({ waiting: 0, accuracy: { reviewed: 1, right: 1 } });
    expect((suggestions as unknown as { labels: { id: string }[] }).labels.map((l) => l.id)).toContain('newsletter');
  });

  it("accepts the page when it is opened by one of the machine's own names", async () => {
    await suggest('news@example.com', 'archive', NEWS);
    const { post, port } = await start();
    expect((await post(answer, { host: `homebox:${port}`, origin: `http://homebox:${port}` })).status).toBe(200);
  });

  it('refuses a write that did not come from the dashboard page', async () => {
    await suggest('news@example.com', 'archive', NEWS);
    const { post } = await start();
    expect((await post(answer, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(answer, { origin: '' })).status).toBe(403);
    expect((await post(answer, { 'x-sift': '' })).status).toBe(403);
    expect((await post(answer, { 'content-type': 'text/plain' })).status).toBe(403);
    expect((await post(answer, { host: 'evil.example' })).status).toBe(403);
    expect(await raw(db).get('SELECT count(*) AS n FROM feedback')).toEqual({ n: 0 });
  });

  it('refuses malformed answers and ones about nothing waiting', async () => {
    await suggest('news@example.com', 'archive', NEWS);
    const { post, port } = await start();
    expect((await post('{not json')).status).toBe(400);
    expect((await post({ ...answer, label: undefined })).status).toBe(400);
    expect((await post({ ...answer, messageId: undefined })).status).toBe(400);
    expect((await post({ ...answer, disposition: 'delete' })).status).toBe(400);
    expect((await post({ ...answer, disposition: 'review' })).status).toBe(400);
    expect((await post({ ...answer, label: 'DROP TABLE' })).status).toBe(400);
    expect((await post({ ...answer, label: 'nonsense' })).status).toBe(409);
    // An answer says what one message is; a rule is made only in the rule dialog.
    expect((await post({ ...answer, scope: 'sender' })).status).toBe(400);
    expect((await post({ ...answer, contains: 'outbid' })).status).toBe(400);
    expect((await post({ ...answer, label: undefined, disposition: 'archive' })).status).toBe(400);
    expect((await post({ ...answer, filler: 'x'.repeat(20_000) })).status).toBe(400);
    expect((await post({ ...answer, sender: 'nobody@example.com' })).status).toBe(409);
    expect((await fetch(`http://127.0.0.1:${port}/api/summary`, { method: 'POST' })).status).toBe(405);
  });
});

describe("a rule of the person's", () => {
  it('decides mail in every mailbox of theirs, so none of it waits on them', async () => {
    const WORK = 'work@example.org';
    const { db: own } = await onePerson(ACCOUNT, WORK);
    await addRule(own, { match: { from: ['notifications@example.com'] }, labelId: 'newsletter' }, 'user');
    const from = { address: 'notifications@example.com', domain: 'example.com' };
    await recordSync(own, WORK, [facts({ accountId: WORK, messageId: 'w1', from })], '2');
    const model = testModel();
    await triageAccount(
      { db: own, mailbox: null, model, sources: quietSources() },
      (await listAccounts(own)).find((a) => a.id === WORK)!,
    );
    expect(await raw(own).get(`SELECT stage, label_id FROM decisions WHERE message_id = 'w1'`)).toEqual({ stage: 'rules', label_id: 'newsletter' });
    expect(await pendingSuggestions(own)).toEqual([]);
  });
});
