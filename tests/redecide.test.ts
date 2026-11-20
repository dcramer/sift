import type { Sql } from '../src/store/sql.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyFeedback, pendingSuggestions } from '../src/learn/feedback.ts';
import { redecideWaiting } from '../src/learn/redecide.ts';
import { recordSync } from '../src/store/accounts.ts';
import { connectGmail, fakeGoogle, firstAccount, openUserDb, raw, withReason } from './fixtures.ts';
import { undo } from '../src/actions/executor.ts';
import { triageAccount } from '../src/work/triage.ts';
import { startRun } from '../src/store/runs.ts';
import { recordDecision } from '../src/store/decisions.ts';
import { updateLabel } from '../src/store/labels.ts';
import { addRule, listRules, removeRule } from '../src/store/rules.ts';
import { rememberCorrespondent } from '../src/store/senders.ts';
import type * as Senders from '../src/store/senders.ts';
import type { Decision } from '../src/triage/types.ts';
import { ACCOUNT, facts } from './helpers.ts';

const fake = fakeGoogle();

/** Run once, on the handle redecide is using, the next time it reads whether the user writes to a sender. */
let meanwhile: ((db: Sql) => Promise<void>) | null = null;
vi.mock('../src/store/senders.ts', async (actual) => {
  const real = await actual<typeof Senders>();
  return {
    ...real,
    cachedCorrespondent: async (on: Sql, ...rest: [string, string, number?]) => {
      const run = meanwhile;
      meanwhile = null;
      await run?.(on);
      return await real.cachedCorrespondent(on, ...rest);
    },
  };
});

let db: Sql;
let serial: number;

const MARKETING = { disposition: 'archive', labelId: 'marketing', gmailLabel: 'sift/marketing', subscription: 'preserve' } as const;

/** A message from `address` with the decision sift suggested for it. Returns the message id. */
async function decided(address: string, decision: Partial<Decision> = {}, at = ++serial): Promise<string> {
  const id = `m${++serial}`;
  await recordSync(db, ACCOUNT, [facts({ messageId: id, from: { address, domain: address.split('@')[1] ?? '' }, subject: `Subject ${id}` })], '2');
  await recordDecision(
    db,
    ACCOUNT,
    id,
    { disposition: 'review', subscription: 'preserve', stage: 'model', confidence: 0.95, reason: 'Marketing: a sale', ...decision },
    { now: at },
  );
  return id;
}

const current = async (messageId: string) =>
  withReason(
    await raw(db).get(
      'SELECT stage, disposition, label_id, rule_id, subscription, reason, run_id, carry_out FROM decisions WHERE message_id = ? ORDER BY id DESC LIMIT 1',
      messageId,
    ),
  );
const count = async () => (await raw(db).get<{ n: number }>('SELECT count(*) AS n FROM decisions'))!.n;
const waiting = async () => (await pendingSuggestions(db)).map((s) => s.messageId).toSorted();

beforeEach(async () => {
  meanwhile = null;
  db = await openUserDb(ACCOUNT);
  serial = 0;
});

describe('when a rule changes', () => {
  it("a new rule of the user's settles the waiting mail it matches, and nothing else", async () => {
    const sale = await decided('sales@example.com', MARKETING);
    const other = await decided('ada@example.org', { disposition: 'keep', labelId: 'personal' });
    const ruleId = await addRule(db, { match: { from: ['sales@example.com'] }, labelId: 'newsletter' }, 'user');

    expect((await redecideWaiting(db, ACCOUNT, 50)).recorded).toBe(1);
    expect(await current(sale)).toMatchObject({
      stage: 'rules',
      disposition: 'archive',
      label_id: 'newsletter',
      rule_id: ruleId,
      run_id: null,
      carry_out: false,
    });
    expect(await waiting()).toEqual([other]);
    expect((await listRules(db))[0]?.hits).toBe(1);
    expect((await redecideWaiting(db, ACCOUNT, 60)).recorded).toBe(0);
  });

  it('removing that rule brings the suggestion back as the model left it', async () => {
    const sale = await decided('sales@example.com', { ...MARKETING, confidence: 0.9 });
    const arrivedUnderRule = await (async () => {
      const ruleId = await addRule(db, { match: { from: ['sales@example.com'] }, labelId: 'newsletter' }, 'user');
      const id = await decided('sales@example.com', { stage: 'rules', ruleId, disposition: 'archive', labelId: 'newsletter' });
      return { id, ruleId };
    })();
    await redecideWaiting(db, ACCOUNT);
    expect(await waiting()).toEqual([]);

    await removeRule(db, arrivedUnderRule.ruleId);
    expect((await redecideWaiting(db, ACCOUNT)).recorded).toBe(1);
    expect(await current(sale)).toMatchObject({
      stage: 'model',
      disposition: 'archive',
      label_id: 'marketing',
      rule_id: null,
      reason: 'Marketing: a sale',
    });
    expect(await waiting()).toEqual([sale]);
    // Mail the rule decided when it arrived is history, not a suggestion to bring back.
    expect(await current(arrivedUnderRule.id)).toMatchObject({ stage: 'rules', rule_id: arrivedUnderRule.ruleId });
  });

  it('a rule waiting for the label the model gave says what happens, and removing it brings the suggestion back', async () => {
    const sale = await decided('sales@example.com', { ...MARKETING, confidence: 0.9 });
    const other = await decided('sales@example.com', { disposition: 'keep', labelId: 'personal' });
    const ruleId = await addRule(db, { match: { from: ['sales@example.com'] }, whenLabel: 'marketing', disposition: 'keep' }, 'user');

    expect((await redecideWaiting(db, ACCOUNT, 50)).recorded).toBe(1);
    expect(await current(sale)).toMatchObject({
      stage: 'model',
      disposition: 'keep',
      label_id: 'marketing',
      rule_id: ruleId,
      subscription: 'preserve',
      reason: 'rule: from sales@example.com, when it is Marketing: keep it. Marketing: a sale',
    });
    expect(await waiting()).toEqual([other]);
    expect((await redecideWaiting(db, ACCOUNT, 60)).recorded).toBe(0);

    await removeRule(db, ruleId);
    expect((await redecideWaiting(db, ACCOUNT, 70)).recorded).toBe(1);
    expect(await current(sale)).toMatchObject({ stage: 'model', disposition: 'archive', label_id: 'marketing', rule_id: null, reason: 'Marketing: a sale' });
    expect(await waiting()).toEqual([other, sale].toSorted());
  });

  it('goes back to review when no tier had placed it before the rule', async () => {
    const lost = await decided('who@example.com', { stage: 'fallback', reason: 'no stage reached a decision' });
    const ruleId = await addRule(db, { match: { from: ['who@example.com'] }, labelId: 'phishing' }, 'user');
    await redecideWaiting(db, ACCOUNT);
    await removeRule(db, ruleId);
    await redecideWaiting(db, ACCOUNT);
    expect(await current(lost)).toMatchObject({ stage: 'fallback', disposition: 'review', label_id: null });
    expect(await waiting()).toEqual([lost]);
  });

  it('never touches mail the user answered for', async () => {
    const sale = await decided('sales@example.com', MARKETING);
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'sales@example.com', label: 'newsletter', messageId: sale });
    const answered = await decided('shop@example.com', { stage: 'rules', disposition: 'keep', labelId: 'transactional' });
    // An earlier answer of the user's, corrected again.
    await raw(db).run('UPDATE decisions SET by_user = true WHERE message_id = ?', answered);
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'shop@example.com', label: 'marketing', messageId: answered });

    const before = await count();
    expect((await redecideWaiting(db, ACCOUNT)).recorded).toBe(0);
    expect(await count()).toBe(before);
    expect(await current(sale)).toMatchObject({ stage: 'model', label_id: 'marketing' });
    expect(await current(answered)).toMatchObject({ stage: 'rules', label_id: 'marketing' });
  });

  it('an answer given while it runs stands', async () => {
    const sale = await decided('sales@example.com', MARKETING);
    await addRule(db, { match: { from: ['sales@example.com'] }, labelId: 'newsletter' }, 'user');
    // The user answers after the waiting mail was listed and before its new decision is recorded.
    meanwhile = async (on) =>
      void (await applyFeedback(on, { accountId: ACCOUNT, sender: 'sales@example.com', label: 'personal', messageId: sale, carryOut: true }, 70));
    expect((await redecideWaiting(db, ACCOUNT, 70)).recorded).toBe(0);
    expect(await current(sale)).toMatchObject({ stage: 'rules', label_id: 'personal', carry_out: true });
  });

  it('a rule sift learned changes a suggestion only when the outcome differs', async () => {
    const sale = await decided('sales@example.com', MARKETING);
    await addRule(db, { match: { from: ['sales@example.com'] }, labelId: 'marketing' }, 'learned');
    expect((await redecideWaiting(db, ACCOUNT)).recorded).toBe(0);

    await updateLabel(db, 'marketing', { disposition: 'keep' });
    const underLearned = await decided('sales@example.com', {
      stage: 'rules',
      ruleId: (await listRules(db))[0]!.id,
      disposition: 'archive',
      labelId: 'marketing',
    });
    expect((await redecideWaiting(db, ACCOUNT)).recorded).toBe(2);
    expect(await current(sale)).toMatchObject({ stage: 'rules', disposition: 'keep', label_id: 'marketing' });
    expect(await current(underLearned)).toMatchObject({ stage: 'rules', disposition: 'keep' });
    expect(await waiting()).toEqual([sale, underLearned].toSorted());
  });
  it("mail Sift marked for review while on is settled by a rule of the user's that decides it, and its mark taken back", async () => {
    const { mailbox, gmail } = connectGmail(fake.google);
    const labelsOf = (id: string) => gmail.message(id)!.labelIds;
    const asked = async (address: string) => {
      const id = await decided(address);
      await raw(db).run('UPDATE decisions SET carry_out = true WHERE message_id = ?', id);
      gmail.deliver({ id, from: address, labelIds: ['INBOX'] });
      return id;
    };
    const sale = await asked('sales@example.com');
    const news = await asked('news@example.com');
    const ops = await asked('ops@example.com');
    const account = await firstAccount(db);
    await triageAccount({ db, mailbox }, account);
    expect(labelsOf(sale)).toEqual(['INBOX', gmail.labelId('sift/review')]);

    await addRule(db, { match: { from: ['sales@example.com'] }, disposition: 'archive' }, 'user');
    // Not the user's, and one a model must check: neither takes mail from them.
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'learned');
    await addRule(db, { match: { from: ['ops@example.com'] }, labelId: 'notification', when: 'an outage' }, 'user');
    const { recorded, marks } = await redecideWaiting(db, ACCOUNT, 90);
    expect(recorded).toBe(1);
    expect(await current(sale)).toMatchObject({ stage: 'rules', disposition: 'archive', carry_out: true });
    expect(await waiting()).toEqual([news, ops].toSorted());

    for (const mark of marks) await undo({ db, mailbox }, mark);
    await triageAccount({ db, mailbox }, account);
    expect(labelsOf(sale)).toEqual([gmail.labelId('sift/did/archived')]);
    expect(labelsOf(news)).toEqual(['INBOX', gmail.labelId('sift/review')]);
  });

  it('removing a rule sift learned brings back what it decided, even mail it was the first to decide', async () => {
    const ruleId = await addRule(db, { match: { from: ['spam@example.com'] }, labelId: 'marketing' }, 'learned');
    const first = await decided('spam@example.com', { stage: 'rules', ruleId, disposition: 'archive', labelId: 'marketing' });
    expect(await waiting()).toEqual([first]);

    expect(await removeRule(db, ruleId)).toBe('learned');
    // Its rule gone, nothing says the rule was Sift's: without being told, the mail would read as the user's.
    expect(await waiting()).toEqual([]);
    expect((await redecideWaiting(db, ACCOUNT, 90, ruleId)).recorded).toBe(1);
    expect(await current(first)).toMatchObject({ stage: 'fallback', disposition: 'review', rule_id: null });
    expect(await waiting()).toEqual([first]);
  });
});

describe("when a label's outcome changes", () => {
  it('waiting mail with that label gets the new outcome under the same label, without a model', async () => {
    const sale = await decided('sales@example.com', MARKETING);
    const run = await startRun(db, { accountId: ACCOUNT, messageId: sale, model: 'p/m', now: 0 });
    await raw(db).run(`UPDATE decisions SET run_id = ? WHERE message_id = ?`, run, sale);
    const other = await decided('news@example.com', { disposition: 'archive', labelId: 'newsletter', subscription: 'preserve' });
    await updateLabel(db, 'marketing', { disposition: 'keep', unsubscribe: false });

    expect((await redecideWaiting(db, ACCOUNT, 80)).recorded).toBe(1);
    expect(await current(sale)).toEqual({
      stage: 'model',
      disposition: 'keep',
      label_id: 'marketing',
      rule_id: null,
      subscription: 'preserve',
      reason: 'Marketing is now kept. Before: Marketing: a sale',
      // Still what that model call decided.
      run_id: run,
      carry_out: false,
    });
    expect(await current(other)).toMatchObject({ disposition: 'archive', reason: 'Marketing: a sale' });
    expect(await waiting()).toEqual([sale, other].toSorted());
    expect((await redecideWaiting(db, ACCOUNT)).recorded).toBe(0);

    // Changing it again does not pile explanations up.
    await updateLabel(db, 'marketing', { disposition: 'spam' });
    await redecideWaiting(db, ACCOUNT);
    expect(await current(sale)).toMatchObject({
      disposition: 'review',
      reason: expect.stringMatching(/^Marketing is now marked as spam, but .* Before: Marketing: a sale$/),
    });
  });

  it('never starts hiding mail from a sender who was not checked', async () => {
    const unknown = await decided('ada@example.org', { disposition: 'keep', labelId: 'personal', reason: 'Personal: a note' });
    const stranger = await decided('bob@example.org', { disposition: 'keep', labelId: 'personal', reason: 'Personal: a note' });
    const friend = await decided('cy@example.org', { disposition: 'keep', labelId: 'personal', reason: 'Personal: a note' });
    await rememberCorrespondent(db, ACCOUNT, 'bob@example.org', false, 90);
    await rememberCorrespondent(db, ACCOUNT, 'cy@example.org', true, 90);
    await updateLabel(db, 'personal', { disposition: 'archive' });

    expect((await redecideWaiting(db, ACCOUNT, 100)).recorded).toBe(3);
    expect(await current(unknown)).toMatchObject({ disposition: 'review', label_id: 'personal', reason: expect.stringContaining('is not known') });
    expect(await current(stranger)).toMatchObject({ disposition: 'archive', label_id: 'personal' });
    expect(await current(friend)).toMatchObject({ disposition: 'review', reason: expect.stringContaining('you have written to this sender') });
  });

  it('asks about a label the model was not sure enough of, whatever the label now does', async () => {
    const guess = await decided('sales@example.com', { disposition: 'review', labelId: 'marketing', gmailLabel: 'sift/marketing', confidence: 0.6 });
    await updateLabel(db, 'marketing', { disposition: 'keep', unsubscribe: false });
    expect((await redecideWaiting(db, ACCOUNT)).recorded).toBe(0);
    expect(await current(guess)).toMatchObject({ disposition: 'review', label_id: 'marketing', reason: 'Marketing: a sale' });
    // Decided as the label said before the bar, it is held once the label changes.
    const before = await decided('deals@example.com', { ...MARKETING, confidence: 0.6 });
    await updateLabel(db, 'marketing', { disposition: 'archive' });
    await redecideWaiting(db, ACCOUNT);
    expect(await current(before)).toMatchObject({
      disposition: 'review',
      label_id: 'marketing',
      reason: 'Marketing is now archived, but Sift was not sure enough to act on it. Before: Marketing: a sale',
    });
  });

  it('leaves mail sift could not place alone', async () => {
    await decided('who@example.com', { stage: 'fallback' });
    await decided('unsure@example.com', { stage: 'model', reason: 'could be either' });
    await updateLabel(db, 'marketing', { disposition: 'keep' });
    expect((await redecideWaiting(db, ACCOUNT)).recorded).toBe(0);
  });
});
