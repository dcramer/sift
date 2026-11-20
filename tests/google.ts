/**
 * Google as Sift reaches it, in memory: Gmail's API and Google's sign-in, answered at their real addresses through MSW, so
 * Sift's own Gmail client (`src/gmail/`) runs as it does against Google. Each mailbox is a `FakeGmail`: its messages, kept
 * as the RFC 2822 text Gmail would hold and read back as Gmail's API gives them; its labels, filters, send-as addresses,
 * and history. A test puts mail in it, changes it as the person would in Gmail, makes a call fail, and reads what Sift
 * asked (`requests`) and what it changed.
 *
 * Gmail's search is a small one: the operators Sift's queries use (`in:`, `label:`, `from:`, `to:`, `list:`, `subject:`,
 * `rfc822msgid:`, `after:`, `before:`, `newer_than:`, `is:`, `has:attachment`), `-`, `OR`, `{…}` and `(…)`, and bare words.
 * Any other operator is refused, as a query Gmail would read differently from the fake would be.
 */
import type { gmail_v1 } from '@googleapis/gmail';
import { http, HttpResponse } from 'msw/http';
import { setupServer } from 'msw/node';
import type { clientFor } from '../src/gmail/auth.ts';
import { GMAIL_SCOPES, SEND_SCOPE } from '../src/gmail/scopes.ts';

type Part = gmail_v1.Schema$MessagePart;
type Header = { name: string; value: string };

export const SECRETS: Parameters<typeof clientFor>[0] = { clientId: 'client.apps.googleusercontent.com', clientSecret: 'client-secret' };

/** Mail to put in a mailbox: who and what, and where it sits. */
export interface Mail {
  id?: string;
  threadId?: string;
  /** `Name <address>` or an address. */
  from: string;
  to?: string;
  cc?: string;
  subject?: string;
  text?: string;
  html?: string;
  /** Default: in the inbox, unread. */
  labelIds?: string[];
  /** Gmail's `internalDate`, epoch milliseconds. */
  at?: number;
  /** Headers besides those above, such as `List-Id` or `Authentication-Results`. */
  headers?: Record<string, string>;
  attachments?: { filename: string; mimeType: string; data: string }[];
}

interface Stored {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  raw: string;
  payload: Part;
}

type Change = { id: string; labelIds: string[] };
interface HistoryRecord {
  id: number;
  messagesAdded?: Change[];
  messagesDeleted?: Change[];
  labelsAdded?: (Change & { added: string[] })[];
  labelsRemoved?: (Change & { removed: string[] })[];
  /** Named in the record's `messages` alone, with nothing saying what happened to it. */
  mentioned?: Change[];
}

/**
 * A call made to fail: with an HTTP status Gmail answers, `lost`, where it is carried out and its answer never comes, or
 * `unchanged`, answered as a success with the change not taken: a modify with the message as it was, a filter made or
 * removed with the filters as they were (`users.messages.modify` and `users.settings.filters.*` only).
 */
export type Failure = { status: number; reason?: string } | 'network' | 'lost' | 'unchanged';

/** One request Sift made of Gmail, as the API's name for its method and what it asked for. */
export interface Asked {
  method: string;
  id?: string;
  format?: string;
  q?: string;
  pageToken?: string;
  /** The labels a search was narrowed to. */
  labelIds?: string[];
}

const SYSTEM_LABELS = [
  'INBOX',
  'SENT',
  'DRAFT',
  'SPAM',
  'TRASH',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'CHAT',
  'CATEGORY_PERSONAL',
  'CATEGORY_SOCIAL',
  'CATEGORY_PROMOTIONS',
  'CATEGORY_UPDATES',
  'CATEGORY_FORUMS',
];

const b64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** RFC 2047 encoded words decoded, as Gmail's API gives header values. */
function decodeWords(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, _charset: string, kind: string, data: string) =>
      kind.toUpperCase() === 'B'
        ? Buffer.from(data, 'base64').toString('utf8')
        : Buffer.from(
            data.replaceAll('_', ' ').replace(/=([0-9A-F]{2})/gi, (__, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
            'latin1',
          ).toString('utf8'),
    );
}

function quotedPrintable(text: string): Buffer {
  const bytes: number[] = [];
  const soft = text.replace(/=\r?\n/g, '');
  for (let i = 0; i < soft.length; i++) {
    if (soft[i] === '=' && /^[0-9A-F]{2}$/i.test(soft.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(soft.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i]!, 'utf8'));
  }
  return Buffer.from(bytes);
}

const param = (value: string, name: string) => new RegExp(`${name}="?([^";]+)"?`, 'i').exec(value)?.[1];

/** One MIME part of RFC 2822 text as Gmail's API gives it: headers decoded, a leaf's data as base64url, parts nested. */
function parsePart(text: string, partId = ''): Part {
  const split = /\r?\n\r?\n/.exec(text);
  const head = split ? text.slice(0, split.index) : text;
  const body = split ? text.slice(split.index + split[0].length) : '';
  const headers: Header[] = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length > 0) headers.at(-1)!.value += ` ${line.trim()}`;
    else if (line.includes(':')) headers.push({ name: line.slice(0, line.indexOf(':')), value: line.slice(line.indexOf(':') + 1).trim() });
  }
  for (const h of headers) h.value = decodeWords(h.value);
  const get = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';
  const type = get('content-type') || 'text/plain';
  const mimeType = type.split(';')[0]!.trim().toLowerCase();
  const filename = param(get('content-disposition'), 'filename') ?? param(type, 'name') ?? '';
  if (mimeType.startsWith('multipart/')) {
    const boundary = param(type, 'boundary');
    if (!boundary) throw new Error('A multipart message has no boundary');
    const pieces = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?\\r?\\n?`)).slice(1, -1);
    return {
      partId,
      mimeType,
      filename,
      headers,
      body: { size: 0 },
      parts: pieces.map((piece, i) => parsePart(piece, partId === '' ? String(i) : `${partId}.${i}`)),
    };
  }
  const encoding = get('content-transfer-encoding').toLowerCase();
  const bytes =
    encoding === 'base64'
      ? Buffer.from(body.replace(/\s+/g, ''), 'base64')
      : encoding === 'quoted-printable'
        ? quotedPrintable(body)
        : Buffer.from(body, 'utf8');
  return { partId, mimeType, filename, headers, body: { size: bytes.length, data: b64url(bytes) } };
}

/** The RFC 2822 text of `mail`, its text and HTML as alternatives, its attachments beside them. */
function rawOf(mail: Mail, id: string): string {
  const leaf = (mimeType: string, data: string | Buffer, more: string[] = []) =>
    [`Content-Type: ${mimeType}; charset=UTF-8`, ...more, 'Content-Transfer-Encoding: base64', '', Buffer.from(data).toString('base64')].join('\r\n');
  const multipart = (subtype: string, parts: string[], boundary: string) =>
    [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, p]), `--${boundary}--`, ''].join('\r\n');
  const alternatives = [
    ...(mail.text !== undefined || mail.html === undefined ? [leaf('text/plain', mail.text ?? `Text of ${id}.`)] : []),
    ...(mail.html !== undefined ? [leaf('text/html', mail.html)] : []),
  ];
  let body = alternatives.length === 1 ? alternatives[0]! : multipart('alternative', alternatives, `alt-${id}`);
  if (mail.attachments?.length)
    body = multipart(
      'mixed',
      [body, ...mail.attachments.map((a) => leaf(a.mimeType, a.data, [`Content-Disposition: attachment; filename="${a.filename}"`]))],
      `mixed-${id}`,
    );
  const at = mail.at ?? Date.now();
  const headers: Record<string, string> = {
    From: mail.from,
    ...(mail.to ? { To: mail.to } : {}),
    ...(mail.cc ? { Cc: mail.cc } : {}),
    Subject: mail.subject ?? `Subject of ${id}`,
    Date: new Date(at).toUTCString().replace('GMT', '+0000'),
    'Message-ID': `<${id}@mail.example.com>`,
    'MIME-Version': '1.0',
    ...mail.headers,
  };
  return `${Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\r\n')}\r\n${body}`;
}

const headerOf = (m: Stored, name: string) => m.payload.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? '';

/** The readable text of a message: its text parts, or its HTML without tags. */
function textOf(part: Part): string {
  if (part.parts) return part.parts.map(textOf).join('\n');
  if (part.filename) return '';
  const data = part.body?.data ? Buffer.from(part.body.data, 'base64url').toString('utf8') : '';
  if (part.mimeType === 'text/plain') return data;
  if (part.mimeType === 'text/html') return data.replace(/<[^>]+>/g, ' ');
  return '';
}

const hasAttachment = (part: Part): boolean => Boolean(part.filename) || (part.parts ?? []).some(hasAttachment);

/** A Gmail search Sift's fake cannot read the way Gmail would. */
class QueryError extends Error {}

const DAY = 86_400_000;

/** Gmail's search, as far as the fake reads it: a test of one message. */
function searchOf(query: string, gmail: FakeGmail): (m: Stored) => boolean {
  const tokens = query.match(/-?(?:[\w.]+:)?(?:\([^)]*\)|"[^"]*"|[^\s{}()]+)|[{}()]/g) ?? [];
  let at = 0;
  const words = (m: Stored) => `${headerOf(m, 'subject')}\n${headerOf(m, 'from')}\n${headerOf(m, 'to')}\n${textOf(m.payload)}`.toLowerCase();
  const date = (value: string) => (/^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value.replaceAll('/', '-')));
  const term = (token: string): ((m: Stored) => boolean) => {
    if (token.startsWith('-')) {
      const inner = term(token.slice(1));
      return (m) => !inner(m);
    }
    const op = /^([\w]+):(.*)$/.exec(token);
    if (!op) {
      const word = token.replaceAll('"', '').toLowerCase();
      return (m) => words(m).includes(word);
    }
    const [, name, rawValue] = op as unknown as [string, string, string];
    const values = rawValue.startsWith('(')
      ? rawValue
          .slice(1, -1)
          .split(/\s+/)
          .filter((v) => v !== '' && v !== 'OR')
      : [rawValue.replaceAll('"', '')];
    const any = (test: (m: Stored, value: string) => boolean) => (m: Stored) => values.some((v) => test(m, v.toLowerCase()));
    switch (name) {
      case 'in': {
        const where = { inbox: 'INBOX', sent: 'SENT', drafts: 'DRAFT', chats: 'CHAT', spam: 'SPAM', trash: 'TRASH' } as Record<string, string>;
        return any((m, v) => {
          if (v === 'anywhere') return true;
          if (!where[v]) throw new QueryError(`in:${v}`);
          return m.labelIds.includes(where[v]);
        });
      }
      case 'label':
        return any((m, v) => m.labelIds.some((id) => id.toLowerCase() === v || gmail.labels.get(id)?.name.toLowerCase() === v));
      case 'is':
        return any((m, v) => (v === 'read' ? !m.labelIds.includes('UNREAD') : m.labelIds.includes(v.toUpperCase())));
      case 'has':
        return any((m, v) => {
          if (v !== 'attachment') throw new QueryError(`has:${v}`);
          return hasAttachment(m.payload);
        });
      case 'from':
        return any((m, v) => headerOf(m, 'from').toLowerCase().includes(v));
      case 'to':
        return any((m, v) => ['to', 'cc', 'bcc'].some((h) => headerOf(m, h).toLowerCase().includes(v)));
      case 'list':
        return any((m, v) => headerOf(m, 'list-id').toLowerCase().includes(v));
      case 'subject':
        return any((m, v) => headerOf(m, 'subject').toLowerCase().includes(v));
      case 'rfc822msgid':
        return any((m, v) => headerOf(m, 'message-id').toLowerCase().replace(/^<|>$/g, '') === v.replace(/^<|>$/g, ''));
      case 'after':
        return any((m, v) => m.internalDate >= date(v));
      case 'before':
        return any((m, v) => m.internalDate < date(v));
      case 'newer_than':
      case 'older_than': {
        const span = /^(\d+)([dmy])$/.exec(rawValue);
        if (!span) throw new QueryError(token);
        const ms = Number(span[1]) * { d: DAY, m: 30 * DAY, y: 365 * DAY }[span[2] as 'd' | 'm' | 'y'];
        return (m) => (name === 'newer_than' ? m.internalDate > gmail.now() - ms : m.internalDate <= gmail.now() - ms);
      }
      default:
        throw new QueryError(token);
    }
  };
  const group = (closing: string | null): ((m: Stored) => boolean) => {
    const anyOf = closing === '}';
    const tests: ((m: Stored) => boolean)[] = [];
    let or = false;
    while (at < tokens.length) {
      const token = tokens[at++]!;
      if (token === closing) break;
      let next: (m: Stored) => boolean;
      if (token === 'OR') {
        or = true;
        continue;
      } else if (token === '{') next = group('}');
      else if (token === '(') next = group(')');
      else next = term(token);
      if (or && tests.length > 0) {
        const before = tests.pop()!;
        tests.push((m) => before(m) || next(m));
      } else tests.push(next);
      or = false;
    }
    return anyOf ? (m) => tests.length === 0 || tests.some((t) => t(m)) : (m) => tests.every((t) => t(m));
  };
  return group(null);
}

/** Gmail's answer to a request it refuses. */
const refused = (status: number, message: string, reason = 'failedPrecondition') =>
  HttpResponse.json({ error: { code: status, message, status: reason.toUpperCase(), errors: [{ message, domain: 'global', reason }] } }, { status });

/** One Gmail mailbox. */
export class FakeGmail {
  readonly address: string;
  /** Addresses it may send as besides its own, and whether each has been confirmed. */
  sendAs: { email: string; pending?: boolean }[] = [];
  readonly labels = new Map<string, { id: string; name: string; type: 'system' | 'user' }>();
  filters: { id: string; criteria: gmail_v1.Schema$FilterCriteria; action: gmail_v1.Schema$FilterAction }[] = [];
  /** Every request made of it, in order. */
  readonly requests: Asked[] = [];
  /** When set, mail sent or put in is not found by a search until `index()`: Gmail's search lags what it takes. */
  lagSearch = false;
  /** What a search guesses for how many it found (`resultSizeEstimate`), which in Gmail can be well off: by default, exactly. */
  estimate: (found: number) => number = (found) => found;
  /** When set, a search asked for any page after its first never answers: Gmail still listing a long search. */
  holdPages = false;
  now: () => number = () => Date.now();

  private readonly messages = new Map<string, Stored>();
  private readonly history: HistoryRecord[] = [];
  private historyId = 1000;
  private oldestHistory = 1000;
  /** Each method's next calls in turn: a failure, or `null` for one answered as usual. */
  private readonly failures = new Map<string, (Failure | null)[]>();
  private readonly meanwhiles = new Map<string, (() => void)[]>();
  private readonly arrivals = new Map<string, (() => unknown)[]>();
  private readonly unindexed = new Set<string>();
  private made = 0;

  constructor(address: string) {
    this.address = address;
    for (const id of SYSTEM_LABELS) this.labels.set(id, { id, name: id, type: 'system' });
  }

  /** All it holds, to be put back by `restore` in another process (the browser tests' server). */
  save() {
    return {
      address: this.address,
      sendAs: this.sendAs,
      labels: [...this.labels.values()],
      filters: this.filters,
      messages: [...this.messages.values()].map(({ payload: _, ...m }) => m),
      history: this.history,
      historyId: this.historyId,
      oldestHistory: this.oldestHistory,
      made: this.made,
    };
  }

  static restore(saved: ReturnType<FakeGmail['save']>): FakeGmail {
    const gmail = new FakeGmail(saved.address);
    gmail.sendAs = saved.sendAs;
    for (const label of saved.labels) gmail.labels.set(label.id, label);
    gmail.filters = saved.filters;
    for (const m of saved.messages) gmail.messages.set(m.id, { ...m, payload: parsePart(m.raw) });
    gmail.history.push(...saved.history);
    gmail.historyId = saved.historyId;
    gmail.oldestHistory = saved.oldestHistory;
    gmail.made = saved.made;
    return gmail;
  }

  /** Mail arriving: in the mailbox, and in its history unless `quietly` (mail from before Sift, found only by a search). */
  deliver(mail: Mail, { quietly = false }: { quietly?: boolean } = {}): string {
    const id = mail.id ?? this.newId();
    this.put(
      { id, threadId: mail.threadId ?? id, labelIds: mail.labelIds ?? ['INBOX', 'UNREAD'], internalDate: mail.at ?? this.now(), raw: rawOf(mail, id) },
      quietly,
    );
    return id;
  }

  /** A change the person makes in Gmail. */
  change(id: string, change: { add?: string[]; remove?: string[] }): void {
    this.relabel(this.must(id), change.add ?? [], change.remove ?? []);
  }

  /** A message deleted for good. */
  delete(id: string): void {
    const m = this.must(id);
    this.messages.delete(id);
    this.record({ messagesDeleted: [{ id, labelIds: m.labelIds }] });
  }

  /** Gmail keeps no history before now: a cursor from earlier is refused. */
  expireHistory(): void {
    this.oldestHistory = this.historyId;
  }

  /** A label the person made in Gmail. */
  label(name: string): string {
    const id = `Label_${this.labels.size + 1}`;
    this.labels.set(id, { id, name, type: 'user' });
    return id;
  }

  /** Where its history is now, as `users.getProfile` answers: the cursor a sync that just ran leaves. */
  cursor(): string {
    return String(this.historyId);
  }

  /** The id of the label with this name. */
  labelId(name: string): string | undefined {
    return [...this.labels.values()].find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;
  }

  /** A message as Gmail holds it now. */
  message(id: string) {
    const m = this.messages.get(id);
    return (
      m && {
        id: m.id,
        threadId: m.threadId,
        labelIds: [...m.labelIds],
        internalDate: m.internalDate,
        raw: m.raw,
        header: (name: string) => headerOf(m, name.toLowerCase()),
      }
    );
  }

  /** What was sent from it, oldest first. */
  sent() {
    return [...this.messages.values()].filter((m) => m.labelIds.includes('SENT')).map((m) => this.message(m.id)!);
  }

  /** Every message it holds, newest first. */
  all() {
    return this.newest().map((m) => this.message(m.id)!);
  }

  /** The next calls of `method` (Gmail's name for it, `users.messages.send`) fail, one each. */
  fail(method: string, ...failures: Failure[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...failures]);
  }

  /** The calls of `method` after the next `answered` fail, one each: Gmail refusing part-way through Sift's work. */
  failLater(method: string, answered: number, ...failures: Failure[]): void {
    this.failures.set(method, [...(this.failures.get(method) ?? []), ...Array<null>(answered).fill(null), ...failures]);
  }

  /** `change` happens in Gmail right after the next call of `method` is answered, before Sift asks again: mail arriving while Sift pages. */
  meanwhile(method: string, change: () => void): void {
    this.meanwhiles.set(method, [...(this.meanwhiles.get(method) ?? []), change]);
  }

  /** `happening` is awaited when the next call of `method` reaches Gmail, before it is carried out: what goes on while Sift waits on it. */
  whileAsked(method: string, happening: () => unknown): void {
    this.arrivals.set(method, [...(this.arrivals.get(method) ?? []), happening]);
  }

  /** Gmail names a message in a history record without saying what happened to it, as it has been seen to for new mail. */
  mention(id: string): void {
    this.record({ mentioned: [{ id, labelIds: [...this.must(id).labelIds] }] });
  }

  /** Mail sent or put in while `lagSearch` was on is found by a search from now. */
  index(): void {
    this.unindexed.clear();
  }

  /** The requests for `method`, or for a message by id: `asked('users.messages.get', id)`. */
  asked(method: string, id?: string): Asked[] {
    return this.requests.filter((r) => r.method === method && (id === undefined || r.id === id));
  }

  private newId(): string {
    return (0x19a0000000000 + ++this.made).toString(16);
  }

  private must(id: string): Stored {
    const m = this.messages.get(id);
    if (!m) throw new Error(`No message ${id} in ${this.address}`);
    return m;
  }

  private record(record: Omit<HistoryRecord, 'id'>): void {
    this.history.push({ id: ++this.historyId, ...record });
  }

  private put(m: Omit<Stored, 'payload'>, quietly = false): Stored {
    const stored = { ...m, payload: parsePart(m.raw) };
    this.messages.set(m.id, stored);
    if (!quietly) this.record({ messagesAdded: [{ id: m.id, labelIds: [...m.labelIds] }] });
    else this.historyId++;
    return stored;
  }

  private relabel(m: Stored, add: readonly string[], remove: readonly string[]): void {
    const added = add.filter((l) => !m.labelIds.includes(l));
    const removed = remove.filter((l) => m.labelIds.includes(l) && !add.includes(l));
    m.labelIds = [...m.labelIds.filter((l) => !removed.includes(l)), ...added];
    if (added.length > 0) this.record({ labelsAdded: [{ id: m.id, labelIds: [...m.labelIds], added }] });
    if (removed.length > 0) this.record({ labelsRemoved: [{ id: m.id, labelIds: [...m.labelIds], removed }] });
  }

  private newest(): Stored[] {
    return [...this.messages.values()].toSorted((a, b) => b.internalDate - a.internalDate || b.id.localeCompare(a.id));
  }

  private minimal(m: Stored) {
    return {
      id: m.id,
      threadId: m.threadId,
      labelIds: [...m.labelIds],
      snippet: textOf(m.payload).slice(0, 100),
      historyId: String(this.historyId),
      internalDate: String(m.internalDate),
      sizeEstimate: m.raw.length,
    };
  }

  private page<T>(items: T[], size: number, token: string | null) {
    const from = Number(token ?? 0);
    return { items: items.slice(from, from + size), next: from + size < items.length ? String(from + size) : null };
  }

  private messageResource(m: Stored, format: string, only: string[]) {
    if (format === 'minimal') return this.minimal(m);
    if (format === 'raw') return { ...this.minimal(m), raw: b64url(m.raw) };
    if (format === 'metadata') {
      const wanted = new Set(only.map((h) => h.toLowerCase()));
      const headers = (m.payload.headers ?? []).filter((h) => wanted.size === 0 || wanted.has(h.name!.toLowerCase()));
      return { ...this.minimal(m), payload: { mimeType: m.payload.mimeType, headers } };
    }
    return { ...this.minimal(m), payload: m.payload };
  }

  private validLabels(ids: readonly string[]): string | null {
    return ids.find((id) => !this.labels.has(id)) ?? null;
  }

  /** Answers one request to `method`, or the failure queued for it. */
  async answer(method: string, asked: Omit<Asked, 'method'>, run: () => Response | Promise<Response>): Promise<Response> {
    this.requests.push({ method, ...asked });
    await this.arrivals.get(method)?.shift()?.();
    const response = await this.answerOnce(method, asked, run);
    this.meanwhiles.get(method)?.shift()?.();
    return response;
  }

  private async answerOnce(method: string, asked: Omit<Asked, 'method'>, run: () => Response | Promise<Response>): Promise<Response> {
    const failure = this.failures.get(method)?.shift();
    if (failure === undefined || failure === null) return await run();
    if (failure === 'network') return HttpResponse.error();
    if (failure === 'lost') {
      await run();
      return HttpResponse.error();
    }
    if (failure === 'unchanged' && (method === 'users.settings.filters.create' || method === 'users.settings.filters.delete')) {
      const filters = [...this.filters];
      const response = await run();
      this.filters = filters;
      return response;
    }
    if (failure === 'unchanged') {
      if (method !== 'users.messages.modify') throw new Error(`The fake Gmail does not answer ${method} unchanged`);
      const m = this.must(asked.id!);
      return HttpResponse.json({ id: m.id, threadId: m.threadId, labelIds: [...m.labelIds] });
    }
    return refused(failure.status, failure.reason ?? 'Refused by the test', failure.reason ?? 'backendError');
  }

  /** Gmail's API, for this mailbox. */
  respond(method: string, request: Request, params: Record<string, string>, body: Record<string, unknown>): Response | Promise<Response> {
    const url = new URL(request.url);
    const q = url.searchParams;
    const id = params['id'];
    switch (method) {
      case 'users.getProfile':
        return HttpResponse.json({
          emailAddress: this.address,
          messagesTotal: this.messages.size,
          threadsTotal: new Set(this.newest().map((m) => m.threadId)).size,
          historyId: String(this.historyId),
        });
      case 'users.history.list': {
        const start = Number(q.get('startHistoryId'));
        if (start < this.oldestHistory) return refused(404, 'Requested entity was not found.', 'notFound');
        const records = this.history.filter((r) => r.id > start);
        const { items, next } = this.page(records, Number(q.get('maxResults') ?? 100), q.get('pageToken'));
        const named = (changes: Change[] | undefined) =>
          changes?.map((c) => ({ message: { id: c.id, threadId: this.messages.get(c.id)?.threadId ?? c.id, labelIds: c.labelIds } }));
        const history = items.map((r) => ({
          id: String(r.id),
          messages: [
            ...(r.messagesAdded ?? []),
            ...(r.messagesDeleted ?? []),
            ...(r.labelsAdded ?? []),
            ...(r.labelsRemoved ?? []),
            ...(r.mentioned ?? []),
          ].map((c) => ({
            id: c.id,
            threadId: this.messages.get(c.id)?.threadId ?? c.id,
          })),
          ...(r.messagesAdded ? { messagesAdded: named(r.messagesAdded) } : {}),
          ...(r.messagesDeleted ? { messagesDeleted: named(r.messagesDeleted) } : {}),
          ...(r.labelsAdded ? { labelsAdded: r.labelsAdded.map((c) => ({ ...named([c])![0], labelIds: c.added })) } : {}),
          ...(r.labelsRemoved ? { labelsRemoved: r.labelsRemoved.map((c) => ({ ...named([c])![0], labelIds: c.removed })) } : {}),
        }));
        return HttpResponse.json({ ...(history.length > 0 ? { history } : {}), historyId: String(this.historyId), ...(next ? { nextPageToken: next } : {}) });
      }
      case 'users.messages.list': {
        if (this.holdPages && q.get('pageToken')) return new Promise<never>(() => {});
        let matches: (m: Stored) => boolean;
        try {
          matches = searchOf(q.get('q') ?? '', this);
        } catch (error) {
          if (error instanceof QueryError) return refused(400, `Invalid query: ${error.message}`, 'invalidArgument');
          throw error;
        }
        const labels = q.getAll('labelIds');
        const junk = !q.get('includeSpamTrash') || q.get('includeSpamTrash') === 'false';
        const found = this.newest().filter(
          (m) =>
            !this.unindexed.has(m.id) &&
            labels.every((l) => m.labelIds.includes(l)) &&
            (!junk || /in:(spam|trash)/.test(q.get('q') ?? '') || !m.labelIds.some((l) => l === 'SPAM' || l === 'TRASH')) &&
            matches(m),
        );
        const { items, next } = this.page(found, Math.min(Number(q.get('maxResults') ?? 100), 500), q.get('pageToken'));
        return HttpResponse.json({
          ...(items.length > 0 ? { messages: items.map((m) => ({ id: m.id, threadId: m.threadId })) } : {}),
          ...(next ? { nextPageToken: next } : {}),
          resultSizeEstimate: this.estimate(found.length),
        });
      }
      case 'users.messages.get': {
        const m = this.messages.get(id!);
        if (!m) return refused(404, 'Requested entity was not found.', 'notFound');
        return HttpResponse.json(this.messageResource(m, q.get('format') ?? 'full', q.getAll('metadataHeaders')));
      }
      case 'users.messages.modify': {
        const m = this.messages.get(id!);
        if (!m) return refused(404, 'Requested entity was not found.', 'notFound');
        const add = (body['addLabelIds'] as string[] | undefined) ?? [];
        const remove = (body['removeLabelIds'] as string[] | undefined) ?? [];
        const unknown = this.validLabels([...add, ...remove]);
        if (unknown) return refused(400, `Invalid label: ${unknown}`, 'invalidArgument');
        this.relabel(m, add, remove);
        return HttpResponse.json({ id: m.id, threadId: m.threadId, labelIds: m.labelIds });
      }
      case 'users.messages.insert':
      case 'users.messages.send': {
        const raw = Buffer.from(typeof body['raw'] === 'string' ? body['raw'] : '', 'base64url').toString('utf8');
        if (!raw.includes('\n')) return refused(400, "'raw' RFC822 payload message string or uploading message via /upload/* URL required", 'invalidArgument');
        const labelIds = method === 'users.messages.send' ? ['SENT'] : ((body['labelIds'] as string[] | undefined) ?? []);
        const unknown = this.validLabels(labelIds);
        if (unknown) return refused(400, `Invalid label: ${unknown}`, 'invalidArgument');
        const newId = this.newId();
        const thread = typeof body['threadId'] === 'string' && this.newest().some((m) => m.threadId === body['threadId']) ? body['threadId'] : newId;
        const stored = this.put({ id: newId, threadId: thread, labelIds, internalDate: this.now(), raw });
        if (this.lagSearch) this.unindexed.add(newId);
        return HttpResponse.json({ id: stored.id, threadId: stored.threadId, labelIds: stored.labelIds });
      }
      case 'users.threads.get': {
        const messages = this.newest()
          .filter((m) => m.threadId === id)
          .toReversed();
        if (messages.length === 0) return refused(404, 'Requested entity was not found.', 'notFound');
        return HttpResponse.json({
          id,
          historyId: String(this.historyId),
          messages: messages.map((m) => this.messageResource(m, q.get('format') ?? 'full', q.getAll('metadataHeaders'))),
        });
      }
      case 'users.labels.list':
        return HttpResponse.json({ labels: [...this.labels.values()] });
      case 'users.labels.get': {
        const label = this.labels.get(id!);
        if (!label) return refused(404, 'Requested entity was not found.', 'notFound');
        const holding = this.newest().filter((m) => m.labelIds.includes(label.id));
        return HttpResponse.json({ ...label, messagesTotal: holding.length, messagesUnread: holding.filter((m) => m.labelIds.includes('UNREAD')).length });
      }
      case 'users.labels.create': {
        const name = typeof body['name'] === 'string' ? body['name'] : '';
        if (this.labelId(name)) return refused(409, 'Label name exists or conflicts', 'alreadyExists');
        return HttpResponse.json(this.labels.get(this.label(name)));
      }
      case 'users.settings.sendAs.list':
        return HttpResponse.json({
          sendAs: [
            { sendAsEmail: this.address, isPrimary: true, isDefault: true },
            ...this.sendAs.map((a) => ({ sendAsEmail: a.email, isPrimary: false, verificationStatus: a.pending ? 'pending' : 'accepted' })),
          ],
        });
      case 'users.settings.filters.list':
        return HttpResponse.json(this.filters.length > 0 ? { filter: this.filters } : {});
      case 'users.settings.filters.create': {
        const action = body['action'] as gmail_v1.Schema$FilterAction;
        const unknown = this.validLabels([...(action.addLabelIds ?? []), ...(action.removeLabelIds ?? [])]);
        if (unknown) return refused(400, `Invalid label: ${unknown}`, 'invalidArgument');
        const filter = { id: `ANe1Bmj${this.filters.length + 1}`, criteria: body['criteria'] as gmail_v1.Schema$FilterCriteria, action };
        this.filters.push(filter);
        return HttpResponse.json(filter);
      }
      case 'users.settings.filters.delete': {
        if (!this.filters.some((f) => f.id === id)) return refused(404, 'Filter doesn’t exist', 'notFound');
        this.filters = this.filters.filter((f) => f.id !== id);
        return new HttpResponse(null, { status: 204 });
      }
      default:
        throw new Error(`The fake Gmail does not answer ${method}`);
    }
  }
}

/** Each Gmail method Sift calls: how it is sent and its path, as `src/gmail/call.ts` names them. */
const ROUTES: [method: string, verb: 'get' | 'post' | 'delete', path: string][] = [
  ['users.getProfile', 'get', '/profile'],
  ['users.history.list', 'get', '/history'],
  ['users.messages.list', 'get', '/messages'],
  ['users.messages.send', 'post', '/messages/send'],
  ['users.messages.insert', 'post', '/messages'],
  ['users.messages.get', 'get', '/messages/:id'],
  ['users.messages.modify', 'post', '/messages/:id/modify'],
  ['users.threads.get', 'get', '/threads/:id'],
  ['users.labels.list', 'get', '/labels'],
  ['users.labels.get', 'get', '/labels/:id'],
  ['users.labels.create', 'post', '/labels'],
  ['users.settings.sendAs.list', 'get', '/settings/sendAs'],
  ['users.settings.filters.list', 'get', '/settings/filters'],
  ['users.settings.filters.create', 'post', '/settings/filters'],
  ['users.settings.filters.delete', 'delete', '/settings/filters/:id'],
];

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/:user';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';

/** What `gmail.modify`, `gmail.settings.basic` and, given, `gmail.send` grant: the scopes Sift asks for. */
const SCOPES = { read: [...GMAIL_SCOPES], send: [...GMAIL_SCOPES, SEND_SCOPE] };

/** Google: the mailboxes, and the sign-ins that reach them. */
export class FakeGoogle {
  readonly mailboxes = new Map<string, FakeGmail>();
  /** Refresh tokens Google honours, by the mailbox and scopes each was given for. */
  private readonly grants = new Map<string, { address: string; scopes: string[] }>();
  private readonly access = new Map<string, string>();
  private readonly codes = new Map<string, { address: string; scopes: string[] }>();
  private issued = 0;
  /** Called after each request that changed what it holds, or may have: a sign-in, a revoke, any Gmail request but a read. */
  onChange: () => void = () => {};

  /** The mailbox at `address`, made empty the first time it is asked for. */
  mailbox(address: string): FakeGmail {
    let mailbox = this.mailboxes.get(address);
    if (!mailbox) {
      mailbox = new FakeGmail(address);
      this.mailboxes.set(address, mailbox);
    }
    return mailbox;
  }

  /** A refresh token for the mailbox, as a sign-in that granted these scopes leaves. */
  grant(address: string, { send = false }: { send?: boolean } = {}): string {
    this.mailbox(address);
    const token = `1//refresh-${++this.issued}-${address}`;
    this.grants.set(token, { address, scopes: send ? SCOPES.send : SCOPES.read });
    return token;
  }

  /** The code Google's consent screen hands back for this mailbox, to be exchanged once. */
  consent(address: string, { send = false }: { send?: boolean } = {}): string {
    this.mailbox(address);
    const code = `4/code-${++this.issued}`;
    this.codes.set(code, { address, scopes: send ? SCOPES.send : SCOPES.read });
    return code;
  }

  /** Google ends a sign-in: its refresh token is refused from now (`invalid_grant`). */
  expire(refreshToken: string): void {
    this.grants.delete(refreshToken);
  }

  /** Whether Google still honours this refresh token. */
  honours(refreshToken: string): boolean {
    return this.grants.has(refreshToken);
  }

  /** How many sign-ins to the mailbox Google still honours: one revoked is gone. */
  grantsFor(address: string): number {
    return [...this.grants.values()].filter((g) => g.address === address).length;
  }

  /** All it holds, to be put back by `restore` in another process (the browser tests' server). */
  save() {
    return { mailboxes: [...this.mailboxes.values()].map((m) => m.save()), grants: [...this.grants], issued: this.issued };
  }

  static restore(saved: ReturnType<FakeGoogle['save']>): FakeGoogle {
    const google = new FakeGoogle();
    for (const m of saved.mailboxes) google.mailboxes.set(m.address, FakeGmail.restore(m));
    for (const [token, grant] of saved.grants) google.grants.set(token, grant);
    google.issued = saved.issued;
    return google;
  }

  private tokens(grant: { address: string; scopes: string[] }, refresh: string) {
    const access = `ya29.access-${++this.issued}`;
    this.access.set(access, refresh);
    return { access_token: access, expires_in: 3599, scope: grant.scopes.join(' '), token_type: 'Bearer' };
  }

  private mailboxOf(request: Request): FakeGmail | null {
    const access = /^Bearer (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1];
    const refresh = access && this.access.get(access);
    const grant = refresh && this.grants.get(refresh);
    return grant ? this.mailbox(grant.address) : null;
  }

  handlers() {
    const form = async (request: Request) => new URLSearchParams(await request.text());
    return [
      http.post(TOKEN, async ({ request }) => {
        const params = await form(request);
        if (params.get('grant_type') === 'refresh_token') {
          const refresh = params.get('refresh_token') ?? '';
          const grant = this.grants.get(refresh);
          if (!grant) return HttpResponse.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
          return HttpResponse.json(this.tokens(grant, refresh));
        }
        if (params.get('grant_type') === 'authorization_code') {
          const code = params.get('code') ?? '';
          const consented = this.codes.get(code);
          this.codes.delete(code);
          if (!consented) return HttpResponse.json({ error: 'invalid_grant', error_description: 'Malformed auth code.' }, { status: 400 });
          const refresh = `1//refresh-${++this.issued}-${consented.address}`;
          this.grants.set(refresh, consented);
          this.onChange();
          return HttpResponse.json({ ...this.tokens(consented, refresh), refresh_token: refresh });
        }
        return HttpResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
      }),
      http.post(REVOKE, async ({ request }) => {
        const token = new URL(request.url).searchParams.get('token') ?? (await form(request)).get('token') ?? '';
        const refresh = this.grants.has(token) ? token : this.access.get(token);
        if (!refresh || !this.grants.has(refresh)) return HttpResponse.json({ error: 'invalid_token' }, { status: 400 });
        this.grants.delete(refresh);
        this.onChange();
        return new HttpResponse(null, { status: 200 });
      }),
      ...ROUTES.map(([method, verb, path]) =>
        http[verb](`${GMAIL}${path}`, async ({ request, params }) => {
          const mailbox = this.mailboxOf(request);
          if (!mailbox) return refused(401, 'Request had invalid authentication credentials.', 'unauthenticated');
          const q = new URL(request.url).searchParams;
          const id = typeof params['id'] === 'string' ? params['id'] : undefined;
          const body = verb === 'post' ? ((await request.json().catch(() => ({}))) as Record<string, unknown>) : {};
          const answered = await mailbox.answer(
            method,
            {
              ...(id ? { id } : {}),
              ...(q.get('format') ? { format: q.get('format')! } : {}),
              ...(q.get('q') !== null ? { q: q.get('q')! } : {}),
              ...(q.get('pageToken') ? { pageToken: q.get('pageToken')! } : {}),
              ...(q.getAll('labelIds').length > 0 ? { labelIds: q.getAll('labelIds') } : {}),
            },
            () => mailbox.respond(method, request, id ? { id } : {}, body),
          );
          if (verb !== 'get') this.onChange();
          return answered;
        }),
      ),
    ];
  }
}

/**
 * Answers Google's addresses from `google` in this process, as long as the server returned is listening. A request to a
 * Google address the fake does not answer is an error, never the network; any other address is left alone.
 */
export function serveGoogle(google: () => FakeGoogle) {
  const server = setupServer(...google().handlers());
  return {
    listen: () =>
      server.listen({
        onUnhandledFrame: ({ frame, defaults }) => {
          const { request } = frame.data as { request?: Request };
          if (request && /(^|\.)google(apis)?\.com$/.test(new URL(request.url).hostname)) defaults.error();
        },
      }),
    /** Answer from `google()` again, after it was replaced. */
    reset: () => server.resetHandlers(...google().handlers()),
    close: () => server.close(),
  };
}
