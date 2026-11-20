import { beforeEach, describe, expect, it } from 'vitest';
import type { Sql } from '../src/store/sql.ts';
import type { Store } from '../src/store/store.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { people } from '../src/store/people.ts';
import { setActive, setMail } from '../src/store/preferences.ts';
import type { Judge } from '../src/triage/stages/model.ts';
import { type RunOptions, runOnce } from '../src/work/run.ts';
import { copyMail } from '../src/work/copy.ts';
import { ruleInbox } from '../src/work/apply.ts';
import { continueRuleRun } from '../src/work/inbox.ts';
import { goingInboxRuns, startInboxRuns } from '../src/store/inbox.ts';
import { addRule } from '../src/store/rules.ts';
import { ACCOUNT, FakeMailbox, onceGmail, rawMessage, tempDir, testModel } from './helpers.ts';
import { onePerson, raw, startDashboard } from './fixtures.ts';
import { buildControls } from '../src/sift/controls.ts';
import type { StandIns } from '../src/sift/sift.ts';
import { loadConfig } from '../src/config.ts';

const NOW = Date.UTC(2026, 10, 19, 12);
const HOUR = 3_600_000;

let store: Store;
let db: Sql;
let mailbox: FakeMailbox;
let gmail: ReturnType<typeof onceGmail>;

/** Mail from `from`, arrived `hoursAgo`; a reply in `thread` when given one. */
function mail(
  id: string,
  from: string,
  { hoursAgo = 1, thread, labels = ['INBOX', 'UNREAD'] }: { hoursAgo?: number; thread?: string; labels?: string[] } = {},
) {
  return {
    ...rawMessage(id, {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: ACCOUNT },
        { name: 'Subject', value: `Subject ${id}` },
        ...(thread ? [{ name: 'In-Reply-To', value: `<${thread}@example.org>` }] : []),
      ],
    }),
    threadId: thread ?? `t-${id}`,
    labelIds: labels,
    internalDate: NOW - hoursAgo * HOUR,
  };
}

const options = (judge?: Judge): RunOptions => ({
  ephemeral: memoryEphemeral(),
  connect: () => ({ api: gmail.api, mailbox }),
  ...(judge ? { model: async () => testModel(judge) } : {}),
  log: () => {},
  now: () => NOW,
});

const decided = async () => await raw(db).all('SELECT message_id, label_id FROM decisions ORDER BY id');

beforeEach(async () => {
  ({ store, db } = await onePerson(ACCOUNT));
  mailbox = new FakeMailbox();
  gmail = onceGmail(mailbox);
});

describe('with Inbox off, each message is read from Gmail once', () => {
  it('across a pass, a model call tried on the next pass, and an answer from the dashboard kept as an example', async () => {
    gmail.deliver(mail('kept', 'Ada <ada@example.org>'));
    gmail.deliver(mail('flaky', 'Bo <bo@example.net>', { thread: 'started' }));
    let failing = true;
    const judge: Judge = async ({ evidence }) =>
      evidence.facts.messageId === 'flaky' && failing
        ? { failed: 'the model did not return a usable verdict', unusable: true }
        : { label: 'personal', reason: 'from a person', confidence: 0.95 };

    await runOnce(db, options(judge));
    expect(await decided()).toEqual([{ message_id: 'kept', label_id: 'personal' }]);
    failing = false;
    await runOnce(db, options(judge));
    expect(await decided()).toEqual([
      { message_id: 'kept', label_id: 'personal' },
      { message_id: 'flaky', label_id: 'personal' },
    ]);

    const { call } = await startDashboard(people(store));
    const answered = await call('POST', '/api/feedback', { accountId: ACCOUNT, sender: 'ada@example.org', label: 'request', messageId: 'kept' });
    expect(answered.status).toBe(200);
    await runOnce(db, options(judge));
    expect(await raw(db).get(`SELECT status, body_text FROM examples WHERE message_id = 'kept'`)).toEqual({
      status: 'captured',
      body_text: 'sift-plain:Text of kept.',
    });

    expect(gmail.again).toEqual([]);
    expect(gmail.reads.toSorted()).toEqual(['meta:flaky', 'meta:kept', 'thread:started', 'whole:flaky', 'whole:kept']);
  });

  it('learns a correction made in Gmail from history and the record', async () => {
    await setActive(db, true);
    gmail.deliver(mail('news', 'News <news@example.com>'));
    await runOnce(
      db,
      options(async () => ({ label: 'newsletter', reason: 'a newsletter', confidence: 0.95 })),
    );
    expect(mailbox.labels.get('news')).not.toContain('INBOX');

    mailbox.byUser('news', { add: ['INBOX'] });
    await runOnce(db, options());
    expect(await raw(db).all('SELECT via, disposition FROM feedback')).toEqual([{ via: 'gmail', disposition: 'keep' }]);

    expect(gmail.again).toEqual([]);
    expect(gmail.reads).toEqual(['meta:news', 'whole:news']);
  });
});

describe('applying a rule to mail already there', () => {
  it('reads from Gmail only mail Sift never recorded, once, however often it is looked at', async () => {
    gmail.deliver(mail('seen', 'News <news@example.com>'));
    await runOnce(db, options());
    for (const [id, from, hoursAgo] of [
      ['old1', 'News <news@example.com>', 48],
      ['other', 'Bo <bo@example.net>', 49],
      ['old2', 'News <news@example.com>', 50],
    ] as const)
      gmail.deliver(mail(id, from, { hoursAgo }), { quietly: true });
    const rule = await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');

    for (let look = 0; look < 2; look++) expect(await ruleInbox(db, gmail.api, ACCOUNT, rule, NOW)).toMatchObject({ messages: 3, reading: 0, exact: true });
    await startInboxRuns(db, [ACCOUNT], { acts: false, most: 10_000, now: NOW, ruleId: rule });
    const [run] = await goingInboxRuns(db);
    await continueRuleRun({ db, api: gmail.api, mailbox, now: () => NOW }, run!.id);
    expect(await raw(db).all('SELECT message_id, by_user FROM decisions ORDER BY message_id')).toEqual([
      { message_id: 'old1', by_user: true },
      { message_id: 'old2', by_user: true },
      { message_id: 'seen', by_user: true },
    ]);

    expect(gmail.again).toEqual([]);
    expect(gmail.reads.filter((r) => r !== 'search').toSorted()).toEqual(['meta:old1', 'meta:old2', 'meta:other', 'meta:seen']);
  });
});

describe('with Inbox on, a message is read once, whole', () => {
  it('as it arrives, for the model and for Inbox alike, and its conversation is shown from the record', async () => {
    gmail.deliver(mail('asked', 'Me <me@example.org>', { hoursAgo: 30, labels: ['SENT'] }));
    gmail.deliver(mail('answer', 'Ada <ada@example.org>', { hoursAgo: 20, thread: 't-asked' }), { quietly: true });
    await setMail(db, true, { now: NOW, window: 'year' });
    expect(await copyMail({ db, api: gmail.api, now: () => NOW }, ACCOUNT)).toBe(2);

    gmail.deliver(mail('again', 'Ada <ada@example.org>', { thread: 't-asked' }));
    await runOnce(
      db,
      options(async () => ({ label: 'personal', reason: 'from a person', confidence: 0.95 })),
    );
    expect(await decided()).toEqual([{ message_id: 'again', label_id: 'personal' }]);
    expect(await raw(db).get(`SELECT facts->>'earlierInThread' AS earlier, facts->>'ownerInThread' AS owner FROM messages WHERE id = 'again'`)).toEqual({
      earlier: '2',
      owner: 'true',
    });
    const read = gmail.reads.length;

    const { call } = await startDashboard(people(store));
    const shown = await call('GET', '/api/mail/thread?thread=t-asked');
    expect(shown.status).toBe(200);
    expect((shown.body as { messages: { messageId: string }[] }).messages.map((m) => m.messageId)).toEqual(['asked', 'answer', 'again']);
    expect((await call('GET', '/api/message?id=again')).body).toMatchObject({ body: 'Text of again.' });

    expect(gmail.again).toEqual([]);
    expect(gmail.reads.length).toBe(read);
    expect(gmail.reads.filter((r) => r !== 'search')).toEqual(['whole:answer', 'whole:asked', 'whole:again']);
  });
});

describe('counts only Gmail knows', () => {
  it('are asked of it once in five minutes, however often a page opens on them', async () => {
    gmail.deliver(mail('news', 'News <news@example.com>'));
    const rule = await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user');
    const controls = await buildControls(loadConfig({ SIFT_HOME: tempDir() }), {
      ephemeral: memoryEphemeral(),
      deviceId: 'device',
      kick: async () => {},
      standIns: { gmail: () => ({ api: gmail.api, mailbox }) } as Partial<StandIns> as StandIns,
    });
    for (let look = 0; look < 2; look++) {
      expect(await controls.inboxEstimate(db, [ACCOUNT], 'inbox')).toMatchObject({ messages: 1 });
      expect(await controls.mailReach(db, [ACCOUNT])).toMatchObject({ all: { messages: 1 } });
      expect(await controls.ruleInbox(db, rule)).toMatchObject({ messages: 1 });
    }
    expect(gmail.reads.filter((r) => r === 'count' || r === 'search')).toEqual(['count', 'count', 'search']);
    expect(gmail.again).toEqual([]);
  });
});
