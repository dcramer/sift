import type { Sql } from '../src/store/sql.ts';
import { beforeEach, describe, expect, it } from 'vitest';
import { type ActionDeps, execute, reconcile, undo } from '../src/actions/executor.ts';
import { planAction } from '../src/actions/plan.ts';
import { recordSync } from '../src/store/accounts.ts';
import { getAction } from '../src/store/actions.ts';
import { connectGmail, fakeGoogle, openUserDb, raw } from './fixtures.ts';
import type { FakeGmail } from './google.ts';
import { ACCOUNT, facts } from './helpers.ts';

const fake = fakeGoogle();

let db: Sql;
let gmail: FakeGmail;
let deps: ActionDeps;
let mine: string;

const labelsOf = (id: string) => gmail.message(id)?.labelIds;
const labelId = (name: string) => gmail.labelId(name)!;
/** The person leaves the message with exactly these labels in Gmail. */
const setLabels = (id: string, labels: string[]) => gmail.change(id, { add: labels, remove: labelsOf(id) });
const modified = () => gmail.asked('users.messages.modify').length;

beforeEach(async () => {
  db = await openUserDb(ACCOUNT);
  await recordSync(db, ACCOUNT, [facts({ messageId: 'm1' })], '2');
  const connected = connectGmail(fake.google);
  gmail = connected.gmail;
  mine = gmail.label('mine');
  gmail.deliver({ id: 'm1', from: 'news@example.com', labelIds: ['INBOX', 'UNREAD', mine] });
  deps = { db, mailbox: connected.mailbox, now: () => 1000 };
});

describe('execute', () => {
  it('archives with an audit label, preserving unread state and other labels', async () => {
    const outcome = await execute(deps, ACCOUNT, 'm1', { type: 'archive' });
    const archived = labelId('sift/did/archived');
    expect(outcome).toMatchObject({ status: 'done', finalLabels: ['UNREAD', mine, archived] });
    const action = await getAction(db, 1);
    expect(action).toMatchObject({
      type: 'archive',
      status: 'done',
      originalLabels: ['INBOX', 'UNREAD', mine],
      payload: { add: [archived], remove: ['INBOX'] },
    });
  });

  it('adds both labels when archiving: what the mail is, and what sift did', async () => {
    await execute(deps, ACCOUNT, 'm1', { type: 'archive', labels: ['sift/newsletters'] });
    expect(labelsOf('m1')).toEqual(['UNREAD', mine, labelId('sift/newsletters'), labelId('sift/did/archived')]);
  });

  it('reads the labels once, before the change, and takes the labels Gmail answers the change with', async () => {
    expect(await execute(deps, ACCOUNT, 'm1', { type: 'archive' })).toMatchObject({ status: 'done' });
    expect(gmail.asked('users.messages.get')).toEqual([{ method: 'users.messages.get', id: 'm1', format: 'minimal' }]);

    setLabels('m1', ['INBOX']);
    gmail.fail('users.messages.modify', 'unchanged');
    expect(await execute(deps, ACCOUNT, 'm1', { type: 'archive' })).toMatchObject({
      status: 'failed',
      reason: 'the labels Gmail gave back did not match the change',
    });
  });

  it('labels without moving the message', async () => {
    await execute(deps, ACCOUNT, 'm1', { type: 'label', labels: ['sift/review'] });
    expect(labelsOf('m1')).toEqual(['INBOX', 'UNREAD', mine, labelId('sift/review')]);
  });

  it('never touches a message that is not in the inbox or no longer exists', async () => {
    setLabels('m1', ['UNREAD']);
    expect(await execute(deps, ACCOUNT, 'm1', { type: 'archive' })).toEqual({ status: 'skipped', reason: 'message is not in the inbox' });
    expect(await execute(deps, ACCOUNT, 'gone', { type: 'archive' })).toEqual({ status: 'skipped', reason: 'message no longer exists' });
    expect(modified()).toBe(0);
    expect(await raw(db).get('SELECT count(*) AS n FROM actions')).toEqual({ n: 0 });
  });

  it('skips when the message already has the label', async () => {
    setLabels('m1', ['INBOX', gmail.label('sift/review')]);
    expect(await execute(deps, ACCOUNT, 'm1', { type: 'label', labels: ['sift/review'] })).toMatchObject({ status: 'skipped' });
    expect(modified()).toBe(0);
  });

  it('marks spam with an audit label', async () => {
    expect(await execute(deps, ACCOUNT, 'm1', { type: 'spam' })).toMatchObject({ status: 'done' });
    expect(labelsOf('m1')).toEqual(['UNREAD', mine, labelId('sift/did/spam'), 'SPAM']);
  });

  it('refuses spam for a sender the user has written to, an unknown sender, or a failed lookup', async () => {
    const written = gmail.deliver({ from: ACCOUNT, to: 'news@example.com', labelIds: ['SENT'] });
    expect(await execute(deps, ACCOUNT, 'm1', { type: 'spam' })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('written to') });

    gmail.delete(written);
    gmail.fail('users.messages.list', { status: 403, reason: 'userRateLimitExceeded' });
    expect(await execute(deps, ACCOUNT, 'm1', { type: 'spam' })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('could not check') });

    gmail.deliver({ id: 'unsynced', from: 'news@example.com', labelIds: ['INBOX'] });
    expect(await execute(deps, ACCOUNT, 'unsynced', { type: 'spam' })).toMatchObject({ status: 'skipped', reason: expect.stringContaining('unknown') });
    expect(modified()).toBe(0);
  });

  it('records unknown when the provider call errors, then settles it from the mailbox without replaying', async () => {
    gmail.fail('users.messages.modify', 'lost');
    const outcome = await execute(deps, ACCOUNT, 'm1', { type: 'archive' });
    expect(outcome).toMatchObject({ status: 'unknown', actionId: 1, reason: expect.stringContaining('Network error') });
    expect(await getAction(db, 1)).toMatchObject({ status: 'unknown', error: (outcome as { reason: string }).reason });

    expect(await reconcile(deps)).toBe(1);
    expect(await getAction(db, 1)).toMatchObject({ status: 'done', finalLabels: ['UNREAD', mine, labelId('sift/did/archived')] });
    expect(modified()).toBe(1);
  });

  it('settles a change that never landed as failed, and the next execute starts clean', async () => {
    gmail.fail('users.messages.modify', 'network');
    const outcome = await execute(deps, ACCOUNT, 'm1', { type: 'archive' });
    expect(outcome).toMatchObject({ status: 'unknown', reason: expect.stringContaining('Network error') });

    expect(await execute(deps, ACCOUNT, 'm1', { type: 'archive' })).toMatchObject({ status: 'done', actionId: 2 });
    expect(await getAction(db, 1)).toMatchObject({ status: 'failed', error: (outcome as { reason: string }).reason });
  });

  it('settles a crash that left an action pending', async () => {
    await raw(db).run(
      `INSERT INTO actions (account_id, message_id, type, payload, original_labels, status, created_at) VALUES (?, 'm1', 'archive', ?, '["INBOX"]', 'pending', 0)`,
      ACCOUNT,
      JSON.stringify({ add: [gmail.label('sift/did/archived')], remove: ['INBOX'] }),
    );
    await reconcile(deps);
    expect(await getAction(db, 1)).toMatchObject({ status: 'failed', error: 'change was not applied' });
  });

  it('settles a change cut short on mail since deleted as failed, and undoes none', async () => {
    gmail.fail('users.messages.modify', 'lost');
    await execute(deps, ACCOUNT, 'm1', { type: 'archive' });
    gmail.delete('m1');
    await reconcile(deps);
    expect(await getAction(db, 1)).toMatchObject({ status: 'failed', error: 'message no longer exists' });

    await recordSync(db, ACCOUNT, [facts({ messageId: 'm2' })], '3');
    gmail.deliver({ id: 'm2', from: 'news@example.com', labelIds: ['INBOX'] });
    await execute(deps, ACCOUNT, 'm2', { type: 'archive' });
    gmail.delete('m2');
    await expect(undo(deps, 2)).rejects.toThrow('The message no longer exists.');
    expect(modified()).toBe(2);
  });
});

describe('marking read', () => {
  it('marks read while archiving or keeping, and undo puts unread back', async () => {
    await execute(deps, ACCOUNT, 'm1', { type: 'archive', labels: ['sift/newsletters'], markRead: true });
    expect(labelsOf('m1')).toEqual([mine, labelId('sift/newsletters'), labelId('sift/did/archived')]);
    await undo(deps, 1);
    expect(labelsOf('m1')?.toSorted()).toEqual(['INBOX', mine, 'UNREAD'].toSorted());

    await execute(deps, ACCOUNT, 'm1', { type: 'label', markRead: true });
    expect(labelsOf('m1')?.toSorted()).toEqual(['INBOX', mine].toSorted());
  });

  it('never marks spam read', async () => {
    await execute(deps, ACCOUNT, 'm1', { type: 'spam', markRead: true });
    expect(labelsOf('m1')).toContain('UNREAD');
  });
});

describe('undo', () => {
  it('restores the inbox and removes what was added', async () => {
    await execute(deps, ACCOUNT, 'm1', { type: 'spam' });
    expect(await undo(deps, 1)).toMatchObject({ status: 'done', actionId: 2 });
    expect(labelsOf('m1')?.toSorted()).toEqual(['INBOX', mine, 'UNREAD'].toSorted());
    expect((await getAction(db, 1))?.status).toBe('undone');
    expect(await getAction(db, 2)).toMatchObject({ type: 'undo', status: 'done', payload: { undoOf: 1 } });
  });

  it('keeps changes the user made afterwards', async () => {
    await execute(deps, ACCOUNT, 'm1', { type: 'archive' });
    const later = gmail.label('later');
    setLabels('m1', ['INBOX', labelId('sift/did/archived'), later]);
    await undo(deps, 1);
    expect(labelsOf('m1')).toEqual(['INBOX', later]);
  });

  it('marks the action undone when the user already reversed it by hand', async () => {
    await execute(deps, ACCOUNT, 'm1', { type: 'archive' });
    setLabels('m1', ['INBOX']);
    expect(await undo(deps, 1)).toMatchObject({ status: 'skipped' });
    expect((await getAction(db, 1))?.status).toBe('undone');
  });

  it('refuses to undo twice, to undo an undo, or to touch trashed mail', async () => {
    await execute(deps, ACCOUNT, 'm1', { type: 'archive' });
    await undo(deps, 1);
    await expect(undo(deps, 1)).rejects.toThrow(/is undone/);
    await expect(undo(deps, 2)).rejects.toThrow(/itself an undo/);
    await expect(undo(deps, 99)).rejects.toThrow(/no change #99/);

    await execute(deps, ACCOUNT, 'm1', { type: 'archive' });
    setLabels('m1', ['TRASH']);
    await expect(undo(deps, 3)).rejects.toThrow(/trash/);
  });
});

describe('planAction', () => {
  const base = { subscription: 'preserve', stage: 'rules', reason: '' } as const;

  it('maps decisions to actions, always carrying the label for what the mail is', () => {
    expect(planAction({ ...base, disposition: 'keep' })).toBeNull();
    expect(planAction({ ...base, disposition: 'keep', gmailLabel: 'sift/personal' })).toEqual({ type: 'label', labels: ['sift/personal'] });
    expect(planAction({ ...base, disposition: 'archive', gmailLabel: 'sift/news' })).toEqual({ type: 'archive', labels: ['sift/news'] });
    expect(planAction({ ...base, disposition: 'spam', gmailLabel: 'sift/junk' })).toEqual({ type: 'spam', labels: ['sift/junk'] });
    expect(planAction({ ...base, disposition: 'review' })).toEqual({ type: 'label', labels: ['sift/review'] });
    expect(planAction({ ...base, disposition: 'keep', markRead: true })).toEqual({ type: 'label', labels: [], markRead: true });
    expect(planAction({ ...base, disposition: 'archive', gmailLabel: 'sift/news', markRead: true })).toEqual({
      type: 'archive',
      labels: ['sift/news'],
      markRead: true,
    });
    expect(planAction({ ...base, disposition: 'review', gmailLabel: 'sift/cold-outreach' })).toEqual({
      type: 'label',
      labels: ['sift/cold-outreach', 'sift/review'],
    });
  });
});
