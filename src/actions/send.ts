import { canSend, mailboxAliases } from '../store/accounts.ts';
import { finishAction, insertPendingAction, openTries } from '../store/actions.ts';
import { preferences } from '../store/preferences.ts';
import { recordSent } from '../store/sent.ts';
import type { Sql } from '../store/sql.ts';
import { Refusal } from '../refusal.ts';
import { reportError } from '../telemetry.ts';
import type { Mailbox } from './mailbox.ts';

interface Party {
  address: string;
  name?: string;
}

/** What the person wrote: plain text. `inReplyTo` and `references` are Message-IDs, for a reply. */
export interface Outgoing {
  from: Party;
  to: Party[];
  cc: Party[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

/** Plain ASCII, as a dot-atom local part and a domain of labels: nothing a header could be broken out of. */
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const MESSAGE_ID = /^<[\x21-\x3b\x3d\x3f-\x7e]+@[\x21-\x3b\x3d\x3f-\x7e]+>$/;
const PRINTABLE = /^[\x20-\x7e]*$/;
/** A header line may be 998 characters; a longer subject goes as encoded words, a line each. */
const LONGEST = 900;
/** Base64 of 45 bytes is 60 characters: with `=?UTF-8?B?` and `?=` an encoded word stays under RFC 2047's 75. */
const WORD_BYTES = 45;

/** CR and LF end a header; any other control character has no business in one either. */
function headerText(value: string, what: string): string {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) throw new Refusal(`The ${what} cannot hold a line break or a control character.`);
  }
  return value;
}

function address(value: string): string {
  if (!ADDRESS.test(value)) throw new Refusal(`${JSON.stringify(value)} is not an address Sift can send to.`);
  return value;
}

function messageId(value: string): string {
  if (!MESSAGE_ID.test(value)) throw new Refusal('A reply names the message it answers by a Message-ID that is not one.');
  return value;
}

/** RFC 2047 encoded words, split on whole characters, folded one to a line. */
function encoded(value: string): string {
  const words: string[] = [];
  let word = '';
  for (const char of value) {
    if (Buffer.byteLength(word + char) > WORD_BYTES) {
      words.push(word);
      word = '';
    }
    word += char;
  }
  words.push(word);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join('\r\n ');
}

const phrase = (value: string) => (PRINTABLE.test(value) ? `"${value.replaceAll(/["\\]/g, '\\$&')}"` : encoded(value));

const party = ({ name, address: value }: Party) => (name ? `${phrase(headerText(name, 'name'))} <${address(value)}>` : address(value));

/** RFC 5322's date, in UTC. */
const dated = (at: number) => new Date(at).toUTCString().replace('GMT', '+0000');

/**
 * The message as RFC 2822 text: plain text in UTF-8, every address checked and every header value refused if it could break
 * a line, names and a subject outside ASCII encoded (RFC 2047). `id` is its Message-ID, made by the page once for the press of Send.
 */
export function buildMessage(mail: Outgoing, id: string, at: number): string {
  if (mail.to.length + mail.cc.length === 0) throw new Refusal('Say who the mail is to.');
  const subject = headerText(mail.subject, 'subject');
  const headers = [
    `From: ${party(mail.from)}`,
    ...(mail.to.length > 0 ? [`To: ${mail.to.map(party).join(',\r\n ')}`] : []),
    ...(mail.cc.length > 0 ? [`Cc: ${mail.cc.map(party).join(',\r\n ')}`] : []),
    `Subject: ${PRINTABLE.test(subject) && subject.length <= LONGEST ? subject : encoded(subject)}`,
    `Date: ${dated(at)}`,
    `Message-ID: ${messageId(id)}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${messageId(mail.inReplyTo)}`] : []),
    ...(mail.references?.length ? [`References: ${mail.references.map(messageId).join('\r\n ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(mail.text.replaceAll(/\r\n?/g, '\n').replaceAll('\n', '\r\n')).toString('base64');
  return `${headers.join('\r\n')}\r\n\r\n${body.replaceAll(/.{1,76}/g, '$&\r\n')}`;
}

/**
 * How long a try whose answer never came is left before Gmail's search is trusted to say it did not go: the search can lag
 * a send by seconds, and a request still running has not answered yet. Sending again sooner could send it twice.
 */
export const SETTLE_MS = 2 * 60_000;

/** A party as the record keeps it, for `envelopeOf` to read back: the name quoted, without the quotes and backslashes it cannot hold. */
const recorded = ({ name, address: value }: Party) => (name ? `"${name.replaceAll(/["\\]/g, '')}" <${value}>` : value);

/** The headers the record keeps of mail sent, as `messages.headers` keeps a synced message's: names lowercased. */
function sentHeaders(mail: Outgoing, id: string, at: number): Record<string, string> {
  return {
    from: recorded(mail.from),
    ...(mail.to.length > 0 ? { to: mail.to.map(recorded).join(', ') } : {}),
    ...(mail.cc.length > 0 ? { cc: mail.cc.map(recorded).join(', ') } : {}),
    subject: mail.subject,
    date: dated(at),
    'message-id': id,
    ...(mail.inReplyTo ? { 'in-reply-to': mail.inReplyTo } : {}),
    ...(mail.references?.length ? { references: mail.references.join(' ') } : {}),
  };
}

type SendDeps = { db: Sql; mailbox: Mailbox; now?: () => number };

/**
 * Send what the person wrote, as them, and return Gmail's id for it and its conversation. Only for someone with Inbox on,
 * from a mailbox Google let Sift send from, as one of that mailbox's own addresses. Written to the audit log before the call
 * and settled from Gmail's answer. A try before this one whose answer never came is looked for by `id`, its Message-ID, so
 * mail that went is not sent twice. What went is kept in the record (`recordSent`), by whichever try finds it went.
 */
export async function sendMail(
  deps: SendDeps,
  sending: { accountId: string; id: string; threadId?: string; mail: Outgoing },
): Promise<{ id: string; threadId: string }> {
  const { db, mailbox } = deps;
  const now = deps.now ?? Date.now;
  const { accountId, id, mail } = sending;
  if (!(await preferences(db)).mail) throw new Refusal('Turn Inbox on to send mail from Sift.');
  if (!(await canSend(db, accountId))) throw new Refusal(`Google has not let Sift send from ${accountId}.`);
  const own = [accountId, ...(await mailboxAliases(db, accountId))];
  if (!own.includes(mail.from.address.toLowerCase())) throw new Refusal(`${mail.from.address} is not an address of ${accountId}.`);
  const at = now();
  const raw = buildMessage(mail, id, at);
  // It went: a record that could not be written is not a failure the person should answer by sending again. Sync records it.
  const keep = async (sent: { id: string; threadId: string; labelIds: readonly string[] }) => {
    await recordSent(db, accountId, { ...sent, headers: sentHeaders(mail, id, at), text: mail.text, at }).catch(reportError);
    return { id: sent.id, threadId: sent.threadId };
  };

  const earlier = await openTries(db, 'send', (payload) => payload.send?.messageId === id);
  if (earlier.length > 0) {
    const found = await mailbox.findByMessageId(id);
    if (!found && earlier.some((t) => t.status === 'pending' || at - t.at < SETTLE_MS))
      throw new Refusal('Sift cannot tell yet whether this went. Try again in a couple of minutes.');
    for (const action of earlier) await finishAction(db, action.id, found ? 'done' : 'failed', null, found ? null : 'not in Gmail', now());
    if (found) return await keep({ ...found, labelIds: ['SENT'] });
  }
  const actionId = await insertPendingAction(
    db,
    {
      accountId,
      messageId: null,
      type: 'send',
      payload: { add: [], remove: [], send: { messageId: id, to: mail.to.map((p) => p.address), cc: mail.cc.map((p) => p.address), subject: mail.subject } },
      originalLabels: [],
    },
    now(),
  );
  let sent;
  try {
    sent = await mailbox.send({ raw, ...(sending.threadId ? { threadId: sending.threadId } : {}) });
  } catch (error) {
    // It may have gone with its answer lost; the next try looks for it before sending again.
    await finishAction(db, actionId, 'unknown', null, error instanceof Error ? error.message : String(error), now());
    throw error;
  }
  await finishAction(db, actionId, 'done', sent.labelIds, null, now());
  return await keep(sent);
}
