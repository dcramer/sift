import { QueryCache, QueryClient, environmentManager, keepPreviousData, onlineManager, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useContext, useSyncExternalStore } from 'react';
import { Mailbox } from './narrowed.ts';
import { traceHeaders } from './trace.ts';

export type {
  Contact,
  ContactPage,
  InboxEstimate,
  DecisionPage,
  DecisionRow,
  FactFilter,
  FeedbackRequest,
  Given,
  LabelProposal,
  LabelSummary,
  ListedDecision,
  MailAsk,
  MailConversation,
  MailReach,
  MailThread,
  MailView,
  ManageState,
  MessageDetail,
  Removed,
  RuleDraft,
  RuleFacts,
  RuleFilter,
  RuleMatch,
  RuleSummary,
  SenderPage,
  SenderProfile,
  Session,
  StageKey,
  SuggestionDetail,
  SuggestionItem,
  Suggestions,
  Summary,
  Usage,
} from '../../../src/dashboard/types.ts';
export type { Confidential } from '../../../src/confidential.ts';
import type {
  ContactPage,
  DecisionPage,
  InboxEstimate,
  MailReach,
  FactFilter,
  FeedbackReply,
  FeedbackRequest,
  Given,
  LabelProposal,
  MailAsk,
  MailChange,
  MailConversation,
  MailThreads,
  MailView,
  ManageState,
  MessageDetail,
  Models,
  Removed,
  RuleDraft,
  RuleFilter,
  RuleInbox,
  RuleMatch,
  RuleSummary,
  RuleUsage,
  RuleWaiting,
  SendRequest,
  SenderPage,
  Session,
  SignInCode,
  SuggestionDetail,
  Suggestions,
  Summary,
  Usage,
} from '../../../src/dashboard/types.ts';

export type Days = 1 | 7 | 30 | 90;

interface DecisionQuery {
  days: Days;
  status: string;
  search: string;
  /** Empty for none. */
  fact: FactFilter | '';
  /** A label's id; empty for any. */
  label: string;
  limit: number;
  offset: number;
}

interface ContactQuery {
  q: string;
  /** Empty for any. */
  standing: Given | '';
  /** How they and the person know each other; empty for any. */
  know: 'new' | 'mutual' | 'one-way' | '';
  limit: number;
  offset: number;
}

/** The server answered, and refused. */
class Refused extends Error {
  status: number;
  /** The settings a deploy still needs, when that is why. */
  missing: string[] | null;
  constructor(status: number, said: Said = {}) {
    super(said.error ?? `The server answered ${status}.`);
    this.status = status;
    this.missing = said.missing ?? null;
  }
}

/** No answer at all: the network is down or sift is not running. */
class Unreachable extends Error {}

let probing = false;

/**
 * Marks sift unreachable, which pauses every query where it is with what it last loaded, and asks
 * again until something answers. Coming back online resumes the paused queries and refreshes the rest.
 */
function lost() {
  onlineManager.setOnline(false);
  if (probing) return;
  probing = true;
  const ask = (wait: number) =>
    setTimeout(() => {
      fetch('/api/session', { cache: 'no-store' }).then(
        (response) => {
          if (!fromSift(response)) {
            ask(Math.min(wait * 2, 30_000));
            return;
          }
          probing = false;
          onlineManager.setOnline(true);
        },
        () => ask(Math.min(wait * 2, 30_000)),
      );
    }, wait);
  ask(2000);
}

/**
 * Sift answers every request itself, in JSON. A failure that is not (a proxy's 502 page, Vercel's
 * crashed function) is something in front of Sift saying it is not there.
 */
function fromSift(response: Response): boolean {
  return response.status < 500 || (response.headers.get('content-type') ?? '').startsWith('application/json');
}

async function send(path: string, init: RequestInit, unreachable: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    lost();
    throw new Unreachable(unreachable, { cause: error });
  }
  if (!fromSift(response)) {
    lost();
    throw new Unreachable(unreachable);
  }
  onlineManager.setOnline(true);
  return response;
}

/** The mailbox a read is narrowed to, by the signal `useLoaded` gave it, so no read has to pass it along. */
const narrowedBy = new WeakMap<AbortSignal, string>();

async function get<T>(path: string, params: Record<string, string | number>, signal: AbortSignal): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== '') query.set(key, String(value));
  const mailbox = narrowedBy.get(signal);
  if (mailbox) query.set('mailbox', mailbox);
  const response = await send(`${path}?${query}`, { signal, headers: traceHeaders() }, 'Sift cannot be reached.');
  if (!response.ok) throw new Refused(response.status, await reason(response));
  return (await response.json()) as T;
}

interface Said {
  error?: string;
  missing?: string[];
}

/** What Sift said when it refused. A gateway's or a crash's page says nothing of the kind. */
async function reason(response: Response): Promise<Said> {
  try {
    return (await response.json()) as Said;
  } catch {
    return {};
  }
}

/**
 * A change. The headers mark it as coming from this page, which the server requires of every write.
 * Refused outright while sift is unreachable: a change is never queued to happen later, unseen.
 */
/** `keepalive`: sent even as the page closes, for a write held back until then. */
async function post<T = unknown>(path: string, body: unknown, keepalive = false): Promise<T> {
  if (!onlineManager.isOnline()) throw new Unreachable('Sift cannot be reached, so nothing was changed. Try again when it is back.');
  const response = await send(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json', 'x-sift': '1', ...traceHeaders() }, body: JSON.stringify(body), keepalive },
    'Sift stopped answering, so this may not have been saved. Check when it is back.',
  );
  const result = (await response.json()) as T & Said;
  if (!response.ok) throw new Refused(response.status, result);
  return result;
}

/** This browser's time zone, which the server reads a person's digest hour in. */
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
/** Sent with labels that digest: until the hour is set under Settings, it is this browser's day the digest keeps to. */
const zoneFor = (labels: readonly { disposition?: string }[]) => (labels.some((l) => l.disposition === 'digest') ? { timeZone: browserZone() } : {});

/** A rule carries a label, an action (`disposition`), or both; or an action for mail that turns out to be `whenLabel`. */
export interface RuleBody {
  match: RuleMatch;
  /** What the mail is. */
  label?: string;
  /** Apply only once sift has said the mail is this label. */
  whenLabel?: string;
  disposition?: string;
  markRead?: boolean;
  unsubscribe?: boolean;
  when?: string;
  /** What the reader calls it; empty for none. */
  name?: string;
}

export const api = {
  /** With `label`, each day also says how much of its mail was that label. */
  summary: (days: Days, signal: AbortSignal, label = '') => get<Summary>('/api/summary', { days, label }, signal),
  usage: (signal: AbortSignal) => get<Usage>('/api/usage', {}, signal),
  decisions: (q: DecisionQuery, signal: AbortSignal) =>
    get<DecisionPage>(
      '/api/decisions',
      { days: q.days, status: q.status, q: q.search, fact: q.fact, label: q.label, limit: q.limit, offset: q.offset },
      signal,
    ),
  /** A message by Gmail's id, in whichever mailbox holds it; `mailbox` when the list it came from said. */
  message: (id: string, signal: AbortSignal, mailbox = '') => get<MessageDetail>('/api/message', mailbox ? { id, mailbox } : { id }, signal),
  /** Where a frame loads a message as the HTML Sift holds for it. */
  messageHtml: (id: string, mailbox: string) => `/api/message/html?${new URLSearchParams({ id, mailbox })}`,
  /** Everyone the person has mail from, newest first, a page at a time. */
  contacts: (q: ContactQuery, signal: AbortSignal) => get<ContactPage>('/api/contacts', { ...q }, signal),
  /** `name` lists only their mail under that name. */
  sender: (address: string, signal: AbortSignal, name?: string) => get<SenderPage>('/api/sender', name === undefined ? { address } : { address, name }, signal),
  domain: (domain: string, signal: AbortSignal) => get<SenderPage>('/api/domain', { domain }, signal),
  /** `theirs`: their own rule says more than a standing, so nothing was written and the rule dialog is for this. */
  giveStanding: (who: { address: string } | { domain: string }, standing: Given) =>
    post<{ id: string; was: Given | null } | { theirs: string }>('/api/standing', { ...who, standing }),
  clearStanding: (who: { address: string } | { domain: string }) => post('/api/standing/clear', who),
  rules: (signal: AbortSignal) => get<{ rules: RuleSummary[] }>('/api/rules', {}, signal),
  suggestions: (includeKept: boolean, fact: FactFilter | '', signal: AbortSignal) =>
    get<Suggestions>('/api/suggestions', { ...(includeKept ? { kept: 1 } : {}), ...(fact ? { fact } : {}) }, signal),
  suggestion: (sender: string, signal: AbortSignal) => get<SuggestionDetail>('/api/suggestion', { sender }, signal),
  /** Say what a message is. */
  feedback: (answer: FeedbackRequest) => post<FeedbackReply>('/api/feedback', answer, true),
  manage: (signal: AbortSignal) => get<ManageState>('/api/manage', {}, signal),
  /** The models the reader's own sign-ins offer, and the one to suggest first. */
  models: (signal: AbortSignal) => get<Models>('/api/models', {}, signal),
  /** The reader's own: true, sift carries out its decisions in their Gmail. */
  setActive: (active: boolean) => post('/api/active', { active }),
  /** Mail the person wrote, sent as them. */
  send: (mail: SendRequest) => post<{ id: string; threadId: string }>('/api/mail/send', mail),
  /** The reader's own model, `provider/model-id`, or null for none. */
  setModel: (model: string | null) => post('/api/model', { model }),
  setReasoning: (reasoning: ManageState['model']['reasoning']) => post('/api/model/reasoning', { reasoning }),
  /** Start a ChatGPT sign-in: resolves with where to go, and by device code the code to enter there. */
  signInChatGPT: () => post<SignInCode>('/api/model/chatgpt', {}),
  /** Finish a Sign in with ChatGPT with the address the browser was sent back to. */
  finishChatGPT: (address: string) => post('/api/model/chatgpt/finish', { address }),
  saveModelKey: (provider: string, key: string) => post('/api/model/key', { provider, key }),
  signOutModel: (provider: string) => post('/api/model/signout', { provider }),
  saveLabel: (id: string, change: { name?: string; description?: string; disposition?: string; markRead?: boolean; unsubscribe?: boolean }) =>
    post('/api/labels', { id, ...change, ...zoneFor([change]) }),
  /** Remove a label, with the rules that name it. */
  removeLabel: (id: string) => post('/api/labels/remove', { id }),
  /** Add labels: by hand, or kept from what the model suggested. */
  addLabels: (labels: { name: string; description: string; disposition: string; markRead?: boolean; unsubscribe?: boolean }[]) =>
    post<{ ids: string[] }>('/api/labels/add', { labels, ...zoneFor(labels) }),
  /** Ask the model for labels from what the person wants. Its own call; it can take a minute. */
  proposeLabels: (goal: string) => post<LabelProposal>('/api/labels/propose', { goal }),
  /** The latest labels the model suggested, so a reload keeps them. */
  labelProposal: (signal: AbortSignal) => get<{ proposal: LabelProposal | null }>('/api/labels/proposal', {}, signal),
  /** Make these labels, when the person has none yet. */
  acceptLabels: (labels: { name: string; description: string; disposition: string; markRead?: boolean; unsubscribe?: boolean }[]) =>
    post<{ ids: string[] }>('/api/labels/accept', { labels, ...zoneFor(labels) }),
  /** The hour of the reader's day their digests arrive, in this browser's time zone. */
  setDigestTime: (hour: number) => post('/api/digest', { hour, timeZone: browserZone() }),
  /** The model fills in a rule from the person's words, for the rule dialog. Nothing is made. */
  draftRule: (goal: string) => post<RuleDraft>('/api/rules/draft', { goal }),
  addRule: (
    rule: RuleBody & {
      /** The proposal it was made from, which this resolves. */
      proposal?: number;
    },
  ) => post<{ id: string; replaced: boolean; filter: RuleFilter | null }>('/api/rules', rule),
  /** Change what a rule matches and says, keeping its place and its exceptions. */
  editRule: (id: string, rule: RuleBody) => post('/api/rules/edit', { id, ...rule }),
  removeRule: (id: string) => post('/api/rules/remove', { id }),
  /** Write the rule to Gmail as a filter, or take its filter out. */
  ruleFilter: (id: string, on: boolean) => post('/api/rules/filter', { id, on }),
  /** What the rule decided and Sift has not moved. */
  ruleWaiting: (id: string, signal: AbortSignal) => get<RuleWaiting>('/api/rules/waiting', { id }, signal),
  ruleUsage: (id: string, signal: AbortSignal) => get<RuleUsage>('/api/rules/usage', { id }, signal),
  /** What applying the rule to the inbox would do, from a sample read from Gmail. */
  ruleInbox: (id: string, signal: AbortSignal) => get<RuleInbox>('/api/rules/inbox', { id }, signal),
  /** Start applying the rule to the inbox, in the background. */
  applyRule: (id: string) => post('/api/rules/apply', { id }),
  /** Dismiss a proposal. A proposed rule is made with `addRule`. */
  dismissProposal: (id: number) => post('/api/proposals', { id }),
  /** `message`: what the page will not show by itself, if anything. */
  undo: (id: number) => post<{ message: string | null }>('/api/undo', { id }),
  /** Inbox's conversations, a page from `before`; empty `label`, `q`, `from` and `domain` (the last two comma-separated) narrow nothing. */
  mailThreads: (
    query: { view: MailView; label: string; q: string; unread: boolean; from: string; domain: string; since: number | null },
    before: string,
    signal: AbortSignal,
  ) =>
    get<MailThreads>(
      '/api/mail/threads',
      {
        view: query.view,
        label: query.label,
        q: query.q,
        ...(query.unread ? { unread: 1 } : {}),
        from: query.from,
        domain: query.domain,
        ...(query.since === null ? {} : { since: query.since }),
        before,
      },
      signal,
    ),
  /** The model turns words into a filter on Inbox's list. `today` is the reader's, `YYYY-MM-DD`. */
  askMail: (words: string, today: string) => post<MailAsk>('/api/mail/ask', { words, today }),
  /** What a conversation says: recorded already, or asked of the model now. */
  /** A conversation by Gmail's id, in whichever mailbox holds it; `mailbox` when the list it came from said. */
  mailThread: (thread: string, signal: AbortSignal, mailbox = '') =>
    get<MailConversation>('/api/mail/thread', mailbox ? { thread, mailbox } : { thread }, signal),
  /** The reader's own press on mail in their inbox. `actions`: what landed, for Undo. */
  changeMail: (change: MailChange) => post<{ actions: number[]; missed: number }>('/api/mail/change', change),
  /** Whether Sift keeps a copy of the person's mail, for Inbox, and how far back. */
  setMail: (on: boolean, window?: ManageState['mailWindow']) => post('/api/mail/on', window ? { on, window } : { on }),
  /** What copying the mail for each window would take, from Gmail's counts. */
  mailReach: (signal: AbortSignal) => get<MailReach>('/api/mail/reach', {}, signal),
  inboxEstimate: (reach: 'inbox' | 'recent', signal: AbortSignal) => get<InboxEstimate>('/api/inbox', { reach }, signal),
  startInbox: (reach: 'inbox' | 'recent') => post('/api/inbox/start', { reach }),
  /** Stop going through the inbox, or with `rule`, stop applying it. */
  stopInbox: (rule?: string) => post('/api/inbox/stop', rule ? { rule } : {}),
  checkNow: () => post('/api/check', {}),
  session: (signal: AbortSignal) => get<Session>('/api/session', {}, signal),
  signOut: () => post('/api/signout', {}),
  /** `address` is what the person typed to confirm. */
  removeMailbox: (address: string) => post<Removed>('/api/mailbox/remove', { address }),
  makePrimary: (address: string) => post('/api/mailbox/primary', { address }),
  deleteAccount: (address: string) => post<Removed>('/api/account/delete', { address }),
};

const makeClient = (): QueryClient => {
  const client = new QueryClient({
    // A session that ended elsewhere: ask who is signed in again, which shows the sign-in screen.
    queryCache: new QueryCache({
      onError: (error) => {
        if (error instanceof Refused && error.status === 401) void client.invalidateQueries({ queryKey: ['session'] });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 5000,
        // Unreachable is retried for as long as it takes; a query waits, paused, while offline. Anything Sift answered will not change by asking again.
        retry: (_, error) => error instanceof Unreachable,
      },
    },
  });
  return client;
};

let browserClient: QueryClient | undefined;

/**
 * Where what the page loaded is kept. The browser keeps one for as long as the page is open. The server never fetches:
 * it makes one for each page it draws, holding only what that page was drawn with (`src/sift/page-data.ts`), so that
 * nothing one draw had is held for the next.
 */
export const queryClientFor = (): QueryClient => (environmentManager.isServer() ? makeClient() : (browserClient ??= makeClient()));

/** False while sift cannot be reached. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (changed) => onlineManager.subscribe(changed),
    () => onlineManager.isOnline(),
    () => true,
  );
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  /** The settings a deploy still needs, when that is why it failed. */
  missing: string[] | null;
  /** Load again now. */
  reload: () => void;
  /** True only before the first result; refreshes keep showing the previous data. */
  loading: boolean;
  /** When `data` was read. */
  at: number;
}

/**
 * Load `fetcher` now, again whenever `key` changes, every `refreshMs` while the tab is visible, when the
 * tab is returned to and when sift comes back after being unreachable. Views that share a `key` share
 * one request. A failed refresh keeps the last good data on screen and reports the error beside it.
 * Narrowed to the `Mailbox` it is drawn under, or to `mailbox` (`''` for all of them), and loaded again for another.
 */
export function useLoaded<T>(key: string, fetcher: (signal: AbortSignal) => Promise<T>, refreshMs = 30_000, mailbox?: string): Loaded<T> {
  const under = useContext(Mailbox);
  const narrowed = mailbox ?? under;
  const query = useQuery({
    // All mailboxes is the key alone, as the server draws it (`src/sift/page-data.ts`).
    queryKey: narrowed ? [key, narrowed] : [key],
    queryFn: ({ signal }) => {
      if (narrowed) narrowedBy.set(signal, narrowed);
      return fetcher(signal);
    },
    refetchInterval: refreshMs,
    placeholderData: keepPreviousData,
  });
  return {
    data: query.data ?? null,
    error: query.error?.message ?? null,
    missing: query.error instanceof Refused ? query.error.missing : null,
    loading: query.isPending,
    at: query.dataUpdatedAt,
    reload: () => void query.refetch({ cancelRefetch: false }),
  };
}

/**
 * Change what `useLoaded(key, …, '')` holds now, for a change this page made and knows the result of, so a view drawn
 * from it before it is read again (a conversation opened again straight after it was read) is not drawn from the old.
 */
export function changeLoaded<T>(key: string, change: (old: T) => T) {
  queryClientFor().setQueryData<T>([key], (old) => (old === undefined ? old : change(old)));
}

export interface Pages<T> {
  pages: T[];
  error: string | null;
  loading: boolean;
  /** There is more after the last page. */
  more: boolean;
  /** Load the page after the last, unless one is already on its way. */
  next: () => void;
}

/**
 * A list read a page at a time, as `useLoaded` reads one: each page from where the last ended (`next` in its reply, null
 * at the end). Read again, every page loaded so far is.
 */
export function usePages<T extends { next: string | null }>(
  key: string,
  fetcher: (before: string, signal: AbortSignal) => Promise<T>,
  refreshMs = 60_000,
): Pages<T> {
  const narrowed = useContext(Mailbox);
  const query = useInfiniteQuery({
    queryKey: narrowed ? [key, narrowed] : [key],
    queryFn: ({ pageParam, signal }) => {
      if (narrowed) narrowedBy.set(signal, narrowed);
      return fetcher(pageParam, signal);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: refreshMs,
    placeholderData: keepPreviousData,
  });
  return {
    pages: query.data?.pages ?? [],
    error: query.error?.message ?? null,
    loading: query.isPending,
    more: query.hasNextPage,
    next: () => {
      if (!query.isFetchingNextPage) void query.fetchNextPage();
    },
  };
}
