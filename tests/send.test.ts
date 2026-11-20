import { globSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { undo } from '../src/actions/executor.ts';
import { type Outgoing, SETTLE_MS, buildMessage, sendMail } from '../src/actions/send.ts';
import type { Controls } from '../src/dashboard/controls.ts';
import { replyTo } from '../src/dashboard/queries/reply.ts';
import { recordSync, setCanSend, setMailboxAliases } from '../src/store/accounts.ts';
import { getAction } from '../src/store/actions.ts';
import { listUndecided, queuedMessage } from '../src/store/messages.ts';
import { setMail } from '../src/store/preferences.ts';
import { people } from '../src/store/people.ts';
import type { Sql } from '../src/store/sql.ts';
import type { Store } from '../src/store/store.ts';
import { onePerson, openUserDb, raw, startDashboard } from './fixtures.ts';
import { ACCOUNT, FakeMailbox, everything, facts } from './helpers.ts';

const AT = Date.UTC(2026, 10, 19, 8, 30);
const ID = '<a1b2@example.org>';
const mail = (more: Partial<Outgoing> = {}): Outgoing => ({
  from: { address: ACCOUNT, name: 'Me' },
  to: [{ address: 'ada@example.com', name: 'Ada' }],
  cc: [],
  subject: 'Lunch',
  text: 'See you at noon.\nBring the plans.',
  ...more,
});

/** The headers of a built message, unfolded, by name. */
function headersOf(raw: string): Record<string, string> {
  const head = raw.slice(0, raw.indexOf('\r\n\r\n')).replaceAll('\r\n ', ' ');
  return Object.fromEntries(head.split('\r\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
}

/** RFC 2047 encoded words, decoded. */
const decoded = (value: string) => value.replaceAll(/=\?UTF-8\?B\?([^?]*)\?=\s?/g, (_, data: string) => Buffer.from(data, 'base64').toString('utf8')).trim();

describe('building a message', () => {
  it('is plain text in UTF-8, with every line ended by CRLF and the body as base64', () => {
    const raw = buildMessage(mail(), ID, AT);
    expect(raw).not.toMatch(/[^\r]\n/);
    expect(headersOf(raw)).toMatchObject({
      From: '"Me" <me@example.org>',
      To: '"Ada" <ada@example.com>',
      Subject: 'Lunch',
      Date: 'Thu, 19 Nov 2026 08:30:00 +0000',
      'Message-ID': ID,
      'Content-Type': 'text/plain; charset=UTF-8',
      'Content-Transfer-Encoding': 'base64',
    });
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    expect(body.split('\r\n').every((line) => line.length <= 76)).toBe(true);
    expect(Buffer.from(body.replaceAll('\r\n', ''), 'base64').toString('utf8')).toBe('See you at noon.\r\nBring the plans.');
  });

  it('encodes a subject and names outside ASCII, splitting no character, in words short enough for any reader', () => {
    const subject = `Café menu ${'✓'.repeat(40)} 日本語`;
    const raw = buildMessage(mail({ subject, to: [{ address: 'zoe@example.com', name: 'Zoë "Z" Ångström' }] }), ID, AT);
    const headers = headersOf(raw);
    expect(decoded(headers['Subject']!)).toBe(subject);
    expect(decoded(headers['To']!.replace(' <zoe@example.com>', ''))).toBe('Zoë "Z" Ångström');
    for (const word of raw.match(/=\?UTF-8\?B\?[^?]*\?=/g)!) expect(word.length).toBeLessThanOrEqual(75);
    expect(buildMessage(mail({ to: [{ address: 'a@example.com', name: 'O"Brien \\ Co' }] }), ID, AT)).toContain('To: "O\\"Brien \\\\ Co" <a@example.com>');
  });

  it('names the message it answers, and the thread before it', () => {
    const raw = buildMessage(mail({ subject: 'Re: Lunch', inReplyTo: '<x2@example.com>', references: ['<x1@example.com>', '<x2@example.com>'] }), ID, AT);
    expect(headersOf(raw)).toMatchObject({ 'In-Reply-To': '<x2@example.com>', References: '<x1@example.com> <x2@example.com>' });
  });

  it('refuses anything that could add a header or a recipient', () => {
    const refused = [
      mail({ subject: 'Hi\r\nBcc: eve@example.net' }),
      mail({ subject: 'Hi\nBcc: eve@example.net' }),
      mail({ subject: 'Hi\u0000' }),
      mail({ to: [{ address: 'ada@example.com', name: 'Ada\r\nBcc: eve@example.net' }] }),
      mail({ to: [{ address: 'ada@example.com\r\nBcc: eve@example.net' }] }),
      mail({ to: [{ address: 'ada@example.com, eve@example.net' }] }),
      mail({ to: [{ address: 'Ada <ada@example.com>' }] }),
      mail({ to: [{ address: 'ada' }] }),
      mail({ cc: [{ address: '"eve"@example.net' }] }),
      mail({ from: { address: 'me@example.org>\r\nBcc: eve@example.net' } }),
      mail({ inReplyTo: '<x@example.com>\r\nBcc: eve@example.net' }),
      mail({ references: ['<x@example.com> <y@example.com>'] }),
      mail({ to: [], cc: [] }),
    ];
    for (const m of refused) expect(() => buildMessage(m, ID, AT), JSON.stringify(m)).toThrow();
    expect(() => buildMessage(mail(), '<x@example.org>\r\nBcc: eve@example.net', AT)).toThrow();
  });
});

describe('sending', () => {
  let db: Sql;
  let mailbox: FakeMailbox;
  let clock = AT;
  const send = (id = ID, more: Partial<Outgoing> = {}) =>
    sendMail({ db, mailbox, now: () => clock }, { accountId: ACCOUNT, id, threadId: 't1', mail: mail(more) });
  const tries = async () => await raw(db).all('SELECT type, status, message_id FROM actions ORDER BY id');

  beforeEach(async () => {
    db = await openUserDb(ACCOUNT);
    mailbox = new FakeMailbox();
    clock = AT;
  });

  it('is only for someone with Inbox on, from a mailbox Google let send, as one of its own addresses', async () => {
    await expect(send()).rejects.toThrow('Turn Inbox on');
    await setMail(db, true);
    await expect(send()).rejects.toThrow('Google has not let Sift send');
    await setCanSend(db, ACCOUNT, true);
    await expect(send(ID, { from: { address: 'someone@example.com' } })).rejects.toThrow('is not an address of');
    expect(mailbox.sent.size).toBe(0);
    expect(await tries()).toEqual([]);

    await setMailboxAliases(db, ACCOUNT, ['me@work.example.com']);
    expect(await send(ID, { from: { address: 'me@work.example.com' } })).toEqual({ id: 'sent-1', threadId: 't1' });
    expect(mailbox.sent.get('sent-1')).toMatchObject({ threadId: 't1' });
  });

  describe('once allowed', () => {
    beforeEach(async () => {
      await setMail(db, true);
      await setCanSend(db, ACCOUNT, true);
    });

    it('is written to the audit log first, naming who it went to and its subject, and settled from Gmail’s answer', async () => {
      expect((await send()).id).toBe('sent-1');
      expect(await getAction(db, 1)).toMatchObject({
        type: 'send',
        status: 'done',
        finalLabels: ['SENT'],
        payload: { send: { messageId: ID, to: ['ada@example.com'], cc: [], subject: 'Lunch' } },
      });
      const [stored] = await raw(db).all<{ payload: string }>('SELECT payload FROM actions');
      expect(stored!.payload).toMatch(/^sift-plain:/);
    });

    it('does not send twice when the answer to a try that went was lost', async () => {
      mailbox.failSend = 'after';
      await expect(send()).rejects.toThrow('timeout');
      expect(await tries()).toEqual([{ type: 'send', status: 'unknown', message_id: null }]);
      mailbox.failSend = null;
      expect((await send()).id).toBe('sent-1');
      expect(mailbox.sent.size).toBe(1);
      expect(await tries()).toEqual([{ type: 'send', status: 'done', message_id: null }]);
    });

    it('sends again when the try before it never went, once Gmail has had time to show it if it had', async () => {
      mailbox.failSend = 'before';
      await expect(send()).rejects.toThrow('network down');
      mailbox.failSend = null;
      clock = AT + SETTLE_MS - 1;
      await expect(send()).rejects.toThrow('cannot tell yet whether this went');
      expect(mailbox.sent.size).toBe(0);
      clock = AT + SETTLE_MS;
      expect((await send()).id).toBe('sent-1');
      expect(await tries()).toEqual([
        { type: 'send', status: 'failed', message_id: null },
        { type: 'send', status: 'done', message_id: null },
      ]);
      // Another press is mail of its own.
      expect((await send('<a2@example.org>')).id).toBe('sent-2');
    });

    it('does not send again while Gmail’s search has yet to show a try whose answer was lost', async () => {
      mailbox.failSend = 'after';
      await expect(send()).rejects.toThrow('timeout');
      mailbox.failSend = null;
      const finding = mailbox.findByMessageId.bind(mailbox);
      mailbox.findByMessageId = async () => null;
      clock = AT + 5000;
      await expect(send()).rejects.toThrow('cannot tell yet whether this went');
      expect(mailbox.sent.size).toBe(1);
      mailbox.findByMessageId = finding;
      expect((await send()).id).toBe('sent-1');
      expect(mailbox.sent.size).toBe(1);
    });

    it('does not send over a try still waiting on Gmail', async () => {
      const sending = mailbox.send.bind(mailbox);
      let pressedAgain: Promise<unknown> | undefined;
      mailbox.send = async (message) => {
        pressedAgain = send().catch((error: unknown) => error);
        await pressedAgain;
        return await sending(message);
      };
      expect((await send()).id).toBe('sent-1');
      expect(String(await pressedAgain)).toContain('cannot tell yet whether this went');
      expect(mailbox.sent.size).toBe(1);
    });

    it('answers that mail went though the record of it could not be written, so it is not sent again', async () => {
      // The record is written in a transaction of its own, and nothing else sending does is.
      const failing = new Proxy(db, {
        get: (to, key) => (key === 'transaction' ? async () => await Promise.reject(new Error('database gone')) : Reflect.get(to, key)),
      });
      const sent = await sendMail({ db: failing, mailbox, now: () => clock }, { accountId: ACCOUNT, id: ID, threadId: 't1', mail: mail() });
      expect(sent).toEqual({ id: 'sent-1', threadId: 't1' });
      expect(await queuedMessage(db, ACCOUNT, 'sent-1')).toBeNull();
      expect(await tries()).toEqual([{ type: 'send', status: 'done', message_id: null }]);
    });

    it('keeps what went in the record, as theirs and not mail to triage, with the text they wrote', async () => {
      await send(ID, { cc: [{ address: 'bo@example.com' }], inReplyTo: '<x2@example.com>', references: ['<x2@example.com>'] });
      expect(await queuedMessage(db, ACCOUNT, 'sent-1')).toMatchObject({
        facts: {
          threadId: 't1',
          labelIds: ['SENT'],
          from: { address: ACCOUNT, name: 'Me' },
          to: [{ address: 'ada@example.com', name: 'Ada' }],
          cc: [{ address: 'bo@example.com' }],
          subject: 'Lunch',
          receivedAt: AT,
          headers: { 'message-id': ID, 'in-reply-to': '<x2@example.com>' },
        },
      });
      expect(await listUndecided(db, ACCOUNT, 10)).toEqual([]);
      const [body] = await raw(db).all<{ body_text: string }>('SELECT body_text FROM mail_bodies');
      expect(body!.body_text).toBe('sift-plain:See you at noon.\nBring the plans.');
    });

    it('is kept by the try that finds it went, when the answer to the one that sent it was lost', async () => {
      mailbox.failSend = 'after';
      await expect(send()).rejects.toThrow('timeout');
      expect(await queuedMessage(db, ACCOUNT, 'sent-1')).toBeNull();
      mailbox.failSend = null;
      await send();
      expect(await queuedMessage(db, ACCOUNT, 'sent-1')).toMatchObject({ facts: { threadId: 't1' } });
    });

    it('is not kept once Inbox is off', async () => {
      const sending = mailbox.send.bind(mailbox);
      mailbox.send = async (message) => {
        await setMail(db, false);
        return await sending(message);
      };
      await send();
      expect(await queuedMessage(db, ACCOUNT, 'sent-1')).toBeNull();
    });

    it('cannot be undone', async () => {
      await send();
      await expect(undo({ db, mailbox }, 1)).rejects.toThrow('cannot be taken back');
    });
  });
});

describe('from the dashboard', () => {
  let db: Sql;
  let store: Store;
  let mailbox: FakeMailbox;
  const NEW = { accountId: ACCOUNT, id: ID, from: { address: ACCOUNT }, to: [{ address: 'ada@example.com' }], cc: [], text: 'Hello' };

  beforeEach(async () => {
    ({ store, db } = await onePerson(ACCOUNT));
    mailbox = new FakeMailbox();
  });

  const start = async () => {
    const controls = { send: async (target: Sql, sending: Parameters<Controls['send']>[1]) => await sendMail({ db: target, mailbox, now: () => AT }, sending) };
    return (await startDashboard(people(store), { controls: controls as unknown as Controls })).call;
  };
  const sentHeaders = () => headersOf([...mailbox.sent.values()][0]!.raw);

  it('says why it may not send, in words for the person', async () => {
    const call = await start();
    expect(await call('POST', '/api/mail/send', { ...NEW, subject: 'Hi' })).toMatchObject({
      status: 409,
      body: { error: 'Turn Inbox on to send mail from Sift.' },
    });
    await setMail(db, true);
    expect((await call('POST', '/api/mail/send', { ...NEW, subject: 'Hi' })).body).toEqual({ error: `Google has not let Sift send from ${ACCOUNT}.` });
    await setCanSend(db, ACCOUNT, true);
    expect((await call('POST', '/api/mail/send', { ...NEW, subject: 'Hi', to: [{ address: 'Ada <ada@example.com>' }] })).body).toEqual({
      error: '"Ada <ada@example.com>" is not an address Sift can send to.',
    });
    expect((await call('POST', '/api/mail/send', { ...NEW, subject: 'Hi', to: [] })).body).toEqual({ error: 'Say who the mail is to.' });
    expect(mailbox.sent.size).toBe(0);
    expect(await call('POST', '/api/mail/send', { ...NEW, subject: 'Hi' })).toMatchObject({ status: 200, body: { id: 'sent-1', threadId: 'sent-1' } });
    expect(sentHeaders()).toMatchObject({ Subject: 'Hi', To: 'ada@example.com' });
  });

  describe('a reply', () => {
    beforeEach(async () => {
      await setMail(db, true);
      await setCanSend(db, ACCOUNT, true);
      await recordSync(
        db,
        ACCOUNT,
        [
          facts({
            messageId: 'm1',
            threadId: 't9',
            from: { address: 'ada@example.com', domain: 'example.com' },
            subject: 'Lunch',
            headers: { 'message-id': '<m1@example.com>', references: '<m0@example.com> not-an-id <bad id@example.com>' },
          }),
        ],
        '2',
      );
    });

    it('goes into the conversation, following the message it answers as the record has it, not as the page says', async () => {
      const call = await start();
      expect((await call('POST', '/api/mail/send', { ...NEW, replyTo: { messageId: 'm1' } })).body).toEqual({ id: 'sent-1', threadId: 't9' });
      expect([...mailbox.sent.values()][0]!.threadId).toBe('t9');
      expect(sentHeaders()).toMatchObject({ Subject: 'Re: Lunch', 'In-Reply-To': '<m1@example.com>', References: '<m0@example.com> <m1@example.com>' });
      expect(await queuedMessage(db, ACCOUNT, 'sent-1')).toMatchObject({ facts: { threadId: 't9', subject: 'Re: Lunch' } });
      // The page names the conversation by the message alone.
      expect((await call('POST', '/api/mail/send', { ...NEW, replyTo: { messageId: 'm1' }, subject: 'Other' })).status).toBe(400);
    });

    it('keeps a subject that already says it answers, and names the first message and the newest before it in a long conversation', async () => {
      const chain = Array.from({ length: 30 }, (_, i) => `<r${i}@example.com>`);
      await recordSync(
        db,
        ACCOUNT,
        [facts({ messageId: 'm2', threadId: 't9', subject: 'RE: Lunch', headers: { 'message-id': '<m2@example.com>', references: chain.join(' ') } })],
        '3',
      );
      expect(await replyTo(db, await everything(db), ACCOUNT, 'm2')).toEqual({
        threadId: 't9',
        subject: 'RE: Lunch',
        inReplyTo: '<m2@example.com>',
        references: ['<r0@example.com>', ...chain.slice(-18), '<m2@example.com>'],
      });
    });

    it("is refused for a message the mailbox has no record of, or one in another of the person's mailboxes", async () => {
      const call = await start();
      expect((await call('POST', '/api/mail/send', { ...NEW, replyTo: { messageId: 'nope' } })).status).toBe(400);
      expect(await replyTo(db, await everything(db), 'other@example.org', 'm1')).toBeNull();
      expect(mailbox.sent.size).toBe(0);
    });
  });
});

it('is sent only from the dashboard, through src/actions/send.ts, which the Gmail mailbox carries out', () => {
  const callers = globSync('src/**/*.ts').filter((file) => /\.send\(/.test(readFileSync(file, 'utf8')));
  expect(callers.toSorted()).toEqual(['src/actions/send.ts', 'src/dashboard/api/routes/mail/send/post.ts', 'src/gmail/mailbox.ts']);
});
