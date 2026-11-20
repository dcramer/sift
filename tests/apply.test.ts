import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../src/store/sql.ts';
import { pendingSuggestions } from '../src/learn/feedback.ts';
import { redecideWaiting } from '../src/learn/redecide.ts';
import { recordSync } from '../src/store/accounts.ts';
import { execute } from '../src/actions/executor.ts';
import { planAction } from '../src/actions/plan.ts';
import { recordDecision, settleDecision } from '../src/store/decisions.ts';
import { addRule } from '../src/store/rules.ts';
import type { Decision, MessageFacts } from '../src/triage/types.ts';
import { REACH, goingInboxRuns, inboxProgress, startInboxRuns, stopInboxRuns } from '../src/store/inbox.ts';
import { removeRule } from '../src/store/rules.ts';
import { inboxQuery, ruleInbox } from '../src/work/apply.ts';
import { continueRuleRun } from '../src/work/inbox.ts';
import { triageAccount } from '../src/work/triage.ts';
import { connectGmail, fakeGoogle, firstAccount, openUserDb, raw } from './fixtures.ts';
import { ACCOUNT, facts, testModel } from './helpers.ts';

const fake = fakeGoogle();

let db: Sql;
let gmail: ReturnType<typeof connectGmail>;

const message = (id: string, address: string, subject = `Subject ${id}`) =>
  facts({ messageId: id, threadId: `t-${id}`, from: { address, domain: address.split('@')[1]! }, subject, receivedAt: 1000 });

/** `inbox` in Gmail's inbox from before Sift, the first the newest. */
function hold(inbox: MessageFacts[]) {
  inbox.forEach((m, i) =>
    gmail.gmail.deliver(
      {
        id: m.messageId,
        threadId: m.threadId,
        from: m.from.address,
        to: ACCOUNT,
        subject: m.subject,
        labelIds: m.labelIds,
        at: m.receivedAt + inbox.length - i,
      },
      { quietly: true },
    ),
  );
}

const searches = () => gmail.gmail.asked('users.messages.list').map((r) => r.q);
const fetched = () => gmail.gmail.asked('users.messages.get').flatMap((r) => (r.format === 'metadata' && r.id ? [r.id] : []));
const labelsOf = (id: string) => gmail.gmail.message(id)!.labelIds;

/** Press Apply on `rule` and go through the run it starts, as the ticks would. */
async function applyRule(rule: string, now: number) {
  await startInboxRuns(db, [ACCOUNT], { acts: true, most: REACH.inbox, now, ruleId: rule });
  const [run] = await goingInboxRuns(db);
  return await continueRuleRun({ db, api: gmail.api, mailbox: gmail.mailbox, now: () => now }, run!.id);
}

/** What Sift does to a message while on: records the decision and carries it out in Gmail. */
async function decidedWhileOn(messageId: string, decision: Decision) {
  const id = await recordDecision(db, ACCOUNT, messageId, decision, { now: 1, carryOut: true });
  const action = planAction(decision);
  await settleDecision(db, id, action ? (await execute({ db, mailbox: gmail.mailbox, now: () => 1 }, ACCOUNT, messageId, action, id)).status : 'none');
}

const decisionsOf = async (id: string) =>
  await raw(db).all('SELECT stage, disposition, label_id, rule_id, carry_out, by_user FROM decisions WHERE message_id = ? ORDER BY id', id);

beforeEach(async () => {
  db = await openUserDb(ACCOUNT);
  gmail = connectGmail(fake.google);
});

describe('searching the inbox for a rule', () => {
  it('asks Gmail only for what the rule names, and leaves out what could change the search', () => {
    expect(inboxQuery({ from: ['a@example.com'], to: ['me+x@example.org'], listId: ['list.example.com'] })).toBe(
      'from:a@example.com to:me+x@example.org list:list.example.com',
    );
    expect(inboxQuery({ from: ['a@example.com OR in:sent'] })).toBe('');
    expect(inboxQuery({ from: ['a@example.com'], fromDomain: ['example.org'] })).toBe('from:(a@example.com OR example.org)');
    // Gmail finds whole words only, so a search for part of one would miss mail the rule matches.
    expect(inboxQuery({ fromDomain: ['news.example.com'], subjectContains: ['order conf'] })).toBe('from:news.example.com');
    expect(inboxQuery({ from: ['a@example.com', 'b@example.com OR in:sent'] })).toBe('');
  });
});

describe('applying a rule to the inbox', () => {
  it('finds what the rule decides, seen or not, and leaves out what another rule or the user has decided', async () => {
    const rule = await addRule(db, { match: { fromDomain: ['news.example.com'] }, labelId: 'marketing' }, 'user');
    await addRule(db, { match: { from: ['vip@news.example.com'] }, disposition: 'keep' }, 'user');
    const seen = message('seen', 'deals@news.example.com');
    const answered = message('answered', 'deals@news.example.com');
    await recordSync(db, ACCOUNT, [seen, answered], '2');
    await recordDecision(db, ACCOUNT, 'seen', { disposition: 'review', subscription: 'preserve', stage: 'model', reason: 'unsure' }, { now: 1 });
    await recordDecision(db, ACCOUNT, 'answered', { disposition: 'keep', subscription: 'preserve', stage: 'model', reason: 'r' }, { now: 1, byUser: true });
    await redecideWaiting(db, ACCOUNT, 2);
    // Gmail's search finds a subdomain's mail too; the rule is what narrows it.
    hold([seen, answered, message('unseen', 'tips@news.example.com'), message('vip', 'vip@news.example.com'), message('other', 'ada@mail.news.example.com')]);

    const sample = await ruleInbox(db, gmail.api, ACCOUNT, rule);
    expect(searches()).toEqual(['from:news.example.com']);
    expect(sample).toMatchObject({ messages: 2, reading: 0, exact: true, most: null });
    expect(sample.examples.map((m) => m.messageId)).toEqual(['seen', 'unseen']);
    // Mail Sift has a record of is not fetched again, and what it fetched it records, out of the triage queue, deciding nothing.
    expect(fetched().toSorted()).toEqual(['other', 'unseen', 'vip']);
    expect(await raw(db).all(`SELECT id, decided FROM messages WHERE id IN ('unseen', 'vip', 'other') ORDER BY id`)).toEqual([
      { id: 'other', decided: true },
      { id: 'unseen', decided: true },
      { id: 'vip', decided: true },
    ]);
    expect(await raw(db).get(`SELECT count(*) AS n FROM decisions WHERE message_id = 'unseen'`)).toEqual({ n: 0 });
    expect(await ruleInbox(db, gmail.api, ACCOUNT, rule)).toEqual(sample);
    expect(fetched()).toHaveLength(3);
  });

  it("checks only the newest, and scales what they say to Gmail's guess at how many there are", async () => {
    const rule = await addRule(db, { match: { fromDomain: ['news.example.com'] }, labelId: 'marketing' }, 'user');
    // Of the newest twenty, the even ones are the rule's; more than a page in all.
    hold(Array.from({ length: 520 }, (_, i) => message(`m${i}`, i % 2 === 0 ? 'deals@news.example.com' : 'ada@mail.news.example.com')));
    gmail.gmail.estimate = () => 600;

    const sample = await ruleInbox(db, gmail.api, ACCOUNT, rule);
    expect(fetched()).toHaveLength(20);
    expect(sample).toMatchObject({ messages: 300, reading: 0, exact: false, most: null });
    expect(sample.examples.map((m) => m.messageId)).toEqual(['m0', 'm2', 'm4', 'm6', 'm8']);

    // Past what one press goes through, it says so.
    gmail.gmail.estimate = () => 50_000;
    expect(await ruleInbox(db, gmail.api, ACCOUNT, rule)).toMatchObject({ messages: REACH.inbox / 2, most: REACH.inbox });
  });

  it("records each as the user's press, to be carried out while Sift is off, and no longer waiting", async () => {
    const rule = await addRule(db, { match: { fromDomain: ['news.example.com'] }, labelId: 'marketing' }, 'user');
    const seen = message('seen', 'deals@news.example.com');
    await recordSync(db, ACCOUNT, [seen], '2');
    await recordDecision(db, ACCOUNT, 'seen', { disposition: 'review', subscription: 'preserve', stage: 'model', reason: 'unsure' }, { now: 1 });
    await redecideWaiting(db, ACCOUNT, 2);
    hold([seen, message('unseen', 'tips@news.example.com'), message('gone', 'news@news.example.com')]);
    gmail.gmail.meanwhile('users.messages.list', () => gmail.gmail.delete('gone'));

    expect(await applyRule(rule, 3)).toEqual({ from: 0, to: 3, of: 3 });
    for (const id of ['seen', 'unseen'])
      expect((await decisionsOf(id)).at(-1)).toEqual({
        stage: 'rules',
        disposition: 'archive',
        label_id: 'marketing',
        rule_id: rule,
        carry_out: true,
        by_user: true,
      });
    // Pressed twice, nothing more happens.
    await applyRule(rule, 4);
    expect(await decisionsOf('seen')).toHaveLength(3);
    expect(await decisionsOf('unseen')).toHaveLength(1);
    // The run is the rule's to show, not going through the inbox.
    expect(await inboxProgress(db, [ACCOUNT])).toEqual({ going: null, last: null });

    await triageAccount({ db, mailbox: null, answers: gmail.mailbox }, await firstAccount(db));
    expect(labelsOf('seen')).not.toContain('INBOX');
    expect(labelsOf('unseen')).not.toContain('INBOX');
    expect(await pendingSuggestions(db)).toEqual([]);
  });

  it('replaces what Sift did to mail it left in the inbox while on, and leaves mail waiting to be carried out', async () => {
    const rule = await addRule(db, { match: { fromDomain: ['news.example.com'] }, labelId: 'marketing' }, 'user');
    const asked = message('asked', 'deals@news.example.com');
    const kept = message('kept', 'tips@news.example.com');
    const waiting = message('waiting', 'news@news.example.com');
    await recordSync(db, ACCOUNT, [asked, kept, waiting], '2');
    hold([asked, kept, waiting].map((m) => ({ ...m, labelIds: ['INBOX'] })));
    const model = { subscription: 'preserve', stage: 'model' } as const;
    await decidedWhileOn('asked', { ...model, disposition: 'review', reason: 'unsure' });
    await decidedWhileOn('kept', { ...model, disposition: 'keep', labelId: 'everything_else', reason: 'from a person' });
    // Carried out at the next pass.
    await recordDecision(db, ACCOUNT, 'waiting', { ...model, disposition: 'keep', reason: 'r' }, { now: 1, carryOut: true });
    expect(labelsOf('asked')).toContain(gmail.gmail.labelId('sift/review'));

    expect(await ruleInbox(db, gmail.api, ACCOUNT, rule)).toMatchObject({ messages: 2, exact: true });
    await applyRule(rule, 3);
    expect(labelsOf('asked')).toEqual(['INBOX']);
    expect((await decisionsOf('asked')).at(-1)).toMatchObject({ rule_id: rule, carry_out: true, by_user: true });
    expect((await decisionsOf('kept')).at(-1)).toMatchObject({ rule_id: rule, carry_out: true, by_user: true });
    expect(await decisionsOf('waiting')).toHaveLength(1);

    await triageAccount({ db, mailbox: null, answers: gmail.mailbox }, await firstAccount(db));
    for (const id of ['asked', 'kept']) expect(labelsOf(id)).toEqual([gmail.gmail.labelId('sift/marketing'), gmail.gmail.labelId('sift/did/archived')]);
    // Done, the rule has nothing left to do there.
    expect(await ruleInbox(db, gmail.api, ACCOUNT, rule)).toMatchObject({ messages: 0, exact: true });
  });

  it('marks mail a model must read first, and carries out what the rule decides once it has', async () => {
    const rule = await addRule(db, { match: { fromDomain: ['news.example.com'] }, whenLabel: 'marketing', disposition: 'spam' }, 'user');
    hold([message('sale', 'deals@news.example.com'), message('note', 'ceo@news.example.com')].map((m) => ({ ...m, labelIds: ['INBOX'] })));

    expect(await ruleInbox(db, gmail.api, ACCOUNT, rule)).toMatchObject({ messages: 2, reading: 2, exact: true });
    await applyRule(rule, 3);
    expect(await raw(db).all('SELECT id, apply_rule FROM messages ORDER BY id')).toEqual([
      { id: 'note', apply_rule: rule },
      { id: 'sale', apply_rule: rule },
    ]);

    const model = testModel(async ({ evidence }) =>
      evidence.facts.messageId === 'sale' ? { label: 'marketing', reason: 'a sale' } : { label: 'personal', reason: 'from a person', confidence: 0.95 },
    );
    await triageAccount({ db, mailbox: null, answers: gmail.mailbox, model, sources: gmail }, await firstAccount(db));
    expect(await decisionsOf('sale')).toEqual([{ stage: 'model', disposition: 'spam', label_id: 'marketing', rule_id: rule, carry_out: true, by_user: true }]);
    expect(labelsOf('sale')).toContain('SPAM');
    // What the model found it to be is a suggestion, as any mail is while Sift is off.
    expect(await decisionsOf('note')).toEqual([{ stage: 'model', disposition: 'keep', label_id: 'personal', rule_id: null, carry_out: false, by_user: false }]);
    expect(labelsOf('note')).toEqual(['INBOX']);
  });

  it('goes on a slice at a time, stops when asked or when its rule is removed, and leaves going through the inbox alone', async () => {
    const rule = await addRule(db, { match: { fromDomain: ['news.example.com'] }, labelId: 'marketing' }, 'user');
    const other = await addRule(db, { match: { from: ['ada@example.org'] }, disposition: 'archive' }, 'user');
    hold(Array.from({ length: 300 }, (_, i) => message(`m${i}`, 'deals@news.example.com')));
    await startInboxRuns(db, [ACCOUNT], { acts: false, most: REACH.inbox, now: 1 });
    await startInboxRuns(db, [ACCOUNT], { acts: true, most: REACH.inbox, now: 1, ruleId: rule });
    await startInboxRuns(db, [ACCOUNT], { acts: true, most: REACH.inbox, now: 1, ruleId: other });
    // One run per rule at a time.
    expect(await startInboxRuns(db, [ACCOUNT], { acts: true, most: REACH.inbox, now: 1, ruleId: rule })).toBe(0);
    const runOf = async (ruleId: string | null) =>
      (await raw(db).get<{ id: number }>('SELECT id FROM inbox_runs WHERE rule_id IS NOT DISTINCT FROM ?', ruleId))!.id;
    const [whole, mine, theirs] = [await runOf(null), await runOf(rule), await runOf(other)];

    const reach = { db, api: gmail.api, mailbox: gmail.mailbox };
    expect(await continueRuleRun({ ...reach, now: () => 2 }, mine)).toEqual({ from: 0, to: 250, of: 300 });
    await stopInboxRuns(db, rule, 3);
    expect(await continueRuleRun({ ...reach, now: () => 4 }, mine)).toBeNull();
    expect(await raw(db).get(`SELECT count(*) AS n FROM decisions WHERE rule_id = ?`, rule)).toEqual({ n: 250 });

    await removeRule(db, other);
    expect(await continueRuleRun({ ...reach, now: () => 5 }, theirs)).toBeNull();
    expect((await goingInboxRuns(db)).map((r) => r.id)).toEqual([whole]);
  });
});
