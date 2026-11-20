import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_BODY_CHARS } from '../src/gmail/body.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { recordSync } from '../src/store/accounts.ts';
import { openPart } from '../src/store/content.ts';
import { setMail } from '../src/store/preferences.ts';
import type { Sql } from '../src/store/sql.ts';
import { type RunOptions, runOnce } from '../src/work/run.ts';
import { syncAccount } from '../src/work/sync.ts';
import { connectGmail, fakeGoogle, firstAccount, openUserDb, raw } from './fixtures.ts';
import { ACCOUNT, DAY, testModel } from './helpers.ts';

const NOW = Date.UTC(2026, 10, 19, 12);
const fake = fakeGoogle();

let db: Sql;
let gmail: ReturnType<typeof connectGmail>;

const textOf = (id: string) => `${id} `.repeat(MAX_BODY_CHARS);
/** Every whole read of a message, by id. */
const read = () => gmail.gmail.asked('users.messages.get').flatMap((r) => (r.format === 'full' && r.id ? [r.id] : []));

const labelsOf = async (id: string) => (await raw(db).get<{ label_ids: string[] }>('SELECT label_ids FROM messages WHERE id = ?', id))?.label_ids;
const sync = async () => await syncAccount(db, gmail.api, await firstAccount(db), () => NOW);

beforeEach(async () => {
  db = await openUserDb(ACCOUNT);
  gmail = connectGmail(fake.google);
  await recordSync(db, ACCOUNT, [], gmail.gmail.cursor(), NOW - DAY);
  gmail.gmail.deliver({ id: 'a', from: 'News <news@example.com>', to: ACCOUNT, text: textOf('a'), at: NOW - DAY });
  gmail.gmail.deliver({ id: 'b', from: 'News <news@example.com>', to: ACCOUNT, text: textOf('b'), at: NOW - 400 * DAY });
});

describe('a recorded message’s labels', () => {
  it('follow Gmail’s history, so what is in the inbox and what is unread can be read from the record', async () => {
    await sync();
    expect(await labelsOf('a')).toEqual(['INBOX', 'UNREAD']);
    gmail.gmail.deliver({ id: 'unrecorded', from: 'ada@example.com', labelIds: [], at: NOW - 400 * DAY }, { quietly: true });
    gmail.gmail.change('a', { remove: ['UNREAD'] });
    gmail.gmail.change('b', { remove: ['INBOX'] });
    gmail.gmail.change('b', { add: ['STARRED'] });
    gmail.gmail.change('unrecorded', { add: ['INBOX'] });
    await sync();
    expect(await labelsOf('a')).toEqual(['INBOX']);
    expect((await labelsOf('b'))?.toSorted()).toEqual(['STARRED', 'UNREAD']);
  });

  it('end where the last change to each label left them, however often the same history is read', async () => {
    await sync();
    const { historyId } = await firstAccount(db);
    gmail.gmail.change('a', { remove: ['INBOX'] });
    gmail.gmail.change('a', { add: ['INBOX'] });
    gmail.gmail.change('a', { remove: ['UNREAD'] });
    await sync();
    await recordSync(db, ACCOUNT, [], historyId!, NOW);
    await sync();
    expect(await labelsOf('a')).toEqual(['INBOX']);
  });
});

describe('the text Inbox keeps', () => {
  const options = (more: Partial<RunOptions> = {}): RunOptions => ({
    ephemeral: memoryEphemeral(),
    connect: () => gmail,
    log: () => {},
    now: () => NOW,
    ...more,
  });
  const kept = async () =>
    (await raw(db).all<{ message_id: string; body_text: string }>('SELECT message_id, body_text FROM mail_bodies ORDER BY message_id')).map((r) => ({
      id: r.message_id,
      text: openPart(db, ACCOUNT, r.message_id, 'text', r.body_text),
    }));

  it('is all of the text of mail in the inbox, read only while Inbox is on, and goes when it is turned off', async () => {
    await runOnce(db, options());
    expect(read()).toEqual([]);
    await setMail(db, true, { now: NOW, window: 'year' });
    gmail.gmail.change('b', { remove: ['INBOX'] });
    await runOnce(db, options());
    expect(read()).toEqual(['a']);
    expect(await kept()).toEqual([{ id: 'a', text: textOf('a').trim() }]);
    await runOnce(db, options());
    expect(read()).toEqual(['a']);
    await setMail(db, false);
    expect(await kept()).toEqual([]);
  });

  it('reads new mail once, whole, for the model and for Inbox alike', async () => {
    await setMail(db, true, { now: NOW, window: 'year' });
    await runOnce(db, options({ model: async () => testModel() }));
    expect(read().toSorted()).toEqual(['a', 'b']);
    expect((await kept()).map((k) => k.id)).toEqual(['a', 'b']);
  });
});
