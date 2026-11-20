import { describe, expect, it } from 'vitest';
import { type Kind, nextOf } from '../src/dashboard/queries/contacts.ts';
import type { ContactPage, SenderPage } from '../src/dashboard/types.ts';
import { recordSync } from '../src/store/accounts.ts';
import { recordDecision } from '../src/store/decisions.ts';
import { people } from '../src/store/people.ts';
import { addRule } from '../src/store/rules.ts';
import { rememberCorrespondent } from '../src/store/senders.ts';
import { applyFeedback } from '../src/learn/feedback.ts';
import { plain } from '../src/plain.ts';
import { onePerson, startDashboard } from './fixtures.ts';
import { ACCOUNT, DAY, facts } from './helpers.ts';

const NOW = Date.UTC(2026, 5, 15, 12);
const WORK = 'me@work.example.org';
const said = { subscription: 'preserve', reason: 'test', stage: 'model' } as const;

type Rule = Parameters<typeof nextOf>[0] & object;
const rule = (kind: Rule['kind'], disposition: string | null, labelId: string | null = null): Rule => ({
  id: 'r1',
  match: { from: [] },
  kind,
  labelId,
  labelName: labelId,
  disposition,
  when: null,
});
const kind = (labelId: string | null, messages: number, lastAt: number, does = 'archive'): Kind => ({ labelId, labelName: labelId, messages, lastAt, does });

describe("a sender's next mail", () => {
  it('is what a rule for all their mail does, unless the rule waits for a label', () => {
    expect(nextOf(rule('action', 'archive'), [kind('notification', 1, 1, 'keep')])).toEqual({
      labelId: null,
      labelName: null,
      disposition: 'archive',
      usually: false,
      ruleId: 'r1',
    });
    expect(nextOf(rule('when-label', 'keep', 'security'), [kind('notification', 2, 1), kind('security', 1, 2)])).toMatchObject({
      labelId: 'notification',
      usually: true,
      ruleId: null,
    });
  });

  it('is what most of it is when it is of several kinds, and otherwise what the newest is', () => {
    expect(nextOf(null, [kind(null, 3, 9, 'review'), kind('notification', 2, 1, 'keep'), kind('security', 1, 5)])).toEqual({
      labelId: 'notification',
      labelName: 'notification',
      disposition: 'keep',
      usually: true,
      ruleId: null,
    });
    expect(nextOf(null, [kind(null, 1, 1, 'review'), kind('transactional', 2, 5)])).toMatchObject({ labelId: 'transactional', usually: false });
    expect(nextOf(null, [kind(null, 1, 9, 'review'), kind('transactional', 2, 5)])).toMatchObject({ labelId: null, disposition: 'review' });
    expect(nextOf(null, [])).toEqual({ labelId: null, labelName: null, disposition: 'review', usually: false, ruleId: null });
  });
});

describe('GET /api/contacts', () => {
  async function seeded() {
    const { store, db } = await onePerson(ACCOUNT, WORK);
    const from = (address: string, name?: string) => ({ address, domain: address.split('@')[1]!, ...(name ? { name } : {}) });
    await recordSync(
      db,
      ACCOUNT,
      [
        facts({ messageId: 'news', receivedAt: NOW - 5 * DAY, from: from('news@example.com', 'Example News') }),
        facts({ messageId: 'bill-1', receivedAt: NOW - 4 * DAY, from: from('billing@utility.example.net', 'Utility') }),
        facts({ messageId: 'bill-2', receivedAt: NOW - 3 * DAY, from: from('billing@utility.example.net', 'Utility') }),
        facts({ messageId: 'cold', receivedAt: NOW - 2 * DAY, from: from('cold@example.net') }),
        facts({ messageId: 'ada', receivedAt: NOW - DAY, from: from('ada@example.org', 'Ada Lovelace') }),
        facts({ messageId: 'old', receivedAt: NOW - 60 * DAY, from: from('ada@example.org', 'Ada') }),
        // Mail the person sent is recorded under their own address, and they are not their own contact.
        facts({ messageId: 'mine', receivedAt: NOW, from: from(ACCOUNT, 'Me') }),
      ],
      '1',
      NOW,
    );
    await recordSync(db, WORK, [facts({ accountId: WORK, messageId: 'boss', receivedAt: NOW - 1000, from: from('boss@work.example.org', 'Boss') })], '1', NOW);
    for (const id of ['bill-1', 'bill-2']) await recordDecision(db, ACCOUNT, id, { ...said, disposition: 'review' }, { now: NOW });
    await recordDecision(db, ACCOUNT, 'ada', { ...said, disposition: 'review' }, { now: NOW });
    // The reader answered Utility's mail: that is what their row says, not Sift's Unlabelled.
    for (const messageId of ['bill-1', 'bill-2'])
      await applyFeedback(db, { accountId: ACCOUNT, sender: 'billing@utility.example.net', messageId, label: 'transactional', disposition: 'keep' }, NOW);
    await addRule(db, { match: { from: ['news@example.com'] }, labelId: 'newsletter' }, 'user', NOW);
    await addRule(db, { match: { from: ['cold@example.net'] }, disposition: 'spam' }, 'user', NOW);
    await rememberCorrespondent(db, ACCOUNT, 'ada@example.org', true, NOW);
    const { base } = await startDashboard(people(store), { now: () => NOW });
    const list = async (query = '') => (await (await fetch(`${base}/api/contacts${query}`)).json()) as ContactPage;
    return { base, list };
  }

  it('lists everyone with mail in the mailboxes asked about, newest first, but the person themselves', async () => {
    const { list } = await seeded();
    const all = await list();
    expect(all.total).toBe(5);
    expect(all.rows.map((r) => plain(r.address))).toEqual([
      'boss@work.example.org',
      'ada@example.org',
      'cold@example.net',
      'billing@utility.example.net',
      'news@example.com',
    ]);
    expect(all.rows[1]).toMatchObject({ name: 'Ada Lovelace', contact: 'mutual', given: null, rules: 0, recent: 1, lastSeenAt: NOW - DAY });
    expect(all.rows[1]!.next).toMatchObject({ labelId: null, disposition: 'review' });
    expect(all.rows[2]).toMatchObject({ given: 'blocked', rules: 1, next: { disposition: 'spam', ruleId: expect.any(String) } });
    expect(all.rows[3]).toMatchObject({ contact: null, next: { labelId: 'transactional', disposition: 'keep', usually: false } });
    expect(all.rows[4]).toMatchObject({ given: null, rules: 1, next: { labelId: 'newsletter', ruleId: expect.any(String) } });

    const home = await list(`?mailbox=${encodeURIComponent(ACCOUNT)}`);
    expect(home.rows.map((r) => plain(r.address))).not.toContain('boss@work.example.org');
  });

  it('says what their next mail gets as their own page does', async () => {
    const { base, list } = await seeded();
    const page = (await (await fetch(`${base}/api/sender?address=billing@utility.example.net`)).json()) as SenderPage;
    const row = (await list('?q=utility')).rows[0]!;
    expect(row.next).toEqual(page.next);
    const cold = (await (await fetch(`${base}/api/sender?address=cold@example.net`)).json()) as SenderPage;
    expect(cold.profile.given).toBe('blocked');
  });

  it('searches names and addresses, narrows by standing and by how they know each other, and pages', async () => {
    const { list } = await seeded();
    expect((await list('?q=LOVELACE')).rows.map((r) => plain(r.address))).toEqual(['ada@example.org']);
    expect((await list('?q=example.net')).rows.map((r) => plain(r.address))).toEqual(['cold@example.net', 'billing@utility.example.net']);
    expect((await list('?q=nobody')).total).toBe(0);
    expect((await list('?standing=blocked')).rows.map((r) => plain(r.address))).toEqual(['cold@example.net']);
    expect((await list('?know=mutual')).rows.map((r) => plain(r.address))).toEqual(['ada@example.org']);
    expect((await list('?know=new')).total).toBe(3);
    // An unknown filter is no filter.
    expect((await list('?know=friends')).total).toBe(5);
    const second = await list('?limit=2&offset=2');
    expect(second.total).toBe(5);
    expect(second.rows.map((r) => plain(r.address))).toEqual(['cold@example.net', 'billing@utility.example.net']);
  });
});
