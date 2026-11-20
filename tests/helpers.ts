import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Scope, scopeFor } from '../src/dashboard/scope.ts';
import type { SignIn } from '../src/dashboard/controls.ts';
import type { Sql } from '../src/store/sql.ts';
import type { ExistingFilter, FilterProposal } from '../src/actions/filters.ts';
import type { Mailbox } from '../src/actions/mailbox.ts';
import type { GmailApi, RawMessage } from '../src/gmail/api.ts';
import { toFacts } from '../src/gmail/sync.ts';
import { readContent } from '../src/gmail/body.ts';
import type { SignIns } from '../src/model/credentials.ts';
import { recordSync, listAccounts } from '../src/store/accounts.ts';
import { examples, labels } from '../src/store/query.ts';
import { recordDecision } from '../src/store/decisions.ts';
import { exampleKeysOf, sealPart } from '../src/store/content.ts';
import type { Judge, Verdict } from '../src/triage/stages/model.ts';
import type { Address, Label, MessageFacts } from '../src/triage/types.ts';
import { type PassResult, type RunOptions, dueWork, runWork } from '../src/work/run.ts';
import type { Store } from '../src/store/store.ts';

/** The mailbox a test's person signs in with, unless it needs another. */
export const ACCOUNT = 'me@example.org';
export const DAY = 86_400_000;

export const tempDir = () => mkdtempSync(join(tmpdir(), 'sift-'));

/** Text as a Gmail message part carries it. */
export const b64 = (text: string) => Buffer.from(text).toString('base64url');

/** A verdict that places nothing: the model was not sure. */
export const UNSURE: Verdict = { label: 'unsure', reason: 'cannot tell', confidence: 0.2 };

/** The model tier, with calls recorded as `test/model`. */
export const testModel = (judge: Judge = async () => UNSURE) => ({ model: 'test/model', judge });

/** What the model's evidence is read from, finding no body, no thread, and no mail the owner sent unless `mailbox` says. */
export const quietSources = (mailbox: Pick<Mailbox, 'hasSentTo'> = { hasSentTo: async () => false }) => ({
  api: { getContent: async () => null, getThread: async () => null },
  mailbox,
});

/** A message as Gmail's metadata read returns it. `from` is the From header; `headers` replaces all of them. */
export function rawMessage(
  id: string,
  { from = 'News <news@example.com>', subject = `Subject ${id}`, ...overrides }: Partial<RawMessage> & { from?: string; subject?: string } = {},
): RawMessage {
  return {
    id,
    threadId: `t-${id}`,
    labelIds: ['INBOX', 'UNREAD'],
    internalDate: 1000,
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: ACCOUNT },
      { name: 'Subject', value: subject },
    ],
    ...overrides,
  };
}

/** A Google sign-in whose code stands in for the Google account that came back. */
export const codeSignIn: SignIn = {
  hasClient: () => true,
  url: (_redirect, state) => `https://accounts.example/auth?state=${state}`,
  complete: async (_redirect, code) => code,
};

/** Sign-ins kept in memory, as a person's database keeps them. */
export function memorySignIns(): SignIns & { stored: Map<string, string> } {
  const stored = new Map<string, string>();
  return {
    stored,
    read: async (provider) => stored.get(provider) ?? null,
    write: async (provider, text) => void stored.set(provider, text),
    remove: async (provider) => void stored.delete(provider),
    keys: async () => [...stored.keys()].toSorted(),
    exclusive: (work) => work(),
  };
}

const header = (a: Address) => (a.name ? `${a.name} <${a.address}>` : a.address);

/** A synthetic message, with headers that say what it does, as Gmail's would. Tests never use real mail. */
export function facts(overrides: Partial<MessageFacts> = {}): MessageFacts {
  const message = {
    accountId: ACCOUNT,
    messageId: 'm1',
    threadId: 't1',
    from: { address: 'news@example.com', domain: 'example.com' },
    to: [{ address: ACCOUNT, domain: 'example.org' }],
    cc: [],
    subject: 'Weekly digest',
    labelIds: ['INBOX', 'UNREAD'],
    receivedAt: 0,
    ...overrides,
  };
  return {
    ...message,
    headers: {
      from: header(message.from),
      to: message.to.map(header).join(', '),
      ...(message.cc.length > 0 ? { cc: message.cc.map(header).join(', ') } : {}),
      subject: message.subject,
      ...overrides.headers,
    },
  };
}

/** A message the user answered for, stored whole as `captureExamples` would leave it. */
export async function storeExample(
  db: Sql,
  accountId: string,
  example: {
    id: string;
    from: string;
    label: string;
    subject?: string;
    body?: string;
    markedAt?: number;
    receivedAt?: number;
    name?: string;
    headers?: Record<string, string>;
  },
): Promise<void> {
  const from = { address: example.from, domain: example.from.split('@')[1] ?? '', ...(example.name ? { name: example.name } : {}) };
  await recordSync(
    db,
    accountId,
    [
      facts({
        accountId,
        messageId: example.id,
        from,
        subject: example.subject ?? `Subject ${example.id}`,
        headers: example.headers ?? {},
        receivedAt: example.receivedAt ?? 0,
      }),
    ],
    '2',
  );
  await recordDecision(db, accountId, example.id, {
    disposition: 'review',
    subscription: 'preserve',
    stage: 'fallback',
    reason: 'no stage reached a decision',
  });
  await db.insert(examples).values({
    accountId,
    messageId: example.id,
    labelId: example.label,
    markedAt: example.markedAt ?? 0,
    status: 'captured',
    bodyText: sealPart(db, accountId, example.id, 'text', example.body ?? `Body of ${example.id}`),
    ...(await exampleKeysOf(db, accountId, example.id)),
  });
}

/** An in-memory mailbox. Label ids are `L:<name>`. */
export class FakeMailbox implements Mailbox {
  labels = new Map<string, string[]>();
  sentTo = new Set<string>();
  modifyCalls = 0;
  /** `before`: fail without changing anything. `after`: change, then fail (a lost response). */
  failModify: 'before' | 'after' | null = null;
  failSentLookup = false;
  /** Makes every label read fail, as a network outage would. */
  failReads = false;

  async getLabelIds(id: string) {
    if (this.failReads) throw new Error('network down');
    const labels = this.labels.get(id);
    return labels ? [...labels] : null;
  }

  /** Every label change, as Gmail's history would report it. A test's fake history can hand these out. */
  history: { messageId: string; added: string[]; removed: string[] }[] = [];

  /** A change made in Gmail by the user, not through sift. */
  byUser(id: string, change: { add?: string[]; remove?: string[] }) {
    const current = this.labels.get(id) ?? [];
    const add = (change.add ?? []).filter((l) => !current.includes(l));
    const remove = (change.remove ?? []).filter((l) => current.includes(l));
    this.labels.set(id, [...current.filter((l) => !remove.includes(l)), ...add]);
    if (add.length > 0) this.history.push({ messageId: id, added: add, removed: [] });
    if (remove.length > 0) this.history.push({ messageId: id, added: [], removed: remove });
  }

  async modifyLabels(id: string, change: { add: string[]; remove: string[] }) {
    this.modifyCalls++;
    if (this.failModify === 'before') throw new Error('network down');
    const current = this.labels.get(id) ?? [];
    if (change.add.length > 0) this.history.push({ messageId: id, added: change.add, removed: [] });
    if (change.remove.length > 0) this.history.push({ messageId: id, added: [], removed: change.remove });
    const after = [...current.filter((l) => !change.remove.includes(l)), ...change.add.filter((l) => !current.includes(l))];
    this.labels.set(id, after);
    if (this.failModify === 'after') throw new Error('timeout');
    return [...after];
  }

  async ensureLabel(name: string) {
    return `L:${name}`;
  }

  async hasSentTo(address: string) {
    if (this.failSentLookup) throw new Error('search failed');
    return this.sentTo.has(address);
  }

  filters: ExistingFilter[] = [];
  failFilters = false;

  async createFilter(filter: FilterProposal) {
    if (this.failFilters) throw new Error('network down');
    const id = `f${this.filters.length + 1}-${Object.values(filter.criteria).join('')}`;
    this.filters.push({
      id,
      criteria: { ...filter.criteria },
      action: { addLabelIds: filter.action.addLabelIds ?? [], removeLabelIds: filter.action.removeLabelIds ?? [] },
    });
    return id;
  }

  async deleteFilter(id: string) {
    if (this.failFilters) throw new Error('network down');
    this.filters = this.filters.filter((f) => f.id !== id);
  }

  async listFilters() {
    if (this.failFilters) throw new Error('network down');
    return structuredClone(this.filters);
  }

  /** Messages Sift put in, by id, as the raw text it gave. */
  inserted = new Map<string, string>();
  /** `before`: fail without putting it in. `after`: put it in, then fail (a lost response). */
  failInsert: 'before' | 'after' | null = null;

  async insertMessage(raw: string, labelIds: readonly string[]) {
    if (this.failInsert === 'before') throw new Error('network down');
    const id = `inserted-${this.inserted.size + 1}`;
    this.inserted.set(id, raw);
    this.labels.set(id, [...labelIds]);
    if (this.failInsert === 'after') throw new Error('timeout');
    return { id, labelIds: [...labelIds] };
  }

  /** Mail sent, by id, as the raw text and the thread it went into. */
  sent = new Map<string, { raw: string; threadId?: string }>();
  /** `before`: fail without sending. `after`: send, then fail (a lost response). */
  failSend: 'before' | 'after' | null = null;

  async send(message: { raw: string; threadId?: string }) {
    if (this.failSend === 'before') throw new Error('network down');
    const id = `sent-${this.sent.size + 1}`;
    this.sent.set(id, message);
    this.labels.set(id, ['SENT']);
    if (this.failSend === 'after') throw new Error('timeout');
    return { id, threadId: message.threadId ?? id, labelIds: ['SENT'] };
  }

  async findByMessageId(messageId: string) {
    const written = [
      ...[...this.inserted].map(([id, raw]) => ({ id, threadId: id, raw })),
      ...[...this.sent].map(([id, { raw, threadId }]) => ({ id, threadId: threadId ?? id, raw })),
    ];
    const found = written.find(({ raw }) => raw.includes(`\r\nMessage-ID: ${messageId}\r\n`));
    return found ? { id: found.id, threadId: found.threadId } : null;
  }
}

/** A scope that sees every connected account, as the dashboard has when no sign-in is set up. */
export const everything = async (db: Sql): Promise<Scope> =>
  scopeFor(
    (await listAccounts(db)).map((a) => a.id),
    true,
  );

/** The labels a mailbox in a test has unless it says otherwise: the starting set Sift once gave everyone. */
export const SAMPLE_LABELS: readonly Label[] = [
  {
    id: 'personal',
    name: 'Personal',
    description:
      'Written by a person to the owner or a small group, however short or oddly written: conversation, a direct request, an introduction, a reply in a conversation the owner took part in, a stranger writing about something particular to the owner. Not mail a company sends, however much the owner wants it.',
    disposition: 'keep',
    gmailLabel: 'sift/personal',
  },
  {
    id: 'security',
    name: 'Account alerts',
    description:
      "Something about the owner's own account that may need them: sign-in alerts, password resets, verification codes, a locked or changed account, a failed payment, a bill due, a card expiring, a renewal about to charge. However alarming, when the sender is who they claim to be. Not a change to terms or a privacy policy.",
    disposition: 'keep',
    gmailLabel: 'sift/security',
  },
  {
    id: 'transactional',
    name: 'Receipts',
    description:
      'A record of something the owner did: receipts and paid invoices, order confirmations, shipping and delivery updates, bookings, statements, tax documents. Even from a company that also sends promotions, or one they have not had mail from before. Not something they still have to pay or do.',
    disposition: 'archive',
    gmailLabel: 'sift/receipts',
  },
  {
    id: 'calendar',
    name: 'Calendar',
    description:
      "An invitation to a meeting or event from a person, or a change or cancellation to one the owner is in. Not replies to the owner's own invitations or automatic reminders, nor an event a company invites a whole list to.",
    disposition: 'keep',
    gmailLabel: 'sift/calendar',
  },
  {
    id: 'request',
    name: 'Asks for you',
    description:
      'Automated mail from a service where someone asks the owner in particular to do something: a review requested, an assignment, a mention, an approval or a question waiting on them. Not activity they are only watching.',
    disposition: 'keep',
    gmailLabel: 'sift/asks',
  },
  {
    id: 'notification',
    name: 'Notifications',
    description:
      'Automated activity from a service the owner uses that asks nothing of them: comments and changes on things they watch, builds, alerts, reports, digests, replies to their invitations, reminders, changes to terms or privacy policies.',
    disposition: 'archive',
    gmailLabel: 'sift/notifications',
  },
  {
    id: 'newsletter',
    name: 'Newsletters',
    description: 'Editorial or community content from a list the owner subscribed to: writers, publications, digests, community mailing lists.',
    disposition: 'archive',
    gmailLabel: 'sift/newsletters',
  },
  {
    id: 'marketing',
    name: 'Marketing',
    description:
      'Promotions, sales, product announcements, events and re-engagement mail a company sends to a whole list, whether the owner wants it or never asked for it. Not mail about the owner in particular: their order, account or support request.',
    disposition: 'archive',
    gmailLabel: 'sift/marketing',
  },
  {
    id: 'cold_outreach',
    name: 'Cold outreach',
    description:
      'An unsolicited pitch from a stranger, written from a template or sent as a sequence of follow-ups: sales, recruiting, partnerships, guest posts, fundraising, surveys. Not someone the owner has written to or who is answering them, nor a stranger writing about something particular to the owner.',
    disposition: 'archive',
    gmailLabel: 'sift/cold-outreach',
    unsubscribe: true,
  },
  {
    id: 'phishing',
    name: 'Scams and phishing',
    description:
      'An attempt to deceive the owner: a fake sign-in, invoice, delivery or security notice, a request for credentials, payment or gift cards, a scam or deceptive offer, or a sender pretending to be a person or company they are not. Being unexpected or from a new sender is not enough.',
    disposition: 'spam',
    gmailLabel: 'sift/phishing',
  },
];

/** Give the person the sample labels, before their Leave in inbox, unless they have them. */
export async function withSampleLabels(db: Sql): Promise<void> {
  await db
    .insert(labels)
    .values(
      SAMPLE_LABELS.map((l, position) => ({
        id: l.id,
        name: l.name,
        description: l.description,
        disposition: l.disposition,
        gmailLabel: l.gmailLabel ?? null,
        position,
        unsubscribe: l.unsubscribe ?? false,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Each piece due, one after another in this process, each starting nothing after `limitMs` from its own start:
 * what Workflow runs do on a host, without Workflow.
 */
export async function workDue(store: Store, options: RunOptions, limitMs: number, people?: readonly number[]): Promise<PassResult[]> {
  const results: PassResult[] = [];
  for (const piece of await dueWork(store, options, people)) {
    const result = await runWork(store, piece, options, (options.now ?? Date.now)() + limitMs);
    if (result) results.push(result);
  }
  return results;
}

/** A message in `gmailOf`'s mailbox: as Gmail's metadata read returns it, and its text. */
export type HeldMail = RawMessage & { text?: string };

/**
 * A Gmail holding `mail`, whose search lists all of it newest first, `most` a page, whatever it asks for (Gmail's search is
 * Gmail's to test), and whose history hands over `added` once. `calls` says what was read: `list:<page>`, `whole:<id>`,
 * `text:<id>`, `meta:<id>`.
 */
export function gmailOf(mail: HeldMail[], added: { id: string; labelIds: string[] }[] = []): GmailApi & { calls: string[] } {
  const calls: string[] = [];
  let cursor = 1;
  const find = (id: string) => mail.find((m) => m.id === id);
  const content = (m: HeldMail) => readContent({ mimeType: 'text/plain', body: { data: b64(m.text ?? `Text of ${m.id}.`) } });
  const raw = (m: HeldMail): RawMessage => ({ id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: m.internalDate, headers: m.headers });
  return {
    calls,
    getProfile: async () => ({ emailAddress: ACCOUNT, historyId: String(cursor) }),
    listHistory: async () => ({ additions: added.splice(0), historyId: String(++cursor) }),
    searchInbox: async () => ({ ids: [] }),
    searchMail: async (_query, most, pageToken) => {
      calls.push(`list:${pageToken ?? ''}`);
      const from = Number(pageToken ?? 0);
      const ids = mail.toSorted((a, b) => b.internalDate - a.internalDate).map((m) => m.id);
      const next = from + most < ids.length ? String(from + most) : undefined;
      return { ids: ids.slice(from, from + most), estimate: ids.length, ...(next ? { nextPageToken: next } : {}) };
    },
    mailboxSize: async () => mail.length,
    inboxSize: async () => mail.filter((m) => m.labelIds.includes('INBOX')).length,
    getMetadata: async (id) => (calls.push(`meta:${id}`), find(id) ? raw(find(id)!) : null),
    getLabelIds: async (id) => find(id)?.labelIds ?? null,
    listLabels: async () => [],
    getContent: async (id) => (calls.push(`text:${id}`), find(id) ? content(find(id)!) : null),
    getMessage: async (id) => (calls.push(`whole:${id}`), find(id) ? { raw: raw(find(id)!), content: content(find(id)!) } : null),
    getThread: async () => null,
    listSendAs: async () => [ACCOUNT],
  };
}

/**
 * A Gmail that holds a message's labels where `mailbox` does, and fails a second read of any message: its metadata (20 units)
 * may be read once and its whole (60) once, and nothing again, as docs/runtime.md expects. `deliver` puts mail in it and in
 * the next page of history, with the mailbox's own label changes since. `again` lists each read that was not the first of its
 * kind (`meta:<id>`, `whole:<id>`, `labels:<id>`); `reads` every read of a message or thread, in order, with each search of the
 * inbox (`search`) and count (`count`).
 */
export function onceGmail(mailbox: FakeMailbox) {
  const mail = new Map<string, HeldMail>();
  const added: { id: string; labelIds: string[] }[] = [];
  const reads: string[] = [];
  const again: string[] = [];
  let cursor = 1;
  const read = (kind: 'meta' | 'whole' | 'labels' | 'thread', id: string) => {
    const key = `${kind === 'labels' ? 'meta' : kind}:${id}`;
    if (kind !== 'thread' && reads.some((r) => r.replace(/^labels:/, 'meta:') === key)) {
      again.push(`${kind}:${id}`);
      reads.push(`${kind}:${id}`);
      throw new Error(`${id} was read from Gmail again`);
    }
    reads.push(`${kind}:${id}`);
    return mail.get(id);
  };
  const raw = (m: HeldMail): RawMessage => ({
    id: m.id,
    threadId: m.threadId,
    labelIds: [...(mailbox.labels.get(m.id) ?? [])],
    internalDate: m.internalDate,
    headers: m.headers,
  });
  const content = (m: HeldMail) => readContent({ mimeType: 'text/plain', body: { data: b64(m.text ?? `Text of ${m.id}.`) } });
  const newest = (inbox: boolean) =>
    [...mail.values()]
      .filter((m) => !inbox || mailbox.labels.get(m.id)?.includes('INBOX'))
      .toSorted((a, b) => b.internalDate - a.internalDate)
      .map((m) => m.id);
  const api: GmailApi = {
    getProfile: async () => ({ emailAddress: ACCOUNT, historyId: String(cursor) }),
    listHistory: async () => ({ additions: added.splice(0), labelChanges: mailbox.history.splice(0), historyId: String(++cursor) }),
    searchInbox: async () => {
      reads.push('search');
      return { ids: newest(true), estimate: newest(true).length };
    },
    searchMail: async () => ({ ids: newest(false), estimate: mail.size }),
    mailboxSize: async () => (reads.push('count'), mail.size),
    inboxSize: async () => (reads.push('count'), newest(true).length),
    getMetadata: async (id) => {
      const m = read('meta', id);
      return m ? raw(m) : null;
    },
    getLabelIds: async (id) => (read('labels', id) ? [...(mailbox.labels.get(id) ?? [])] : null),
    listLabels: async () => [...new Set([...mailbox.labels.values()].flat())].filter((id) => id.startsWith('L:')).map((id) => ({ id, name: id.slice(2) })),
    getContent: async (id) => {
      const m = read('whole', id);
      return m ? content(m) : null;
    },
    getMessage: async (id) => {
      const m = read('whole', id);
      return m ? { raw: raw(m), content: content(m) } : null;
    },
    getThread: async (threadId) => {
      read('thread', threadId);
      return [...mail.values()]
        .filter((m) => m.threadId === threadId)
        .toSorted((a, b) => a.internalDate - b.internalDate)
        .map((m) => ({ id: m.id, labelIds: [...(mailbox.labels.get(m.id) ?? [])] }));
    },
    listSendAs: async () => [ACCOUNT],
  };
  return {
    api,
    reads,
    again,
    /** Mail arriving: in Gmail, and in the next page of history unless `quietly` (mail from before Sift, found only by a search). */
    deliver(m: HeldMail, { quietly = false }: { quietly?: boolean } = {}) {
      mail.set(m.id, m);
      mailbox.labels.set(m.id, [...m.labelIds]);
      if (!quietly) added.push({ id: m.id, labelIds: [...m.labelIds] });
      return toFacts(ACCOUNT, raw(m))!;
    },
  };
}
