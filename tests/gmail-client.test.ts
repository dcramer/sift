import { describe, expect, it } from 'vitest';
import { HistoryExpiredError, createGmailApi } from '../src/gmail/api.ts';
import { clientFor, completeBrowserSignIn, revokeGrant } from '../src/gmail/auth.ts';
import { copyQuery } from '../src/work/copy.ts';
import { inboxQuery } from '../src/work/apply.ts';
import { connectGmail, fakeGoogle } from './fixtures.ts';
import { SECRETS } from './google.ts';

const ME = 'me@example.org';
const DAY = 86_400_000;
const AT = Date.UTC(2026, 10, 1, 12);

const fake = fakeGoogle();

const gmail = (address = ME, how: { send?: boolean } = {}) => connectGmail(fake.google, address, how);

describe('reading', () => {
  it('names the mailbox lowercased, with where its history is now', async () => {
    const { api } = gmail('Me@Example.org');
    expect(await api.getProfile()).toEqual({ emailAddress: ME, historyId: '1000' });
  });

  it('reads the headers triage asks for, decoded, and nothing more, without the text', async () => {
    const { api, gmail: box } = gmail();
    const id = box.deliver({
      from: 'Ada <ada@example.com>',
      subject: '=?UTF-8?B?Q2Fmw6kgb24gVGh1cnNkYXk=?=',
      at: AT,
      headers: { 'List-Id': '<news.example.com>', 'X-Not-Asked': 'secret' },
    });
    const raw = await api.getMetadata(id);
    expect(raw).toMatchObject({ id, threadId: id, labelIds: ['INBOX', 'UNREAD'], internalDate: AT });
    const names = raw!.headers.map((h) => h.name);
    expect(names).toContain('List-Id');
    expect(names).not.toContain('X-Not-Asked');
    expect(raw!.headers.find((h) => h.name === 'Subject')?.value).toBe('Café on Thursday');
    expect(box.asked('users.messages.get', id)).toEqual([{ method: 'users.messages.get', id, format: 'metadata' }]);
  });

  it('reads a whole message once for its headers and its text, its HTML beside it and its attachments noticed', async () => {
    const { api, gmail: box } = gmail();
    const id = box.deliver({
      from: 'shop@example.com',
      text: 'Your order shipped.',
      html: '<p>Your order <b>shipped</b>.</p>',
      attachments: [{ filename: 'invoice.pdf', mimeType: 'application/pdf', data: '%PDF' }],
    });
    const whole = await api.getMessage(id);
    expect(whole!.content.text).toBe('Your order shipped.');
    expect(whole!.content.html).toContain('<b>shipped</b>');
    expect(whole!.content.facts.hasAttachments).toBe(true);
    expect(box.asked('users.messages.get', id)).toHaveLength(1);
  });

  it('answers null for a message or thread that is gone, and the labels a message has now', async () => {
    const { api, gmail: box } = gmail();
    const id = box.deliver({ from: 'ada@example.com' });
    box.change(id, { remove: ['UNREAD'] });
    expect(await api.getLabelIds(id)).toEqual(['INBOX']);
    box.delete(id);
    expect(await api.getMetadata(id)).toBeNull();
    expect(await api.getMessage(id)).toBeNull();
    expect(await api.getContent(id)).toBeNull();
    expect(await api.getLabelIds(id)).toBeNull();
    expect(await api.getThread(id)).toBeNull();
  });

  it('gives a thread oldest first, with only its labels', async () => {
    const { api, gmail: box } = gmail();
    const first = box.deliver({ from: 'ada@example.com', at: AT });
    const reply = box.deliver({ from: 'bo@example.com', threadId: first, at: AT + DAY, labelIds: ['INBOX'] });
    expect(await api.getThread(first)).toEqual([
      { id: first, labelIds: ['INBOX', 'UNREAD'] },
      { id: reply, labelIds: ['INBOX'] },
    ]);
  });

  it('counts the inbox and the mailbox, lists labels, and the send-as addresses confirmed', async () => {
    const { api, gmail: box } = gmail();
    box.deliver({ from: 'ada@example.com' });
    box.deliver({ from: 'bo@example.com', labelIds: [] });
    box.label('Receipts');
    box.sendAs = [{ email: 'Me@Work.example.com' }, { email: 'later@example.net', pending: true }];
    expect(await api.inboxSize()).toBe(1);
    expect(await api.mailboxSize()).toBe(2);
    expect(await api.listLabels()).toContainEqual({ id: 'Label_15', name: 'Receipts' });
    expect(await api.listSendAs()).toEqual([ME, 'me@work.example.com']);
  });
});

describe('history', () => {
  it('says what arrived, what changed and what went since the cursor, a page at a time', async () => {
    const { api, gmail: box } = gmail();
    const { historyId: cursor } = await api.getProfile();
    const id = box.deliver({ from: 'ada@example.com' });
    box.change(id, { add: ['STARRED'], remove: ['UNREAD'] });
    const gone = box.deliver({ from: 'bo@example.com' });
    box.delete(gone);
    const page = await api.listHistory(cursor);
    expect(page.additions).toEqual([
      { id, labelIds: ['INBOX', 'UNREAD'] },
      { id: gone, labelIds: ['INBOX', 'UNREAD'] },
    ]);
    expect(page.labelChanges).toEqual([
      { messageId: id, added: ['STARRED'], removed: [] },
      { messageId: id, added: [], removed: ['UNREAD'] },
    ]);
    expect(page.deleted).toEqual([gone]);
    expect(page.nextPageToken).toBeUndefined();
    expect((await api.listHistory(page.historyId)).additions).toEqual([]);
  });

  it('leaves out mail that came before, found only by a search', async () => {
    const { api, gmail: box } = gmail();
    const { historyId } = await api.getProfile();
    const id = box.deliver({ from: 'ada@example.com' }, { quietly: true });
    expect((await api.listHistory(historyId)).additions).toEqual([]);
    expect((await api.searchInbox('')).ids).toEqual([id]);
  });

  it('throws HistoryExpiredError for a cursor Gmail no longer keeps history back to', async () => {
    const { api, gmail: box } = gmail();
    const { historyId } = await api.getProfile();
    box.deliver({ from: 'ada@example.com' });
    box.expireHistory();
    await expect(api.listHistory(historyId)).rejects.toBeInstanceOf(HistoryExpiredError);
  });
});

describe('searching', () => {
  it('lists the inbox newest first, a page at a time, without Spam or Trash', async () => {
    const { api, gmail: box } = gmail();
    const ids = Array.from({ length: 3 }, (_, i) => box.deliver({ from: 'ada@example.com', at: AT + i * DAY }));
    box.deliver({ from: 'spam@example.com', labelIds: ['SPAM'] });
    box.deliver({ from: 'archived@example.com', labelIds: [] });
    const first = await api.searchMail('in:inbox', 2);
    expect(first).toMatchObject({ ids: [ids[2], ids[1]], estimate: 3 });
    expect(await api.searchMail('in:inbox', 2, first.nextPageToken)).toEqual({ ids: [ids[0]], estimate: 3 });
  });

  it('finds what a rule could match by its sender, its recipient or its list', async () => {
    const { api, gmail: box } = gmail();
    const shop = box.deliver({ from: 'Shop <orders@shop.example.com>' });
    const list = box.deliver({ from: 'news@example.net', headers: { 'List-Id': 'Weekly <weekly.example.net>' } });
    box.deliver({ from: 'ada@example.com' });
    expect((await api.searchInbox(inboxQuery({ fromDomain: ['shop.example.com'] }))).ids).toEqual([shop]);
    expect((await api.searchInbox(inboxQuery({ from: ['orders@shop.example.com', 'news@example.net'] }))).ids).toEqual([list, shop]);
    expect((await api.searchInbox(inboxQuery({ listId: ['weekly.example.net'] }))).ids).toEqual([list]);
  });

  it('finds, for Inbox’s copy, mail in its window and whatever is in the inbox, before Inbox was turned on', async () => {
    const { api, gmail: box } = gmail();
    const now = AT + 400 * DAY;
    const old = box.deliver({ from: 'ada@example.com', at: AT, labelIds: [] });
    const oldInInbox = box.deliver({ from: 'ada@example.com', at: AT + DAY });
    const recent = box.deliver({ from: 'ada@example.com', at: now - 10 * DAY, labelIds: ['SENT'] });
    box.deliver({ from: 'ada@example.com', at: now + DAY });
    box.deliver({ from: 'draft@example.com', at: now - DAY, labelIds: ['DRAFT'] });
    expect((await api.searchMail(copyQuery({ since: now - 365 * DAY, before: now }), 10)).ids).toEqual([recent, oldInInbox]);
    expect((await api.searchMail(copyQuery({ since: null, before: now }), 10)).ids).toEqual([recent, oldInInbox, old]);
  });
});

describe('changing the mailbox', () => {
  it('changes a message’s labels and answers with them, as history then says', async () => {
    const { api, mailbox, gmail: box } = gmail();
    const { historyId } = await api.getProfile();
    const id = box.deliver({ from: 'ada@example.com' }, { quietly: true });
    expect(await mailbox.modifyLabels(id, { add: [], remove: ['INBOX', 'UNREAD'] })).toEqual([]);
    expect(box.message(id)!.labelIds).toEqual([]);
    expect((await api.listHistory(historyId)).labelChanges).toEqual([{ messageId: id, added: [], removed: ['INBOX', 'UNREAD'] }]);
  });

  it('refuses a label Gmail does not have', async () => {
    const { mailbox, gmail: box } = gmail();
    const id = box.deliver({ from: 'ada@example.com' });
    await expect(mailbox.modifyLabels(id, { add: ['Label_404'], remove: [] })).rejects.toMatchObject({ status: 400 });
    expect(box.message(id)!.labelIds).toEqual(['INBOX', 'UNREAD']);
  });

  it('makes a label once, and finds one made meanwhile by another hand', async () => {
    const { mailbox, gmail: box } = gmail();
    const id = await mailbox.ensureLabel('sift/news');
    expect(await mailbox.ensureLabel('Sift/News')).toBe(id);
    expect(box.asked('users.labels.create')).toHaveLength(1);

    const other = gmail();
    await other.mailbox.ensureLabel('sift/other');
    const raced = box.label('sift/receipts');
    expect(await other.mailbox.ensureLabel('sift/receipts')).toBe(raced);
  });

  it('says whether the owner has written to an address, and refuses one that would change the search', async () => {
    const { mailbox, gmail: box } = gmail();
    box.deliver({ from: ME, to: 'Ada <ada@example.com>', labelIds: ['SENT'] });
    expect(await mailbox.hasSentTo('ada@example.com')).toBe(true);
    expect(await mailbox.hasSentTo('bo@example.com')).toBe(false);
    await expect(mailbox.hasSentTo('a@example.com OR b')).rejects.toThrow('cannot be searched safely');
  });

  it('makes, lists and removes filters, and removing one already gone is done', async () => {
    const { mailbox, gmail: box } = gmail();
    const label = await mailbox.ensureLabel('sift/news');
    const id = await mailbox.createFilter({ criteria: { from: 'news@example.com' }, action: { addLabelIds: [label], removeLabelIds: ['INBOX'] } });
    expect(await mailbox.listFilters()).toEqual([{ id, criteria: { from: 'news@example.com' }, action: { addLabelIds: [label], removeLabelIds: ['INBOX'] } }]);
    await mailbox.deleteFilter(id);
    await mailbox.deleteFilter(id);
    expect(box.filters).toEqual([]);
    await expect(mailbox.createFilter({ criteria: {}, action: { removeLabelIds: ['INBOX'] } })).rejects.toThrow('Refusing to create filter');
    expect(box.asked('users.settings.filters.create')).toHaveLength(1);
  });

  it('puts in a message Sift wrote, and finds it again by its Message-ID', async () => {
    const { mailbox, gmail: box } = gmail();
    const raw = [
      'From: Sift <me@example.org>',
      'To: me@example.org',
      'Subject: Your digest',
      'Message-ID: <digest-1@sift.example.org>',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'Three things.',
    ].join('\r\n');
    const put = await mailbox.insertMessage(raw, ['INBOX', 'UNREAD']);
    expect(box.message(put.id)).toMatchObject({ labelIds: ['INBOX', 'UNREAD'] });
    expect(await mailbox.findByMessageId('<digest-1@sift.example.org>')).toEqual({ id: put.id, threadId: put.id });
    expect(await mailbox.findByMessageId('<other@sift.example.org>')).toBeNull();
  });

  it('sends into the conversation it answers, and a search finds it only once Gmail has indexed it', async () => {
    const { mailbox, gmail: box } = gmail(ME, { send: true });
    const asked = box.deliver({ from: 'ada@example.com', subject: 'Lunch' });
    box.lagSearch = true;
    const raw = ['From: me@example.org', 'To: ada@example.com', 'Subject: Re: Lunch', 'Message-ID: <reply-1@example.org>', '', 'Yes.'].join('\r\n');
    const sent = await mailbox.send({ raw, threadId: asked });
    expect(sent).toMatchObject({ threadId: asked, labelIds: ['SENT'] });
    expect(box.sent().map((m) => m.header('Subject'))).toEqual(['Re: Lunch']);
    expect(await mailbox.findByMessageId('<reply-1@example.org>')).toBeNull();
    box.index();
    expect(await mailbox.findByMessageId('<reply-1@example.org>')).toEqual({ id: sent.id, threadId: asked });
  });
});

describe('when Gmail fails', () => {
  it('throws Gmail’s refusal, and a lost answer, though the change was made', async () => {
    const { mailbox, gmail: box } = gmail();
    const id = box.deliver({ from: 'ada@example.com' });
    box.fail('users.messages.modify', { status: 500 }, 'lost');
    await expect(mailbox.modifyLabels(id, { add: [], remove: ['UNREAD'] })).rejects.toMatchObject({ status: 500 });
    expect(box.message(id)!.labelIds).toEqual(['INBOX', 'UNREAD']);
    await expect(mailbox.modifyLabels(id, { add: [], remove: ['UNREAD'] })).rejects.toThrow();
    expect(box.message(id)!.labelIds).toEqual(['INBOX']);
  });

  it('cannot read a mailbox whose sign-in Google ended', async () => {
    const token = fake.google.grant(ME);
    fake.google.expire(token);
    const api = createGmailApi(clientFor(SECRETS, token), async () => {});
    await expect(api.getProfile()).rejects.toThrow(/invalid_grant/);
  });

  it('refuses a search the fake could read differently from Gmail', async () => {
    const { api } = gmail();
    await expect(api.searchMail('larger:5M', 1)).rejects.toMatchObject({ status: 400 });
  });
});

describe('signing in', () => {
  it('trades the consent screen’s code for the mailbox, its sign-in and whether it may send', async () => {
    const code = fake.google.consent('Ada@Example.com', { send: true });
    const signedIn = await completeBrowserSignIn(SECRETS, { redirectUri: 'http://localhost:3000/auth/callback', code, verifier: 'v' });
    expect(signedIn).toMatchObject({ email: 'ada@example.com', historyId: '1000', canSend: true });
    expect(fake.google.honours(signedIn.refreshToken)).toBe(true);
    await expect(completeBrowserSignIn(SECRETS, { redirectUri: 'http://localhost:3000/auth/callback', code, verifier: 'v' })).rejects.toThrow();
    expect((await completeBrowserSignIn(SECRETS, { redirectUri: 'x', code: fake.google.consent(ME), verifier: 'v' })).canSend).toBe(false);
  });

  it('revokes a sign-in, and counts one Google no longer honours as revoked', async () => {
    const token = fake.google.grant(ME);
    expect(await revokeGrant(token)).toBe(true);
    expect(fake.google.honours(token)).toBe(false);
    expect(await revokeGrant(token)).toBe(true);
  });
});
