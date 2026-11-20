import type { Sql } from '../src/store/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { type RunOptions, runOnce } from '../src/work/run.ts';
import { FILTER_CHECK_MINUTES } from '../src/work/filters.ts';
import { startInboxRuns } from '../src/store/inbox.ts';
import type { Store } from '../src/store/store.ts';
import type { Mailbox } from '../src/actions/mailbox.ts';
import { undo } from '../src/actions/executor.ts';
import { writeRuleFilter } from '../src/actions/rule-filters.ts';
import { applyFeedback } from '../src/learn/feedback.ts';
import { userChanges } from '../src/learn/gmail.ts';
import { insertPendingAction, lastStandingChange } from '../src/store/actions.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { passStatus } from '../src/work/status.ts';
import { TESTING_SIGN_IN_MS, addMailbox, connectAccount, deleteUser, recordSync, removeMailbox, signInEnds, signedIn } from '../src/store/accounts.ts';
import { connectGmail, fakeGoogle, firstAccount, freshStore, modelRun, onePerson, raw, withReason } from './fixtures.ts';
import type { FakeGmail, Mail } from './google.ts';
import { addLabels, updateLabel } from '../src/store/labels.ts';
import { listUndecided } from '../src/store/messages.ts';
import { setActive } from '../src/store/preferences.ts';
import { MAX_ATTEMPTS, startRun } from '../src/store/runs.ts';
import { listProposals } from '../src/store/proposals.ts';
import { addRule, listRules } from '../src/store/rules.ts';
import { rememberCorrespondent } from '../src/store/senders.ts';
import { ACCOUNT, UNSURE, everything, facts, testModel, workDue } from './helpers.ts';
import { listSuggestions } from '../src/dashboard/queries/suggestions.ts';

const fake = fakeGoogle();

const MODIFY = 'users.messages.modify';
const READ = 'users.messages.get';
const LIMITED = { status: 403, reason: 'userRateLimitExceeded' };

/** Mail from a list, addressed to the owner by name, arriving in the inbox unread. */
function message(id: string, from: string, more: Partial<Mail> = {}): Mail {
  return {
    id,
    threadId: `t-${id}`,
    from,
    to: 'Me <me@example.org>',
    subject: `Subject ${id}`,
    text: `Body ${id}`,
    at: 1000,
    ...more,
    headers: { 'List-Id': '<news.example.com>', ...more.headers },
  };
}

let store: Store;
let db: Sql;
let mailbox: Mailbox;
let box: FakeGmail;
/** Mail that arrives in the owner's Gmail as the next pass connects to it, as mail does between passes. */
let inbox: Mail[];
let logs: string[];

/** A message's labels in Gmail now, by name. */
const labelsOf = (id: string) => box.message(id)?.labelIds.map((l) => box.labels.get(l)!.name);
/** What was read of messages whole. */
const readWhole = () => box.asked(READ).flatMap((r) => (r.format === 'full' && r.id ? [r.id] : []));
/** Mail the owner sent `address` before Sift, which Gmail's search finds. */
const wroteTo = (address: string) => box.deliver({ from: ACCOUNT, to: address, labelIds: ['SENT'] }, { quietly: true });
/** Where Gmail's history is now for `address`, as signing in leaves its cursor. */

const connect: RunOptions['connect'] = (_db, account) => {
  if (account.id === ACCOUNT) for (const mail of inbox.splice(0)) box.deliver(mail);
  return connectGmail(fake.google, account.id);
};

/** A model that can place nothing. Mail sift asks about comes from a model's "unsure"; with no model, nothing is asked. */
const unsure = async () => testModel();

const options = (): RunOptions => ({
  ephemeral: memoryEphemeral(),
  connect,
  log: (line) => logs.push(line),
  now: () => 5000,
});
/** The person's database, with sift on or off for them. */
const active = async (on: boolean) => {
  await setActive(db, on);
  return db;
};
const decisions = async () =>
  await raw(db).all('SELECT message_id, stage, disposition, carry_out, outcome, outcome_detail, rule_id FROM decisions ORDER BY id');

beforeEach(async () => {
  ({ store, db } = await onePerson(ACCOUNT));
  ({ mailbox, gmail: box } = connectGmail(fake.google));
  await addMailbox(db, ACCOUNT, fake.google.mailbox(ACCOUNT).cursor());
  logs = [];
  inbox = [message('news', 'News <news@example.com>'), message('ada', 'Ada <ada@example.org>')];
});

describe('runOnce', () => {
  it('is off by default: records what it would do and changes nothing', async () => {
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'newsletter' }, 'user');
    await runOnce(db, { ...options(), model: unsure });

    expect(await decisions()).toMatchObject([
      { message_id: 'ada', stage: 'model', disposition: 'review', carry_out: false, outcome: null },
      { message_id: 'news', stage: 'rules', disposition: 'archive', carry_out: false, outcome: null },
    ]);
    expect(box.asked(MODIFY)).toEqual([]);
    expect(await raw(db).get('SELECT count(*) AS n FROM actions')).toEqual({ n: 0 });
    expect(logs).toEqual([`${ACCOUNT}: 2 new; would archive 1, review 1`]);
  });

  it('asks Gmail again on the next pass for a change that did not land, and stops after three tries', async () => {
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    inbox = [inbox[0]!];
    box.fail(MODIFY, 'network', 'network', 'network');
    await runOnce(await active(true), options());
    expect(await decisions()).toMatchObject([{ message_id: 'news', carry_out: true, outcome: null }]);
    expect(logs.at(-1)).toMatch(/1 change to try again/);
    await runOnce(db, options());
    await runOnce(db, options());
    expect(await decisions()).toMatchObject([{ message_id: 'news', outcome: 'failed' }]);
    expect(logs.at(-1)).toMatch(/1 change not made after 3 tries/);
    await runOnce(db, options());
    expect(labelsOf('news')).toContain('INBOX');
    expect(await raw(db).get("SELECT count(*) AS n FROM actions WHERE type = 'archive'")).toEqual({ n: 3 });
  });

  it('counts a change whose answer was lost but that landed as done, without making it twice', async () => {
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    inbox = [inbox[0]!];
    box.fail(MODIFY, 'lost');
    await runOnce(await active(true), options());
    await runOnce(db, options());
    expect(await decisions()).toMatchObject([{ message_id: 'news', outcome: 'done' }]);
    expect(box.asked(MODIFY)).toHaveLength(1);
  });

  it('settles each mailbox’s unconfirmed changes from that mailbox', async () => {
    const OTHER = 'other@example.org';
    const { db: own } = await onePerson(ACCOUNT, OTHER);
    await setActive(own, true);
    await recordSync(own, OTHER, [facts({ accountId: OTHER, messageId: 'theirs' })], '1');
    const id = await insertPendingAction(
      own,
      { accountId: OTHER, messageId: 'theirs', type: 'archive', payload: { add: [], remove: ['INBOX'] }, originalLabels: ['INBOX'] },
      0,
    );
    fake.google.mailbox(OTHER).deliver({ id: 'theirs', from: 'news@example.com', labelIds: [] });
    await runOnce(own, options());
    expect(await raw(own).get('SELECT status FROM actions WHERE id = ?', id)).toEqual({ status: 'done' });
  });

  it('acts on decisions, links each action to its decision and counts rule hits', async () => {
    const ruleId = await addRule(db, { match: { listId: ['news.example.com'], from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    await addRule(db, { match: { from: ['ada@example.org'] }, labelId: 'personal' }, 'user');
    await runOnce(await active(true), options());

    // Both get the label for what they are; only the archived one gets the label for what sift did.
    expect(labelsOf('news')).toEqual(['UNREAD', 'sift/newsletters', 'sift/did/archived']);
    expect(labelsOf('ada')).toEqual(['INBOX', 'UNREAD', 'sift/personal']);
    expect(await decisions()).toMatchObject([
      { message_id: 'ada', disposition: 'keep', carry_out: true, outcome: 'done' },
      { message_id: 'news', disposition: 'archive', carry_out: true, outcome: 'done', rule_id: ruleId },
    ]);
    expect(await raw(db).all('SELECT message_id, type, status, decision_id FROM actions ORDER BY message_id')).toEqual([
      { message_id: 'ada', type: 'label', status: 'done', decision_id: 1 },
      { message_id: 'news', type: 'archive', status: 'done', decision_id: 2 },
    ]);
    expect((await listRules(db)).map((r) => r.hits)).toEqual([1, 1]);
  });

  it('labels undecided mail for review and leaves it in the inbox', async () => {
    await runOnce(await active(true), { ...options(), model: unsure });
    expect(labelsOf('ada')).toEqual(['INBOX', 'UNREAD', 'sift/review']);
  });

  it('with no model, leaves what no rule covers in the queue: no decision, no question, nothing changed', async () => {
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'newsletter' }, 'user');
    await runOnce(await active(true), options());
    expect(await decisions()).toMatchObject([{ message_id: 'news' }]);
    expect(await decisions()).toHaveLength(1);
    expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.facts.messageId)).toEqual(['ada']);
    expect(labelsOf('ada')).toEqual(['INBOX', 'UNREAD']);
    expect(logs).toEqual([`${ACCOUNT}: 2 new; decided archive 1; 1 changed`]);
  });

  it('decides each message once, however many passes run', async () => {
    await runOnce(await active(true), { ...options(), model: unsure });
    await runOnce(await active(true), { ...options(), model: unsure });
    expect(await decisions()).toHaveLength(2);
    expect(box.asked(MODIFY)).toHaveLength(2);
    expect(logs).toHaveLength(1);
  });

  it('records why a decision was not carried out', async () => {
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'marketing', disposition: 'spam' }, 'user');
    wroteTo('news@example.com');
    // The person archives ada while the model reads it.
    const archiving = async () => testModel(async () => (box.change('ada', { remove: ['INBOX'] }), UNSURE));
    await runOnce(await active(true), { ...options(), model: archiving });

    expect(await decisions()).toMatchObject([
      { message_id: 'ada', outcome: 'skipped', outcome_detail: 'message is not in the inbox' },
      { message_id: 'news', disposition: 'spam', outcome: 'skipped', outcome_detail: 'you have written to this sender, so spam is refused' },
    ]);
    expect(box.asked(MODIFY)).toEqual([]);
  });

  it('says when the failure is an expired Google sign-in, which no retry fixes', async () => {
    await signedIn(db, ACCOUNT, 5000 - TESTING_SIGN_IN_MS);
    const token = fake.google.grant(ACCOUNT);
    fake.google.expire(token);
    const [failed] = await runOnce(await active(false), { ...options(), connect: () => connectGmail(fake.google, ACCOUNT, { token }) });
    expect(failed).toMatchObject({ error: 'invalid_grant', expired: true });
    expect(logs).toEqual([expect.stringContaining('Google sign-in has expired')]);
    // Ended a week after it was given: the next will be too.
    expect(await signInEnds(db)).toEqual(new Map([[ACCOUNT, 5000]]));

    box.fail('users.history.list', LIMITED);
    const [other] = await runOnce(await active(false), options());
    expect(other?.expired).toBeUndefined();
  });

  it('keeps a decision it could not carry out and retries it on the next pass', async () => {
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'newsletter' }, 'user');
    inbox = [inbox[0]!];
    box.failLater(READ, 1, 'network', 'network', 'network');
    const [failed] = await runOnce(await active(true), options());
    expect(failed?.error).toMatch(/gmail\.googleapis\.com/);
    expect(await decisions()).toMatchObject([{ message_id: 'news', carry_out: true, outcome: null }]);

    await runOnce(await active(true), options());
    expect(await decisions()).toMatchObject([{ message_id: 'news', outcome: 'done' }]);
    expect(labelsOf('news')).toEqual(['UNREAD', 'sift/newsletters', 'sift/did/archived']);
  });
});

describe('a tick', () => {
  const person = async (store: Store) => (await raw(store.central).get<{ id: number }>('SELECT id FROM users'))!.id;
  /** The searches of the inbox an inbox run made, which ask for all of it. */
  const searchedInbox = () => box.asked('users.messages.list').flatMap((r) => (r.q === undefined || r.q === '' ? [r.q ?? ''] : []));

  it('reads nothing from Gmail for a mailbox until it has a label of its own, its inbox asked to be gone through or not', async () => {
    const store = await freshStore();
    const NEW = 'new@example.net';
    const newcomer = await connectAccount(store, NEW, '1', 0);
    const own = await store.user(newcomer);
    let connected = 0;
    await startInboxRuns(own, [NEW], { acts: false, most: 10, now: 0 });
    const counting: RunOptions = { ...options(), model: unsure, connect: (own, account) => (connected++, connect(own, account)) };
    expect(await workDue(store, counting, Infinity, [newcomer])).toEqual([]);
    expect(connected).toBe(0);
    await addLabels(own, [{ name: 'Pitches', description: 'From strangers.', disposition: 'archive' }]);
    expect(await workDue(store, counting, Infinity, [newcomer])).toMatchObject([{ email: NEW }]);
    expect(connected).toBe(2);
  });

  it('does what is due for the people it is asked about, or everyone', async () => {
    let connected = 0;
    const counting: RunOptions = { ...options(), connect: (own, account) => (connected++, connect(own, account)) };
    expect(await workDue(store, counting, Infinity)).toMatchObject([{ email: ACCOUNT }]);
    expect(await workDue(store, counting, Infinity, [await person(store)])).toMatchObject([{ email: ACCOUNT }]);
    expect(await workDue(store, counting, Infinity, [999])).toEqual([]);
    expect(connected).toBe(2);
  });

  it('starts nothing after its limit, keeps what it did, and leaves the rest due for the next', async () => {
    inbox.push(message('third', 'Third <third@example.net>'));
    let clock = 0;
    // Each message the model is asked about takes a second.
    const slow = async () => testModel(async () => ((clock += 1000), UNSURE));
    const limited: RunOptions = { ...options(), now: () => clock, model: slow };
    expect(await workDue(store, limited, 1500)).toMatchObject([{ unfinished: true }]);
    // Two were asked about by 2000; the third is still due.
    expect(await raw(db).all('SELECT message_id FROM decisions')).toHaveLength(2);
    expect(logs.at(-1)).toContain('out of time, carrying on');
    const [next] = await workDue(store, limited, Infinity);
    expect(next?.unfinished).toBeUndefined();
    expect(await raw(db).all('SELECT message_id FROM decisions')).toHaveLength(3);
  });

  it('keeps the text the model read for mail it left waiting, out of time too, and reads none of it again', async () => {
    let clock = 0;
    const slow = async () => testModel(async () => ((clock += 1000), UNSURE));
    const limited: RunOptions = { ...options(), now: () => clock, model: slow };
    expect(await workDue(store, limited, 500)).toMatchObject([{ unfinished: true }]);
    expect(readWhole()).toEqual(['ada']);
    expect(await raw(db).all('SELECT message_id, body_text FROM read_bodies')).toEqual([{ message_id: 'ada', body_text: 'sift-plain:Body ada' }]);
  });

  it('fetches the text of mail left waiting by an earlier pass while every pass runs out of time', async () => {
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'learned');
    let clock = 0;
    const slow = async () => testModel(async () => ((clock += 1000), UNSURE));
    const limited: RunOptions = { ...options(), now: () => clock, model: slow };
    // Older than `news`, so the rule places it in the first pass and the model runs out of time on these.
    inbox = [inbox[0]!];
    const backlog = (id: string) => inbox.push(message(id, `Someone <${id}@example.net>`, { at: 500 }));
    backlog('b1');
    backlog('b2');
    expect(await workDue(store, limited, 500)).toMatchObject([{ unfinished: true }]);
    expect(await raw(db).all("SELECT message_id FROM decisions WHERE stage = 'rules'")).toEqual([{ message_id: 'news' }]);
    expect(await raw(db).all("SELECT message_id FROM read_bodies WHERE message_id = 'news'")).toEqual([]);
    backlog('b3');
    backlog('b4');
    expect(await workDue(store, limited, 500)).toMatchObject([{ unfinished: true }]);
    expect(await raw(db).all("SELECT body_text FROM read_bodies WHERE message_id = 'news'")).toEqual([{ body_text: 'sift-plain:Body news' }]);
  });

  it('goes through an inbox it was asked to, until it is all done', async () => {
    await startInboxRuns(db, [ACCOUNT], { acts: false, most: 10, now: 0 });
    const reading: RunOptions = { ...options(), model: unsure };
    await workDue(store, reading, Infinity);
    await workDue(store, reading, Infinity);
    expect(searchedInbox()).toEqual(['']);
    expect(await raw(db).all('SELECT finished_at, stopped FROM inbox_runs')).toEqual([{ finished_at: 5000, stopped: false }]);
  });

  it('waits to go through an inbox while there is no model to ask', async () => {
    await startInboxRuns(db, [ACCOUNT], { acts: false, most: 10, now: 0 });
    await workDue(store, options(), Infinity);
    expect(searchedInbox()).toEqual([]);
    expect(await raw(db).all('SELECT finished_at FROM inbox_runs')).toEqual([{ finished_at: null }]);
  });
});

describe('pass status', () => {
  it('is what the last pass over each mailbox found, kept where every instance can read it', async () => {
    const ephemeral = memoryEphemeral();
    await runOnce(db, { ...options(), ephemeral });
    expect(await passStatus(ephemeral, [ACCOUNT])).toEqual({ lastPassAt: 5000, problems: [], expired: [] });
    const token = fake.google.grant(ACCOUNT);
    fake.google.expire(token);
    await runOnce(db, { ...options(), ephemeral, now: () => 6000, connect: () => connectGmail(fake.google, ACCOUNT, { token }) });
    expect(await passStatus(ephemeral, [ACCOUNT])).toEqual({ lastPassAt: 6000, problems: [`${ACCOUNT}: invalid_grant`], expired: [ACCOUNT] });
  });
});

describe('a mailbox removed while a pass runs', () => {
  it('is skipped, not reported, and the rest of the tick goes on; so is a person deleted meanwhile', async () => {
    const { store } = await onePerson(ACCOUNT, 'other@example.org');
    await addMailbox(db, ACCOUNT, fake.google.mailbox(ACCOUNT).cursor());
    const bravo = await connectAccount(store, 'bravo@example.net', '1', 0);
    const results = await workDue(
      store,
      {
        ...options(),
        connect: async (own, account) => {
          // Removed from the dashboard between listing the mailboxes and reading this one; and someone else deleted meanwhile.
          if (account.id === ACCOUNT) {
            await removeMailbox(store, 1, ACCOUNT);
            await deleteUser(store, bravo);
          }
          return await connect(own, account);
        },
      },
      Infinity,
    );
    // Bravo's pass may have run before the deletion or been skipped after it; neither is a failure.
    expect(results.map((r) => r.email)).toContain('other@example.org');
    expect(results.map((r) => r.email)).not.toContain(ACCOUNT);
    expect(results.filter((r) => r.error)).toEqual([]);
    expect(logs.filter((line) => line.includes('failed'))).toEqual([]);
  });
});

describe('teaching from Gmail', () => {
  const feedback = async () =>
    await raw(db).all(
      'SELECT d.message_id, f.verdict, f.disposition, f.label_id, f.via FROM feedback f JOIN decisions d ON d.id = f.decision_id ORDER BY f.id',
    );
  const latest = async (id: string) =>
    withReason(
      await raw(db).get(
        'SELECT stage, disposition, label_id, carry_out, by_user, rule_id, reason FROM decisions WHERE message_id = ? ORDER BY id DESC LIMIT 1',
        id,
      ),
    );
  const count = async (table: string) => (await raw(db).get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`))!.n;
  // Time moves between passes: which of its own changes sift expects in a history depends on when they were made.
  let clock: number;
  const run = async (on: boolean) => {
    const [result] = await runOnce(await active(on), { ...options(), now: () => clock });
    clock += 1000;
    expect(result?.error).toBeUndefined();
    return result?.sync?.corrections;
  };
  /** Gmail's history read again from the cursor as it is now, as after a pass that stopped before moving it. */
  const again = async () => {
    const { historyId } = await firstAccount(db);
    return async () => await addMailbox(db, ACCOUNT, historyId!);
  };

  beforeEach(async () => {
    clock = 5000;
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    await addRule(db, { match: { from: ['ada@example.org'] }, labelId: 'personal' }, 'user');
  });

  it('takes mail moved back to the inbox as an answer for that message, makes no rule and changes nothing in Gmail', async () => {
    await run(true);
    expect(labelsOf('news')).not.toContain('INBOX');
    box.change('news', { add: ['INBOX'] });
    const calls = box.asked(MODIFY).length;

    expect(await run(true)).toBe(1);
    // The move does not say what the mail is, so the label stands and the outcome is the exception.
    expect(await feedback()).toEqual([{ message_id: 'news', verdict: 'right', disposition: 'keep', label_id: 'newsletter', via: 'gmail' }]);
    expect(await latest('news')).toEqual({
      stage: 'rules',
      disposition: 'keep',
      label_id: 'newsletter',
      carry_out: false,
      by_user: true,
      rule_id: null,
      reason: 'you said this is Newsletters, and to keep it',
    });
    expect(await raw(db).all('SELECT message_id FROM examples')).toEqual([{ message_id: 'news' }]);
    expect(await listRules(db)).toHaveLength(2);
    expect(box.asked(MODIFY)).toHaveLength(calls);
    expect(logs.at(-1)).toMatch(/learned from 1 message you moved or relabelled in Gmail/);
  });

  it('records the same history only once when it is delivered again', async () => {
    await run(true);
    const replay = await again();
    box.change('news', { add: ['INBOX'] });
    expect(await run(true)).toBe(1);
    const before = [await count('decisions'), await count('feedback'), await count('actions')];

    await replay();
    expect(await run(true)).toBe(0);
    expect([await count('decisions'), await count('feedback'), await count('actions')]).toEqual(before);
  });

  it('takes mail out of spam, archived or marked as spam by the user as answers too', async () => {
    await updateLabel(db, 'newsletter', { disposition: 'spam' });
    await run(true);
    expect(labelsOf('news')).toContain('SPAM');

    box.change('news', { add: ['INBOX'], remove: ['SPAM'] });
    box.change('ada', { remove: ['INBOX'] });
    expect(await run(true)).toBe(2);
    expect(await latest('news')).toMatchObject({ disposition: 'keep', label_id: 'newsletter' });
    expect(await latest('ada')).toMatchObject({ disposition: 'archive', label_id: 'personal' });

    box.change('ada', { add: ['SPAM'] });
    expect(await run(true)).toBe(1);
    expect(await latest('ada')).toMatchObject({ disposition: 'spam', label_id: 'personal' });
    // The user's answers are not carried out again by sift.
    expect(labelsOf('ada')).toEqual(['UNREAD', 'sift/personal', 'SPAM']);
  });

  it('takes a different sift label as a correction of what the mail is, wherever the message was left', async () => {
    await run(true);
    box.change('news', { remove: [box.labelId('sift/newsletters')!], add: [box.label('sift/receipts')] });
    expect(await run(true)).toBe(1);
    expect(await feedback()).toEqual([{ message_id: 'news', verdict: 'wrong', disposition: 'archive', label_id: 'transactional', via: 'gmail' }]);
    // Receipts are kept, but the user left this one archived.
    expect(await latest('news')).toMatchObject({ disposition: 'archive', label_id: 'transactional', rule_id: null });
    expect(labelsOf('news')).not.toContain('INBOX');
  });

  it('knows a sift label whose case was changed in Gmail', async () => {
    await run(true);
    box.change('news', { remove: [box.labelId('sift/newsletters')!], add: [box.label('Sift/Receipts')] });
    expect(await run(true)).toBe(1);
    expect(await feedback()).toEqual([{ message_id: 'news', verdict: 'wrong', disposition: 'archive', label_id: 'transactional', via: 'gmail' }]);
  });

  it("ignores labels that are not sift's, stars, and messages that are gone or in the trash", async () => {
    await run(true);
    box.change('news', { add: [box.label('travel'), 'STARRED'] });
    box.change('ada', { remove: ['INBOX'], add: ['TRASH'] });
    box.deliver(message('never-seen', 'Someone <someone@example.net>', { labelIds: [] }), { quietly: true });
    box.change('never-seen', { add: ['INBOX'] });
    expect(await run(true)).toBe(0);

    box.change('news', { add: ['INBOX'] });
    box.delete('news');
    expect(await run(true)).toBe(0);
    expect(await feedback()).toEqual([]);
  });

  it("does not mistake sift's own changes for the user's: changing Gmail, undoing, and putting right after an answer in the dashboard", async () => {
    await run(true);
    expect(await run(true)).toBe(0);

    await undo({ db, mailbox, now: () => clock }, (await lastStandingChange(db, ACCOUNT, 'news'))!.id);
    expect(labelsOf('news')).toContain('INBOX');
    expect(await run(true)).toBe(0);

    await applyFeedback(db, { accountId: ACCOUNT, sender: 'ada@example.org', label: 'newsletter', messageId: 'ada', carryOut: true });
    await undo({ db, mailbox, now: () => clock }, (await lastStandingChange(db, ACCOUNT, 'ada'))!.id);
    expect(await run(true)).toBe(0);
    expect(labelsOf('ada')).not.toContain('INBOX');
    expect(await run(true)).toBe(0);
    expect(await raw(db).get(`SELECT count(*) AS n FROM feedback WHERE via = 'gmail'`)).toEqual({ n: 0 });
  });

  it('tells the user moving mail back from sift archiving it, when both are in the same history', async () => {
    await run(true);
    await undo({ db, mailbox, now: () => clock }, (await lastStandingChange(db, ACCOUNT, 'news'))!.id);
    clock += 1;
    // sift put it back in the inbox, and then the user archived it by hand.
    box.change('news', { remove: ['INBOX'] });
    box.change('news', { add: ['INBOX'] });
    box.change('news', { remove: ['INBOX'] });
    expect(await run(true)).toBe(0);

    box.change('news', { add: ['INBOX'] });
    expect(await run(true)).toBe(1);
    expect(await latest('news')).toMatchObject({ disposition: 'keep' });
  });

  it('while off, counts the user doing what sift suggested as agreement, and doing otherwise as the answer', async () => {
    await raw(db).run(`UPDATE rules SET source = 'learned'`);
    await run(false);
    const replay = await again();
    box.change('news', { remove: ['INBOX'] });
    box.change('ada', { remove: ['INBOX'] });
    expect(await run(false)).toBe(2);
    expect(await feedback()).toEqual([
      { message_id: 'news', verdict: 'right', disposition: 'archive', label_id: 'newsletter', via: 'gmail' },
      { message_id: 'ada', verdict: 'right', disposition: 'archive', label_id: 'personal', via: 'gmail' },
    ]);
    expect(await raw(db).all('SELECT message_id FROM examples ORDER BY message_id')).toEqual([{ message_id: 'ada' }, { message_id: 'news' }]);

    await replay();
    expect(await run(false)).toBe(0);
    expect(await count('feedback')).toBe(2);
    expect(await count('decisions')).toBe(2);
  });

  it('skips mail sift could not place unless the user gave it a sift label', async () => {
    await raw(db).run('DELETE FROM rules');
    await runOnce(await active(true), { ...options(), now: () => clock, model: unsure });
    clock += 1000;
    expect(await latest('news')).toMatchObject({ disposition: 'review', label_id: null });
    box.change('news', { remove: ['INBOX'] });
    expect(await run(true)).toBe(0);

    box.change('ada', { add: [box.label('sift/personal')] });
    expect(await run(true)).toBe(1);
    expect(await latest('ada')).toMatchObject({ disposition: 'keep', label_id: 'personal', rule_id: null });
    expect(await feedback()).toEqual([{ message_id: 'ada', verdict: 'answered', disposition: 'keep', label_id: 'personal', via: 'gmail' }]);
  });
});

describe('telling the user from sift in history', () => {
  const act = async (messageId: string, payload: { add: string[]; remove: string[] }, status: string, at: number) =>
    await raw(db).run(
      `INSERT INTO actions (account_id, message_id, type, payload, original_labels, status, created_at) VALUES (?, ?, 'archive', ?, '[]', ?, ?)`,
      ACCOUNT,
      messageId,
      JSON.stringify(payload),
      status,
      at,
    );

  it('cancels each of its own changes since the last sync against one entry, and leaves the rest', async () => {
    await recordSync(
      db,
      ACCOUNT,
      ['a', 'b', 'c', 'd'].map((messageId) => facts({ messageId })),
      '2',
    );
    await act('a', { add: ['L1'], remove: ['INBOX', 'UNREAD'] }, 'done', 200);
    await act('b', { add: [], remove: ['INBOX'] }, 'unknown', 200);
    await act('c', { add: [], remove: ['INBOX'] }, 'failed', 200);
    await act('d', { add: [], remove: ['INBOX'] }, 'done', 99);
    const history = [
      { messageId: 'a', added: ['L1'], removed: [] },
      { messageId: 'a', added: [], removed: ['INBOX', 'UNREAD'] },
      { messageId: 'a', added: ['INBOX'], removed: [] },
      { messageId: 'a', added: [], removed: ['INBOX'] },
      { messageId: 'b', added: [], removed: ['INBOX'] },
      { messageId: 'c', added: [], removed: ['INBOX'] },
      { messageId: 'd', added: [], removed: ['INBOX'] },
      { messageId: 'e', added: ['STARRED'], removed: ['UNREAD'] },
    ];
    expect(await userChanges(db, ACCOUNT, history, 100)).toEqual([
      { messageId: 'a', added: ['INBOX'], removed: ['INBOX'] },
      { messageId: 'c', added: [], removed: ['INBOX'] },
      { messageId: 'd', added: [], removed: ['INBOX'] },
      { messageId: 'e', added: ['STARRED'], removed: ['UNREAD'] },
    ]);
    expect(await userChanges(db, ACCOUNT, [], 0)).toEqual([]);
  });
});

describe('read state', () => {
  const readAt = async (id: string) => (await raw(db).get<{ read_at: number | null }>('SELECT read_at FROM messages WHERE id = ?', id))!.read_at;

  it('records when the user opened a message, and not when sift marked it read', async () => {
    await updateLabel(db, 'newsletter', { markRead: true });
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'newsletter' }, 'user');
    await runOnce(await active(true), options());
    expect(labelsOf('news')).not.toContain('UNREAD');

    box.change('ada', { remove: ['UNREAD'] });
    await runOnce(await active(true), { ...options(), now: () => 6000 });
    expect(await readAt('news')).toBeNull();
    expect(await readAt('ada')).toBe(6000);
  });

  it('still sees the user open a message sift marked read, undid, and that they then read themselves', async () => {
    await updateLabel(db, 'newsletter', { markRead: true });
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'newsletter' }, 'user');
    await runOnce(await active(true), options());
    await undo({ db, mailbox, now: () => 5000 }, (await lastStandingChange(db, ACCOUNT, 'news'))!.id);
    box.change('news', { remove: ['UNREAD'] });
    await runOnce(await active(true), { ...options(), now: () => 6000 });
    expect(await readAt('news')).toBe(6000);
  });
});

describe('Gmail filters', () => {
  it('are checked during a pass, and a Gmail that cannot list them does not fail it: they are looked at again when the next look is due', async () => {
    const id = await addRule(db, { match: { from: ['ada@example.org'] }, labelId: 'personal' }, 'user');
    await writeRuleFilter({ db, mailbox }, id, ACCOUNT);
    box.filters = [];
    box.fail('users.settings.filters.list', LIMITED);
    const [failed] = await runOnce(await active(false), options());
    expect(failed?.error).toBeUndefined();
    expect(logs.join('\n')).toMatch(/could not check Gmail filters: userRateLimitExceeded/);

    expect((await runOnce(await active(false), options()))[0]?.filters).toBeUndefined();
    const later = 5000 + FILTER_CHECK_MINUTES * 60_000;
    const [result] = await runOnce(await active(false), { ...options(), now: () => later });
    expect(result?.filters).toEqual({ gone: 1, changed: 0, outdated: 0 });
    expect(logs.at(-1)).toMatch(/1 filter deleted in Gmail/);
    expect(await raw(db).get('SELECT filter_id, state FROM rule_filters WHERE rule_id = ?', id)).toEqual({ filter_id: null, state: 'gone' });
  });
});

describe('triage queue', () => {
  it('loses each message as it is decided, by its record and by its decisions', async () => {
    inbox = [inbox[0]!];
    await runOnce(await active(false), { ...options(), model: unsure });
    expect(await raw(db).all('SELECT id, decided FROM messages')).toEqual([{ id: 'news', decided: true }]);
    // As code from before the record said so left it.
    await raw(db).run('UPDATE messages SET decided = false');
    expect(await listUndecided(db, ACCOUNT, 10)).toEqual([]);
  });

  it('rebuilds triage input from the database without refetching', async () => {
    inbox = [inbox[0]!];
    await runOnce(await active(false), options());
    await raw(db).run('DELETE FROM decisions');
    expect((await listUndecided(db, ACCOUNT, 10)).map((queued) => queued.facts)).toEqual([
      {
        accountId: ACCOUNT,
        messageId: 'news',
        threadId: 't-news',
        from: { address: 'news@example.com', domain: 'example.com', name: 'News' },
        to: [{ address: 'me@example.org', domain: 'example.org', name: 'Me' }],
        cc: [],
        subject: 'Subject news',
        labelIds: ['INBOX', 'UNREAD'],
        headers: {
          from: 'News <news@example.com>',
          to: 'Me <me@example.org>',
          subject: 'Subject news',
          'message-id': '<news@mail.example.com>',
          'list-id': '<news.example.com>',
        },
        receivedAt: 1000,
        known: expect.objectContaining({ listId: 'news.example.com', addressed: 'to' }),
      },
    ]);
  });
});

describe('inference tier', () => {
  const INVOICE = { filename: 'invoice.pdf', mimeType: 'application/pdf', data: '%PDF' };
  const judged: string[] = [];
  const model = (label: string) => async () =>
    testModel(async ({ evidence }) => {
      judged.push(evidence.facts.messageId);
      return { label, reason: 'looks like a mailing', confidence: 0.9, usage: { model: 'test/model', inputTokens: 800, outputTokens: 20, costUsd: 0.002 } };
    });

  it('classifies what no rule covers, does what the label says and records the cost', async () => {
    judged.length = 0;
    inbox = [inbox[0]!];
    await runOnce(await active(true), { ...options(), model: model('newsletter') });

    expect(await raw(db).get('SELECT stage, disposition, label_id, model, cost_usd, d.outcome FROM decisions d JOIN model_runs r ON r.id = d.run_id')).toEqual({
      stage: 'model',
      disposition: 'archive',
      label_id: 'newsletter',
      model: 'test/model',
      cost_usd: 0.002,
      outcome: 'done',
    });
    expect(labelsOf('news')).toEqual(['UNREAD', 'sift/newsletters', 'sift/did/archived']);
  });

  it('proposes no rule for a sender the model keeps labelling the same way: it would do what already happens', async () => {
    judged.length = 0;
    for (const id of ['n1', 'n2', 'n3', 'n4', 'n5', 'n6']) {
      inbox = [message(id, 'News <news@example.com>', { labelIds: ['INBOX'] })];
      await runOnce(await active(true), { ...options(), model: model('newsletter') });
    }
    expect(judged).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
    expect(await listProposals(db, ACCOUNT)).toEqual([]);
    expect(logs.some((line) => line.includes('proposed'))).toBe(false);
  });

  it('reads a message before the rules when one asks what only the whole message shows, and once in all', async () => {
    judged.length = 0;
    await addRule(db, { match: { facts: { hasAttachments: true } }, labelId: 'transactional' }, 'user');
    inbox[0] = message('news', 'News <news@example.com>', { attachments: [INVOICE] });
    await runOnce(await active(false), { ...options(), model: model('newsletter') });
    expect(judged).toEqual(['ada']);
    expect(readWhole().toSorted()).toEqual(['ada', 'news']);
    expect(withReason(await raw(db).get(`SELECT stage, label_id, reason FROM decisions WHERE message_id = 'news'`))).toEqual({
      stage: 'rules',
      label_id: 'transactional',
      reason: 'rule: has attachments is Receipts',
    });
    expect(await raw(db).get(`SELECT facts->>'hasAttachments' AS has FROM messages WHERE id = 'news'`)).toEqual({ has: 'true' });
  });

  it('reads a message for a rule on what only the whole message shows with no model connected too', async () => {
    await addRule(db, { match: { facts: { hasAttachments: true } }, labelId: 'transactional' }, 'user');
    inbox[0] = message('news', 'News <news@example.com>', { attachments: [INVOICE] });
    await runOnce(await active(false), options());
    expect(readWhole().toSorted()).toEqual(['ada', 'news']);
    expect(await raw(db).get(`SELECT stage, label_id FROM decisions WHERE message_id = 'news'`)).toEqual({ stage: 'rules', label_id: 'transactional' });
    // Nothing else covers it, and with no model it waits.
    expect(await raw(db).get(`SELECT count(*)::integer AS n FROM decisions WHERE message_id = 'ada'`)).toEqual({ n: 0 });
  });

  it('archives what an action rule covers without asking the model or naming a label', async () => {
    judged.length = 0;
    const ruleId = await addRule(db, { match: { from: ['news@example.com'] }, disposition: 'archive' }, 'user');
    inbox = [message('g1', 'News <news@example.com>')];
    await runOnce(await active(true), { ...options(), model: model('newsletter') });
    expect(judged).toEqual([]);
    expect(withReason(await raw(db).get(`SELECT stage, disposition, label_id, rule_id, reason FROM decisions WHERE message_id = 'g1'`))).toEqual({
      stage: 'rules',
      disposition: 'archive',
      label_id: null,
      rule_id: ruleId,
      reason: 'rule: from news@example.com: archive it',
    });
    // Out of the inbox, marked as sift's doing, and given no label of what it is.
    expect(labelsOf('g1')).toEqual(['UNREAD', 'sift/did/archived']);
  });

  it('applies a rule that waits for a label only to mail the model gives that label, and asks about the rest', async () => {
    judged.length = 0;
    const ruleId = await addRule(db, { match: { from: ['news@example.com'] }, whenLabel: 'newsletter' }, 'user');
    inbox = [message('u1', 'News <news@example.com>', { labelIds: ['INBOX'] })];
    await runOnce(await active(true), { ...options(), model: model('newsletter') });
    expect(judged).toEqual(['u1']);
    expect(withReason(await raw(db).get(`SELECT stage, disposition, rule_id, reason FROM decisions WHERE message_id = 'u1'`))).toEqual({
      stage: 'model',
      disposition: 'archive',
      rule_id: ruleId,
      reason: 'rule: from news@example.com, when it is Newsletters. Newsletters: looks like a mailing',
    });

    inbox = [message('u2', 'News <news@example.com>', { labelIds: ['INBOX'] })];
    await runOnce(await active(true), { ...options(), model: model('security') });
    expect(withReason(await raw(db).get(`SELECT disposition, label_id, rule_id, reason FROM decisions WHERE message_id = 'u2'`))).toEqual({
      disposition: 'keep',
      label_id: 'security',
      rule_id: null,
      reason: 'not the usual Newsletters. Account alerts: looks like a mailing',
    });
    expect(labelsOf('u2')).toContain('INBOX');
  });

  it('gathers evidence and classifies while sift is off, without changing the mailbox', async () => {
    judged.length = 0;
    inbox = [inbox[0]!];
    await runOnce(await active(false), { ...options(), model: model('marketing') });
    expect(judged).toEqual(['news']);
    expect(await raw(db).get('SELECT disposition, carry_out, outcome FROM decisions')).toEqual({ disposition: 'archive', carry_out: false, outcome: null });
    expect(box.asked(MODIFY)).toEqual([]);
  });
});

describe('a failed model call', () => {
  const runs = async () => await raw(db).all('SELECT message_id, model, error, cost_usd FROM model_runs ORDER BY id');
  const usage = { model: 'test/model', inputTokens: 900, outputTokens: 5, costUsd: 0.001 };
  /** A provider that is down. */
  const failing =
    (asked: string[] = []) =>
    async () =>
      testModel(async ({ evidence }) => (asked.push(evidence.facts.messageId), { failed: 'rate limited', usage }));
  /** A model that answers, but never with a verdict sift can use. */
  const unusable = async () => testModel(async () => ({ failed: 'the model did not return a usable verdict', usage, unusable: true as const }));
  /** A model that answers for every message but those in `failing`, where the provider errs. */
  const flaky =
    (failing: string[], asked: string[] = []) =>
    async () =>
      testModel(async ({ evidence }) => {
        asked.push(evidence.facts.messageId);
        return failing.includes(evidence.facts.messageId) ? { failed: 'rate limited' } : { label: 'newsletter', reason: 'r' };
      });
  const excused = async () =>
    (await raw(db).all<{ message_id: string }>('SELECT message_id FROM model_runs WHERE retried_at IS NOT NULL ORDER BY id')).map((r) => r.message_id);

  it('decides nothing and is tried again on later passes, until it has failed three times', async () => {
    inbox = [inbox[0]!];
    for (let pass = 1; pass <= 3; pass++) {
      await runOnce(db, { ...options(), model: unusable });
      expect(await decisions()).toEqual([]);
      expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.outOfTries)).toEqual([pass === 3]);
    }
    // A failed call was still billed.
    expect(await runs()).toEqual(
      Array.from({ length: 3 }, () => ({
        message_id: 'news',
        model: 'test/model',
        error: 'the model did not return a usable verdict',
        cost_usd: 0.001,
      })),
    );
    expect(logs.at(-1)).toContain('the model failed on 1: the model did not return a usable verdict');

    const asked: string[] = [];
    await runOnce(db, { ...options(), model: failing(asked) });
    expect(asked).toEqual([]);
  });

  it('keeps why a call that threw failed as a status and kind, never what it said', async () => {
    inbox = [inbox[0]!];
    const throwing = async () =>
      testModel(async () => {
        throw Object.assign(new Error('429 Too Many Requests while reading "Weekly digest"'), { status: 429 });
      });
    await runOnce(db, { ...options(), model: throwing });
    expect(await runs()).toEqual([{ message_id: 'news', model: 'test/model', error: 'HTTP 429 rate limited', cost_usd: 0 }]);
  });

  it('uses up no tries while the provider is down: a pass in which the model never answers', async () => {
    inbox = [inbox[0]!];
    for (let pass = 0; pass <= MAX_ATTEMPTS; pass++) await runOnce(db, { ...options(), model: failing() });
    expect(await listUndecided(db, ACCOUNT, 10)).toHaveLength(1);
    expect(await excused()).toEqual(Array.from({ length: MAX_ATTEMPTS + 1 }, () => 'news'));
    // Billed all the same.
    expect((await runs()).every((r) => (r as { cost_usd: number }).cost_usd === 0.001)).toBe(true);
  });

  it('counts an error while the model answers other calls, and excuses the run of errors that stopped the pass', async () => {
    inbox = [1, 2, 3, 4, 5, 6, 7].map((n) => message(`m${n}`, `S${n} <s${n}@example.org>`, { at: 9000 - n }));
    const asked: string[] = [];
    await runOnce(db, { ...options(), model: flaky(['m2', 'm4', 'm5', 'm6', 'm7'], asked) });
    expect(asked).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(await excused()).toEqual(['m4', 'm5', 'm6']);
    expect(await raw(db).all(`SELECT message_id FROM model_runs WHERE error IS NOT NULL AND retried_at IS NULL`)).toEqual([{ message_id: 'm2' }]);
    expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.facts.messageId)).toEqual(['m2', 'm4', 'm5', 'm6', 'm7']);
  });

  it('counts a billed verdict that was never recorded as a try', async () => {
    inbox = [inbox[0]!];
    await runOnce(db, options());
    for (let i = 0; i < MAX_ATTEMPTS; i++) await modelRun(db, { messageId: 'news', at: 0, usage });
    expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.outOfTries)).toEqual([true]);
  });

  it('after it stops asking, leaves mail the model would have judged in the queue, not to a weaker rule', async () => {
    await addRule(db, { match: { fromDomain: ['example.com'] }, disposition: 'archive' }, 'user');
    await addRule(db, { match: { from: ['late@example.com'] }, whenLabel: 'personal' }, 'user');
    inbox = [1, 2, 3].map((n) => message(`m${n}`, `S${n} <s${n}@example.org>`, { at: 9000 - n }));
    inbox.push(message('late', 'Late <late@example.com>', { at: 1 }));
    await runOnce(db, { ...options(), model: failing() });
    expect(await decisions()).toEqual([]);
    expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.facts.messageId)).toContain('late');
  });

  it('counts a run the pass never finished as failed', async () => {
    inbox = [inbox[0]!];
    await runOnce(db, options());
    for (let i = 0; i < MAX_ATTEMPTS; i++) await startRun(db, { accountId: ACCOUNT, messageId: 'news', model: 'test/model', now: 0 });
    expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.outOfTries)).toEqual([true]);
  });

  it('stops asking after three failures in a row, and still decides what a rule covers', async () => {
    await addRule(db, { match: { from: ['ruled@example.com'] }, disposition: 'archive' }, 'user');
    inbox = [1, 2, 3, 4].map((n) => message(`m${n}`, `S${n} <s${n}@example.com>`, { at: 9000 - n }));
    inbox.push(message('ruled', 'Ruled <ruled@example.com>', { at: 1 }));
    const asked: string[] = [];
    await runOnce(db, { ...options(), model: failing(asked) });
    expect(asked).toEqual(['m1', 'm2', 'm3']);
    expect(await decisions()).toMatchObject([{ message_id: 'ruled', stage: 'rules' }]);
    expect((await listUndecided(db, ACCOUNT, 10)).map((m) => m.facts.messageId)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it("once out of tries, asks the model no more: a rule may say what it is, and otherwise it is the user's to say", async () => {
    inbox = [inbox[0]!];
    for (let pass = 0; pass < MAX_ATTEMPTS; pass++) await runOnce(db, { ...options(), model: unusable });
    expect(await decisions()).toEqual([]);
    const asked = (await runs()).length;
    await runOnce(db, { ...options(), model: unusable });
    expect(await runs()).toHaveLength(asked);
    expect(withReason(await raw(db).get(`SELECT stage, disposition, label_id, carry_out, reason FROM decisions WHERE message_id = 'news'`))).toEqual({
      stage: 'fallback',
      disposition: 'review',
      label_id: null,
      carry_out: false,
      reason: 'the model failed on it each time it was asked',
    });
    expect((await listSuggestions(db, await everything(db))).items.map((i) => [i.messageId, i.labelId])).toEqual([['news', null]]);
  });

  it('once out of tries, is decided by a rule added since', async () => {
    inbox = [inbox[0]!];
    for (let pass = 0; pass < MAX_ATTEMPTS; pass++) await runOnce(db, { ...options(), model: unusable });
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    await runOnce(db, { ...options(), model: unusable });
    expect(await decisions()).toMatchObject([{ message_id: 'news', stage: 'rules' }]);
  });
});

describe('unsubscribing', () => {
  const asked: string[] = [];
  const withUnsubscribe = (result: 'done' | 'refused' = 'done'): RunOptions => ({
    ...options(),
    unsubscribe: async (_db, _account, messageId) => {
      asked.push(messageId);
      return result === 'done' ? { status: 'done', actionId: 1 } : { status: 'refused', reason: 'no way to' };
    },
  });

  it('follows the mailbox change for a label that unsubscribes, and only while on', async () => {
    asked.length = 0;
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'cold_outreach' }, 'user');
    inbox = [inbox[0]!];
    await runOnce(await active(false), withUnsubscribe());
    expect(asked).toEqual([]);
    expect(await raw(db).get('SELECT subscription FROM decisions')).toEqual({ subscription: 'unsubscribe' });

    await raw(db).run('DELETE FROM decisions');
    await raw(db).run('UPDATE messages SET decided = false');
    await runOnce(await active(true), withUnsubscribe());
    expect(asked).toEqual(['news']);
    expect(labelsOf('news')).toContain('sift/did/archived');
    expect(logs.at(-1)).toContain('unsubscribed from 1 sender');
  });

  it('can be asked for by a rule whose label does not, and is not counted when it could not be done', async () => {
    asked.length = 0;
    await addRule(db, { match: { from: ['ada@example.org'] }, labelId: 'security', subscription: 'unsubscribe', markRead: true }, 'user');
    inbox = [inbox[1]!];
    await runOnce(await active(true), withUnsubscribe('refused'));
    expect(asked).toEqual(['ada']);
    // Kept, labelled, and marked read as the rule asks.
    expect(labelsOf('ada')).toEqual(['INBOX', 'sift/security']);
    expect(logs.at(-1)).not.toContain('unsubscribed');
  });

  it('never unsubscribes from someone the user has written to, or when the mailbox change did not happen', async () => {
    asked.length = 0;
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'cold_outreach' }, 'user');
    await rememberCorrespondent(db, ACCOUNT, 'news@example.com', true);
    inbox = [inbox[0]!];
    await runOnce(await active(true), withUnsubscribe());
    expect(labelsOf('news')).toContain('sift/did/archived');
    expect(asked).toEqual([]);

    await raw(db).run('DELETE FROM actions');
    await raw(db).run('DELETE FROM decisions');
    await raw(db).run('UPDATE messages SET decided = false');
    await raw(db).run('DELETE FROM correspondents');
    expect(labelsOf('news')).not.toContain('INBOX');
    await runOnce(await active(true), withUnsubscribe());
    expect(await raw(db).get('SELECT outcome FROM decisions')).toEqual({ outcome: 'skipped' });
    expect(asked).toEqual([]);
  });
});

describe('correcting what sift did', () => {
  it('takes the change back and carries out what the user said instead', async () => {
    await addRule(db, { match: { fromDomain: ['example.com'] }, labelId: 'newsletter' }, 'learned');
    inbox = [inbox[0]!];
    await runOnce(await active(true), options());
    expect(labelsOf('news')).toEqual(['UNREAD', 'sift/newsletters', 'sift/did/archived']);

    const result = await applyFeedback(db, {
      accountId: ACCOUNT,
      sender: 'news@example.com',
      label: 'personal',
      messageId: 'news',
      carryOut: true,
    });
    expect(result.corrected).toBe('news');
    // What the dashboard asks the running sift to do next.
    const last = await lastStandingChange(db, ACCOUNT, 'news');
    await undo({ db, mailbox }, last!.id);
    expect(labelsOf('news')?.toSorted()).toEqual(['INBOX', 'UNREAD']);

    await runOnce(await active(true), options());
    expect(labelsOf('news')?.toSorted()).toEqual(['INBOX', 'UNREAD', 'sift/personal']);
    expect(await raw(db).get(`SELECT disposition, outcome FROM decisions WHERE message_id = 'news' ORDER BY id DESC LIMIT 1`)).toEqual({
      disposition: 'keep',
      outcome: 'done',
    });
    expect(await lastStandingChange(db, ACCOUNT, 'news')).toMatchObject({ type: 'label' });
  });
});

describe('blocking', () => {
  const phish = (id: string, authenticated: boolean) =>
    message(id, 'Bank <alerts@example.net>', {
      subject: 'Verify your account',
      labelIds: ['INBOX'],
      headers: { 'Authentication-Results': `mx.google.com; dmarc=${authenticated ? 'pass' : 'fail'}` },
    });
  const phishing = async () => testModel(async () => ({ label: 'phishing', reason: 'asks for a password', confidence: 0.95 }));
  beforeEach(async () => {
    await updateLabel(db, 'phishing', { block: true });
  });

  it('marks the message spam and makes a rule for the sender, so their later mail needs no model', async () => {
    inbox = [phish('p1', true)];
    await runOnce(await active(true), { ...options(), model: phishing });
    expect(labelsOf('p1')).toEqual(['sift/phishing', 'sift/did/spam', 'SPAM']);
    expect(await listRules(db)).toMatchObject([{ match: { from: ['alerts@example.net'] }, labelId: 'phishing', source: 'learned' }]);
    expect(logs.at(-1)).toContain('blocked 1 sender');

    let asked = 0;
    inbox = [phish('p2', true)];
    await runOnce(await active(true), { ...options(), model: async () => testModel(async () => (asked++, { failed: 'not expected' })) });
    expect(asked).toBe(0);
    expect(await raw(db).get(`SELECT stage, disposition, block FROM decisions WHERE message_id = 'p2'`)).toEqual({
      stage: 'rules',
      disposition: 'spam',
      block: true,
    });
  });

  it('does not block a sender whose message did not prove who sent it, or while off', async () => {
    inbox = [phish('p1', false)];
    await runOnce(await active(true), { ...options(), model: phishing });
    expect(labelsOf('p1')).toContain('SPAM');
    expect(await listRules(db)).toEqual([]);

    inbox = [phish('p2', true)];
    await runOnce(await active(false), { ...options(), model: phishing });
    expect(await listRules(db)).toEqual([]);
  });

  it('holds mail from someone the user has written to for review instead, and blocks nobody', async () => {
    wroteTo('alerts@example.net');
    inbox = [phish('p1', true)];
    await runOnce(await active(true), { ...options(), model: phishing });
    expect(labelsOf('p1')).toEqual(['INBOX', 'sift/phishing', 'sift/review']);
    expect(await listRules(db)).toEqual([]);
  });
});

describe('examples', () => {
  it('stores a marked message whole from the text held while it waited, while off, without reading it again', async () => {
    inbox = [message('news', 'News <news@example.com>', { text: 'The full text of the newsletter.' })];
    await runOnce(await active(false), {
      ...options(),
      model: async () => testModel(async () => ({ label: 'newsletter', reason: 'r' })),
    });
    await applyFeedback(db, { accountId: ACCOUNT, sender: 'news@example.com', label: 'newsletter', messageId: 'news' });

    const [result] = await runOnce(await active(false), options());
    expect(result?.captured).toBe(0);
    expect(await raw(db).get('SELECT label_id, body_text FROM examples')).toEqual({
      label_id: 'newsletter',
      body_text: 'sift-plain:The full text of the newsletter.',
    });
    expect(readWhole()).toEqual(['news']);
    expect(box.asked(MODIFY)).toEqual([]);
  });
});
