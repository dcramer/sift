import { gmail, type gmail_v1 } from '@googleapis/gmail';
import type { OAuth2Client } from 'google-auth-library';
import { type MessageContent, readContent } from './body.ts';
import { calls, isNotFound } from './call.ts';
import type { Pace } from './quota.ts';

/** Headers fetched for triage, and all a message read whole (`getMessage`) keeps of its own. */
const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Reply-To',
  'Subject',
  'List-Id',
  'List-Unsubscribe',
  'List-Unsubscribe-Post',
  'Precedence',
  'Auto-Submitted',
  'Authentication-Results',
  'In-Reply-To',
  'References',
  // How a digest Sift put in the mailbox is told from mail (`isOwnDigest`, src/store/digests.ts).
  'Message-ID',
  // Which service sent it (see `bulkService` in src/triage/facts.ts).
  'Return-Path',
  'X-Mailer',
  'Feedback-ID',
  'X-MC-User',
  'X-SG-EID',
  'X-Mailgun-Sid',
  'X-SES-Outgoing',
  'X-PM-Message-Id',
] as const;

export interface RawMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  /** Epoch milliseconds, from Gmail's `internalDate`. */
  internalDate: number;
  headers: { name: string; value: string }[];
}

/** One message that a history record says was added, with its labels at that time. */
interface HistoryAddition {
  id: string;
  labelIds: string[];
}

/** Labels put on or taken off one message, by anyone: the user, another client, or sift itself. */
export interface HistoryLabelChange {
  messageId: string;
  added: string[];
  removed: string[];
}

export interface HistoryPage {
  additions: HistoryAddition[];
  labelChanges?: HistoryLabelChange[];
  /**
   * Messages a record names without saying they were added, relabelled or deleted. Gmail has been seen to
   * leave a new message out of `messagesAdded` and name it only here.
   */
  unexplained?: string[];
  /** Messages deleted for good. */
  deleted?: string[];
  /** The mailbox's current history id; the next cursor once the last page is read. */
  historyId: string;
  nextPageToken?: string;
}

interface MessageIdPage {
  ids: string[];
  nextPageToken?: string;
  /** Gmail's guess at how many match in all, which can be well off. */
  estimate?: number;
}

/** Thrown when Gmail no longer holds history back to the stored cursor. */
export class HistoryExpiredError extends Error {
  constructor() {
    super('Gmail history cursor expired');
    this.name = 'HistoryExpiredError';
  }
}

/** The read-only slice of Gmail that sync needs. Narrow so tests can fake it. */
export interface GmailApi {
  getProfile(): Promise<{ emailAddress: string; historyId: string }>;
  /** Throws HistoryExpiredError when `startHistoryId` is too old. */
  listHistory(startHistoryId: string, pageToken?: string): Promise<HistoryPage>;
  searchInbox(query: string, pageToken?: string): Promise<MessageIdPage>;
  /** A search of the whole mailbox but Spam and Trash, newest first, `most` a page. */
  searchMail(query: string, most: number, pageToken?: string): Promise<MessageIdPage>;
  /** How many messages the mailbox holds, as Gmail counts them, Spam and Trash among them. */
  mailboxSize(): Promise<number>;
  /** How many messages are in the inbox, as Gmail counts them for its label. */
  inboxSize(): Promise<number>;
  /** Null when the message no longer exists. Does not mark it read. */
  getMetadata(messageId: string): Promise<RawMessage | null>;
  /** The message's labels now, or null when it no longer exists. Does not mark it read. */
  getLabelIds(messageId: string): Promise<string[] | null>;
  /** Every label in the account with its name, to tell which label an id in history is. */
  listLabels(): Promise<{ id: string; name: string }[]>;
  /** The message's readable text (truncated), its HTML part, and the facts only the whole message shows (attachments, tracking); null when the message no longer exists. Does not mark it read. */
  getContent(messageId: string): Promise<MessageContent | null>;
  /** One read of the whole message (60 units, as `getContent`), for its headers and labels as `getMetadata` gives them and its content. Null when it no longer exists. */
  getMessage(messageId: string): Promise<{ raw: RawMessage; content: MessageContent } | null>;
  /** A thread's messages, oldest first, with their labels and nothing else. Null when the thread no longer exists. */
  getThread(threadId: string): Promise<{ id: string; labelIds: string[] }[] | null>;
  /** The addresses the owner can send as, the account's own among them, lowercased. */
  listSendAs(): Promise<string[]>;
}

const ASKED = new Set(METADATA_HEADERS.map((name) => name.toLowerCase()));

/** A message as `getMetadata` gives it. `only`: the headers to keep of a whole message's, which carries all of them. */
function rawOf(data: gmail_v1.Schema$Message, only: ReadonlySet<string> | null): RawMessage {
  const headers: RawMessage['headers'] = [];
  for (const h of data.payload?.headers ?? [])
    if (h.name && typeof h.value === 'string' && (!only || only.has(h.name.toLowerCase()))) headers.push({ name: h.name, value: h.value });
  return { id: data.id!, threadId: data.threadId!, labelIds: data.labelIds ?? [], internalDate: Number(data.internalDate ?? 0), headers };
}

/** The account's address and current history id. Unpaced when the account is only being signed in to. */
export async function readProfile(auth: OAuth2Client, pace: Pace = async () => {}) {
  const data = await calls(pace)('users.getProfile', 1, () => gmail({ version: 'v1', auth }).users.getProfile({ userId: 'me' }));
  if (!data.emailAddress || !data.historyId) throw new Error('Gmail profile is missing emailAddress or historyId');
  return { emailAddress: data.emailAddress.toLowerCase(), historyId: data.historyId };
}

/** Every call first waits its turn under the mailbox's share of Google's quota. */
export function createGmailApi(auth: OAuth2Client, pace: Pace): GmailApi {
  const client: gmail_v1.Gmail = gmail({ version: 'v1', auth });
  const userId = 'me';
  const call = calls(pace);

  return {
    async getProfile() {
      return await readProfile(auth, pace);
    },

    async listHistory(startHistoryId, pageToken) {
      try {
        const data = await call('users.history.list', 2, () =>
          client.users.history.list({
            userId,
            startHistoryId,
            // Not narrowed to the inbox: mail the user takes out of the inbox or out of spam must show up too. Nor
            // to any type: a record that names a new message only in `messages` has none of them.
            maxResults: 500,
            ...(pageToken ? { pageToken } : {}),
          }),
        );
        const additions: HistoryAddition[] = [];
        const labelChanges: HistoryLabelChange[] = [];
        const unexplained: string[] = [];
        const deleted: string[] = [];
        for (const record of data.history ?? []) {
          const named = new Set<string>();
          for (const added of record.messagesAdded ?? []) {
            if (added.message?.id) additions.push({ id: added.message.id, labelIds: added.message.labelIds ?? [] });
          }
          for (const change of record.labelsAdded ?? []) {
            if (change.message?.id) labelChanges.push({ messageId: change.message.id, added: change.labelIds ?? [], removed: [] });
          }
          for (const change of record.labelsRemoved ?? []) {
            if (change.message?.id) labelChanges.push({ messageId: change.message.id, added: [], removed: change.labelIds ?? [] });
          }
          for (const gone of record.messagesDeleted ?? []) if (gone.message?.id) deleted.push(gone.message.id);
          for (const typed of [record.messagesAdded, record.messagesDeleted, record.labelsAdded, record.labelsRemoved])
            for (const entry of typed ?? []) if (entry.message?.id) named.add(entry.message.id);
          for (const message of record.messages ?? []) if (message.id && !named.has(message.id)) unexplained.push(message.id);
        }
        return {
          additions,
          labelChanges,
          unexplained,
          deleted,
          historyId: data.historyId ?? startHistoryId,
          ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
        };
      } catch (error) {
        if (isNotFound(error)) throw new HistoryExpiredError();
        throw error;
      }
    },

    async searchInbox(query, pageToken) {
      const data = await call('users.messages.list', 5, () =>
        client.users.messages.list({ userId, q: query, labelIds: ['INBOX'], maxResults: 500, ...(pageToken ? { pageToken } : {}) }),
      );
      const ids = (data.messages ?? []).map((m) => m.id).filter((id) => typeof id === 'string');
      return {
        ids,
        ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
        ...(typeof data.resultSizeEstimate === 'number' ? { estimate: data.resultSizeEstimate } : {}),
      };
    },

    async searchMail(query, most, pageToken) {
      const data = await call('users.messages.list', 5, () =>
        client.users.messages.list({ userId, q: query, maxResults: most, ...(pageToken ? { pageToken } : {}) }),
      );
      const ids = (data.messages ?? []).map((m) => m.id).filter((id) => typeof id === 'string');
      return {
        ids,
        ...(data.nextPageToken ? { nextPageToken: data.nextPageToken } : {}),
        ...(typeof data.resultSizeEstimate === 'number' ? { estimate: data.resultSizeEstimate } : {}),
      };
    },

    async mailboxSize() {
      const data = await call('users.getProfile', 1, () => client.users.getProfile({ userId }));
      return data.messagesTotal ?? 0;
    },

    async getMessage(messageId) {
      try {
        const data = await call('users.messages.get', 60, () => client.users.messages.get({ userId, id: messageId, format: 'full' }));
        if (!data.id || !data.threadId) return null;
        return { raw: rawOf(data, ASKED), content: readContent(data.payload) };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async inboxSize() {
      const data = await call('users.labels.get', 1, () => client.users.labels.get({ userId, id: 'INBOX' }));
      return data.messagesTotal ?? 0;
    },

    async getLabelIds(messageId) {
      try {
        const data = await call('users.messages.get', 20, () => client.users.messages.get({ userId, id: messageId, format: 'minimal' }));
        return data.labelIds ?? [];
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async listLabels() {
      const data = await call('users.labels.list', 1, () => client.users.labels.list({ userId }));
      return (data.labels ?? []).flatMap((l) => (l.id && l.name ? [{ id: l.id, name: l.name }] : []));
    },

    async listSendAs() {
      const data = await call('users.settings.sendAs.list', 1, () => client.users.settings.sendAs.list({ userId }));
      // An address added but never confirmed from its own inbox is not shown to be the owner's.
      return (data.sendAs ?? []).flatMap((a) => (a.sendAsEmail && a.verificationStatus !== 'pending' ? [a.sendAsEmail.toLowerCase()] : []));
    },

    async getContent(messageId) {
      try {
        const data = await call('users.messages.get', 60, () => client.users.messages.get({ userId, id: messageId, format: 'full' }));
        return readContent(data.payload);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async getThread(threadId) {
      try {
        const data = await call('users.threads.get', 40, () => client.users.threads.get({ userId, id: threadId, format: 'minimal' }));
        return (data.messages ?? [])
          .filter((m) => typeof m.id === 'string')
          .toSorted((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0))
          .map((m) => ({ id: m.id as string, labelIds: m.labelIds ?? [] }));
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async getMetadata(messageId) {
      try {
        const data = await call('users.messages.get', 20, () =>
          client.users.messages.get({ userId, id: messageId, format: 'metadata', metadataHeaders: [...METADATA_HEADERS] }),
        );
        if (!data.id || !data.threadId) return null;
        return rawOf(data, null);
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
  };
}
