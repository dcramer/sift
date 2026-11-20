import { beforeEach, describe, expect, it } from 'vitest';
import type { GmailApi, HistoryLabelChange, RawMessage } from '../src/gmail/api.ts';
import { MAX_BODY_CHARS, readContent } from '../src/gmail/body.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { openPart } from '../src/store/content.ts';
import { setMail } from '../src/store/preferences.ts';
import type { Sql } from '../src/store/sql.ts';
import { type RunOptions, runOnce } from '../src/work/run.ts';
import { syncAccount } from '../src/work/sync.ts';
import { firstAccount, openUserDb, raw } from './fixtures.ts';
import { ACCOUNT, FakeMailbox, b64, rawMessage, testModel } from './helpers.ts';

let db: Sql;
let inbox: RawMessage[];
let history: HistoryLabelChange[];
let cursor: number;
/** Every full read of a message, by id. */
let read: string[];

/** A Gmail whose history hands over `inbox` as new mail and `history` as label changes, once each. */
const gmail = (): GmailApi => ({
  getProfile: async () => ({ emailAddress: ACCOUNT, historyId: String(cursor) }),
  listHistory: async () => ({
    additions: inbox.splice(0).map((m) => ({ id: m.id, labelIds: m.labelIds })),
    labelChanges: history.splice(0),
    historyId: String(++cursor),
  }),
  searchInbox: async () => ({ ids: [] }),
  inboxSize: async () => 0,
  searchMail: async () => ({ ids: [] }),
  mailboxSize: async () => 0,
  getMessage: async (id) => {
    read.push(id);
    const raw = known.find((m) => m.id === id);
    return raw ? { raw, content: readContent({ mimeType: 'text/plain', body: { data: b64(textOf(id)) } }) } : null;
  },
  getMetadata: async (id) => known.find((m) => m.id === id) ?? null,
  getLabelIds: async () => null,
  listLabels: async () => [],
  getThread: async () => null,
  listSendAs: async () => [ACCOUNT],
  getContent: async (id) => (read.push(id), readContent({ mimeType: 'text/plain', body: { data: b64(textOf(id)) } })),
});
let known: RawMessage[];
const textOf = (id: string) => `${id} `.repeat(MAX_BODY_CHARS);

const labelsOf = async (id: string) => (await raw(db).get<{ label_ids: string[] }>('SELECT label_ids FROM messages WHERE id = ?', id))?.label_ids;
const sync = async () => await syncAccount(db, gmail(), await firstAccount(db), () => 5000);

beforeEach(async () => {
  db = await openUserDb(ACCOUNT);
  cursor = 1;
  known = [rawMessage('a'), rawMessage('b')];
  inbox = [...known];
  history = [];
  read = [];
});

describe('a recorded message’s labels', () => {
  it('follow Gmail’s history, so what is in the inbox and what is unread can be read from the record', async () => {
    await sync();
    expect(await labelsOf('a')).toEqual(['INBOX', 'UNREAD']);
    history = [
      { messageId: 'a', added: [], removed: ['UNREAD'] },
      { messageId: 'b', added: [], removed: ['INBOX'] },
      { messageId: 'b', added: ['STARRED'], removed: [] },
      { messageId: 'unrecorded', added: ['INBOX'], removed: [] },
    ];
    await sync();
    expect(await labelsOf('a')).toEqual(['INBOX']);
    expect((await labelsOf('b'))?.toSorted()).toEqual(['STARRED', 'UNREAD']);
  });

  it('end where the last change to each label left them, however often the same history is read', async () => {
    await sync();
    const changes = [
      { messageId: 'a', added: [], removed: ['INBOX'] },
      { messageId: 'a', added: ['INBOX'], removed: [] },
      { messageId: 'a', added: [], removed: ['UNREAD'] },
    ];
    history = [...changes];
    await sync();
    history = [...changes];
    await sync();
    expect(await labelsOf('a')).toEqual(['INBOX']);
  });
});

describe('the text Inbox keeps', () => {
  const options = (more: Partial<RunOptions> = {}): RunOptions => ({
    ephemeral: memoryEphemeral(),
    connect: () => ({ api: gmail(), mailbox: new FakeMailbox() }),
    log: () => {},
    now: () => 5000,
    ...more,
  });
  const kept = async () =>
    (await raw(db).all<{ message_id: string; body_text: string }>('SELECT message_id, body_text FROM mail_bodies ORDER BY message_id')).map((r) => ({
      id: r.message_id,
      text: openPart(db, ACCOUNT, r.message_id, 'text', r.body_text),
    }));

  it('is all of the text of mail in the inbox, read only while Inbox is on, and goes when it is turned off', async () => {
    await runOnce(db, options());
    expect(read).toEqual([]);
    await setMail(db, true);
    history = [{ messageId: 'b', added: [], removed: ['INBOX'] }];
    await runOnce(db, options());
    expect(read).toEqual(['a']);
    expect(await kept()).toEqual([{ id: 'a', text: textOf('a').trim() }]);
    await runOnce(db, options());
    expect(read).toEqual(['a']);
    await setMail(db, false);
    expect(await kept()).toEqual([]);
  });

  it('reads new mail once, whole, for the model and for Inbox alike', async () => {
    await setMail(db, true);
    await runOnce(db, options({ model: async () => testModel() }));
    expect(read.toSorted()).toEqual(['a', 'b']);
    expect((await kept()).map((k) => k.id)).toEqual(['a', 'b']);
  });
});
