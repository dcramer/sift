import type { FactFilter, RuleFacts, RuleMatch, StageKey } from './api.ts';
import type { LEAVE_IN_INBOX, LEAVE_IN_INBOX_NAME } from '../../../src/triage/types.ts';

/**
 * The dashboard's words. Each thing sift says about mail has exactly one name, used in every stamp,
 * filter, select and column; sentences use the matching phrase from `willBe`. Add a word here, never in a view.
 */

/** Tiers in cascade order, cheapest first. Each has a fixed ink (see index.css); mail no tier decided is highlighted. */
export const TIERS: { key: StageKey; name: string; color: string }[] = [
  { key: 'rules', name: 'Rule', color: 'var(--tier-rules)' },
  { key: 'classifier', name: 'Classifier', color: 'var(--tier-classifier)' },
  { key: 'model', name: 'Model', color: 'var(--tier-model)' },
  { key: 'fallback', name: 'Undecided', color: 'var(--tier-fallback)' },
];
/** What became of the mail sift handled in a day, for Activity's chart, bottom to top. */
export const HANDLED = [
  { key: 'changed', name: 'Changed in Gmail', color: 'var(--handled-changed)' },
  { key: 'left', name: 'Left alone', color: 'var(--handled-left)' },
];
/** Activity's chart with a label chosen: that label, bottom, and the rest of the mail. */
export const labelSeries = (name: string) => [
  { key: 'label', name, color: 'var(--handled-label)' },
  { key: 'rest', name: 'Other mail', color: 'var(--handled-left)' },
];
export const tier = (key: string) => TIERS.find((t) => t.key === key) ?? { key, name: key, color: 'var(--muted-foreground)' };

/**
 * How sure sift is of a label, in three steps for a meter. Full means Sift does it by itself while it is on,
 * which for a model's label alone takes 0.9 (`SURE`, src/triage/stages/model.ts). Mail it would ask about is
 * never full, however sure the model was.
 */
export function sureness({ confidence, disposition }: { confidence: number | null; disposition: string }): 1 | 2 | 3 {
  if (disposition !== 'review') return 3;
  return confidence !== null && confidence >= 0.7 ? 2 : 1;
}

/** What a label can be set to do, and so what sift does with mail. The same word whether it is suggested, done or a setting. */
export const ACTIONS = [
  ['keep', 'Keep'],
  ['archive', 'Archive'],
  ['digest', 'Digest'],
  ['spam', 'Spam'],
  ['block', 'Block'],
] as const;
export type ActionKey = (typeof ACTIONS)[number][0];

/**
 * Leave in inbox: what mail is when it is none of the person's labels. It is a choice as good as any label, so
 * every list of them has it in the same place: first, set apart.
 */
export const INBOX: typeof LEAVE_IN_INBOX = 'everything_else';
export const INBOX_NAME: typeof LEAVE_IN_INBOX_NAME = 'Leave in inbox';

/** Labels as a list's options: Leave in inbox first, then a rule, then the person's own. */
export const inboxFirst = (labels: Iterable<readonly [string, string]>): (readonly [string, string] | null)[] => {
  const all = [...labels];
  const inbox = all.filter(([id]) => id === INBOX);
  return [...inbox, ...(inbox.length > 0 ? [null] : []), ...all.filter(([id]) => id !== INBOX)];
};

/**
 * What mail is and what happens to it, in the words every list uses: "Archive", or "Leave in inbox" for mail
 * Sift leaves where it is without a label (Leave in inbox itself, or a rule that only keeps).
 */
export const doesName = (labelId: string | null, disposition: string) =>
  labelId === INBOX || (labelId === null && disposition === 'keep') ? INBOX_NAME : outcomeName(disposition);

/** `review`: no tier was sure which label, so sift leaves the message alone and asks. Not a failure, so never drawn as one. */
const OUTCOMES: Record<string, string> = { ...Object.fromEntries(ACTIONS), review: 'Unlabelled' };
export const outcomeName = (key: string) => OUTCOMES[key] ?? key;

/** What a label's action does, in a sentence, so a choice says what follows from it before it is made. */
export const EXPLAIN: Record<ActionKey, string> = {
  keep: 'It stays in the inbox, with its label.',
  archive: 'It leaves the inbox and stays findable under its label.',
  digest: 'It leaves the inbox, and once a day one email lists it, with anything worth a look on top.',
  spam: 'It goes to spam. Never for anyone you have written to.',
  block: 'It goes to spam, and so does everything that sender sends afterwards, without being judged again. Only when the message proves who sent it.',
};

const WILL: Record<string, string> = {
  keep: 'kept',
  archive: 'archived',
  digest: 'put in the daily digest',
  spam: 'marked spam',
  block: 'marked spam and the sender blocked',
  review: 'left for you',
};
/** What happens to mail with a given action, for the end of a sentence. */
export const willBe = (key: string) => WILL[key] ?? key;

/** Who made a rule. */
export const MADE_BY = [
  ['user', 'You'],
  ['correction', 'Your answers'],
  ['learned', 'Sift, when it blocked them'],
] as const;
export const madeBy = (source: string) => MADE_BY.find(([key]) => key === source)?.[1] ?? source;

/** Where a decision has got to in Gmail. */
export type Status = 'suggested' | 'waiting' | 'done' | 'unchanged' | 'undone' | 'skipped' | 'failed';
export const STATUS_NAMES: Record<Status, string> = {
  suggested: 'Suggested',
  waiting: 'Waiting',
  done: 'Done',
  unchanged: 'No change',
  undone: 'Undone',
  skipped: 'Skipped',
  failed: 'Not done',
};
export function status(d: { carryOut: boolean; outcome: string | null; actionStatus: string | null }): Status {
  if (!d.carryOut) return 'suggested';
  if (d.actionStatus === 'undone') return 'undone';
  if (d.outcome === null || d.actionStatus === 'pending') return 'waiting';
  if (d.outcome === 'failed' || d.outcome === 'unknown' || d.actionStatus === 'failed' || d.actionStatus === 'unknown') return 'failed';
  if (d.outcome === 'skipped') return 'skipped';
  return d.outcome === 'none' ? 'unchanged' : 'done';
}

export const PERIODS = [
  ['1', 'Last 24 hours'],
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
] as const;

export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

const int = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
export const count = (n: number) => (n >= 10_000 ? compact.format(n) : int.format(n));
/** A number only known roughly, to two figures: 1,234 is 1,200. */
export const roughly = (n: number) => count(n < 100 ? n : Number(n.toPrecision(2)));
export const percent = (part: number, whole: number) => (whole === 0 ? '–' : `${Math.round((part / whole) * 100)}%`);
export const money = (usd: number) => (usd === 0 ? '$0' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);
/** Time saved, to the minute: "40 s", "40 min", "3 h 30 min". */
export function duration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`;
}
/** Storage, to two figures: "250 MB", "3.1 GB". */
export function size(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1000;
  let unit = 0;
  while (n >= 1000 && unit < units.length - 1) {
    n /= 1000;
    unit++;
  }
  return `${n < 10 ? Number(n.toFixed(1)) : Math.round(n)} ${units[unit]}`;
}
/** A round amount on an axis, which may be under a cent: $0.025. */
export const moneyTick = (usd: number) => (usd === 0 ? '$0' : `$${usd >= 0.1 ? usd.toFixed(2) : Number(usd.toPrecision(2))}`);

export const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
export const longDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
export const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
export const dateTime = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** Whole days from `ms`'s day to `now`'s, in the reader's zone: 0 today, 1 yesterday. */
const daysBack = (ms: number, now: number) =>
  Math.round((new Date(new Date(now).toDateString()).getTime() - new Date(new Date(ms).toDateString()).getTime()) / 86_400_000);

/** Which part of a list of mail, newest first, `ms` falls in: a day or week back, then its month. */
export function period(ms: number, now: number): string {
  const days = daysBack(ms, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 14) return 'Last week';
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString(undefined, sameYear ? { month: 'long' } : { month: 'long', year: 'numeric' });
}

/** When mail came, under its `period`: the time of day until yesterday, then the weekday, then the date. */
export function arrived(ms: number, now: number): string {
  const days = daysBack(ms, now);
  const at = new Date(ms);
  if (days <= 1) return at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (days < 7) return at.toLocaleDateString(undefined, { weekday: 'short' });
  return at.toLocaleDateString(
    undefined,
    at.getFullYear() === new Date(now).getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' },
  );
}

/** When a message in a conversation came: the time today, then the day and time, the year only when it is not this one. */
export function heard(ms: number, now: number): string {
  const at = new Date(ms);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (daysBack(ms, now) <= 0) return time;
  if (at.getFullYear() !== new Date(now).getFullYear()) return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

export function ago(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * What a rule can ask of what sift recorded about a message, each answer with its words after "mail that".
 * The same answers and words as `RULE_FACTS` (src/triage/facts.ts); tests/facts.test.ts holds them together.
 */
export const FACTS = {
  unsubscribe: [
    ['one-click', 'has a one-click unsubscribe'],
    [['header', 'none'], 'has no one-click unsubscribe'],
  ],
  listId: [
    [true, 'came through a mailing list'],
    [false, 'did not come through a mailing list'],
  ],
  markedBulk: [
    [true, 'is marked bulk'],
    [false, 'is not marked bulk'],
  ],
  bulkService: [
    [true, 'was sent through a bulk mail service'],
    [false, 'was sent through no bulk mail service Sift knows'],
  ],
  dmarc: [
    ['pass', 'passed DMARC'],
    [['fail', 'none'], 'did not pass DMARC'],
  ],
  replyToDiffers: [
    [true, 'has replies going elsewhere'],
    [false, 'has replies going to the sender'],
  ],
  addressed: [
    ['to', 'is addressed to you'],
    ['cc', 'copies you'],
    ['neither', 'does not name you'],
  ],
  isReply: [
    [true, 'is a reply'],
    [false, 'is not a reply'],
  ],
  category: [
    ['personal', 'is in Primary'],
    ['promotions', 'is in Promotions'],
    ['social', 'is in Social'],
    ['updates', 'is in Updates'],
    ['forums', 'is in Forums'],
  ],
  important: [
    [true, 'Gmail marked important'],
    [false, 'Gmail did not mark important'],
  ],
  hasAttachments: [
    [true, 'has attachments'],
    [false, 'has no attachments'],
  ],
  trackingPixel: [[true, 'has a tracking pixel']],
} as const satisfies { [K in keyof RuleFacts]-?: readonly (readonly [NonNullable<RuleFacts[K]>, string])[] };
export type FactKey = keyof typeof FACTS;

/** One condition on a fact: which fact, and which of its answers in `FACTS`. */
export interface FactAnswer {
  key: FactKey;
  index: number;
}
const answerOf = ({ key, index }: FactAnswer) => (FACTS[key] as readonly (readonly [unknown, string])[])[index];
export const factWords = (answer: FactAnswer) => answerOf(answer)?.[1] ?? '';
/** The same answer: a list holds the same values in any order. */
const same = (a: unknown, b: unknown) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((v) => b.includes(v)) : a === b);
/** A rule's conditions on facts, as answers. */
export const factAnswers = (facts: RuleFacts = {}): FactAnswer[] =>
  Object.entries(facts).flatMap(([key, want]) => {
    const index = (FACTS[key as FactKey] as readonly (readonly [unknown, string])[] | undefined)?.findIndex(([value]) => same(value, want)) ?? -1;
    return index === -1 ? [] : [{ key: key as FactKey, index }];
  });
/** Answers as the conditions a rule carries. */
export const factConditions = (answers: readonly FactAnswer[]): RuleFacts =>
  Object.fromEntries(answers.map((answer) => [answer.key, answerOf(answer)?.[0]])) as RuleFacts;
/** An answer as one string, for a select's value. */
export const factParam = ({ key, index }: FactAnswer) => `${key}:${index}`;

/** The facts For review and Activity can be narrowed by (`FACT_FILTERS`, src/dashboard/types.ts), in the words of the conditions they are. */
export const FACT_FILTER_WORDS = [
  ['reply', 'is a reply'],
  ['list', 'came through a mailing list'],
  ['one-click', 'has a one-click unsubscribe'],
  ['bulk-service', 'was sent through a bulk mail service'],
  ['not-to-you', 'does not name you'],
  ['unproven', 'did not pass DMARC'],
  ['attachments', 'has attachments'],
] as const satisfies readonly (readonly [FactFilter, string])[];
/** For a filter panel, with "any" first. */
export const FACT_FILTER_OPTIONS = [['', 'Any'] as const, ...FACT_FILTER_WORDS.map(([key, words]) => [key, capitalised(words)] as const)];
/** A fact filter that is on, as its chip says it. */
export const factFilterName = (key: FactFilter) => `Mail that ${FACT_FILTER_WORDS.find(([k]) => k === key)?.[1] ?? key}`;

const GROUP = {
  from: 'sender',
  fromDomain: 'sender',
  fromName: 'name',
  fromNameContains: 'name',
  to: 'to',
  listId: 'list',
  subjectContains: 'subject',
} as const;
type Named = keyof typeof GROUP;

/** One value of a match, as a sentence reads it. */
export interface Said {
  key: Named;
  value: string;
  /** The value unquoted. */
  plain: string;
  /** What goes before it: nothing first, "or" after another of the same kind, a comma after a different one. */
  joint: '' | ' or ' | ', ';
  /** The first value under its key, which takes that key's words ("anyone at"). */
  first: boolean;
}

/** A match's values in the order a sentence reads them, whatever order they were stored in; typed text is quoted. */
export function saidOf(match: RuleMatch): Said[] {
  const typed = new Set<string>(['fromName', 'fromNameContains', 'subjectContains']);
  const values = (Object.keys(GROUP) as Named[]).flatMap((key) =>
    (match[key] ?? []).map((value) => ({ key, plain: value, value: typed.has(key) ? `“${value}”` : value })),
  );
  return values.map((v, at) => {
    const before = values[at - 1];
    return { ...v, joint: !before ? '' : GROUP[before.key] === GROUP[v.key] ? ' or ' : ', ', first: before?.key !== v.key };
  });
}

export const MATCH_WORDS: Record<Named, string> = {
  from: 'from',
  fromDomain: 'from anyone at',
  fromName: 'named',
  fromNameContains: 'with a name containing',
  to: 'sent to',
  listId: 'on the list',
  subjectContains: 'with a subject containing',
};
/** A rule's conditions as words to follow "mail": "from news@example.com or anyone at example.org, with a subject containing …, that is a reply". */
export function describeMatch(match: RuleMatch): string {
  const named = saidOf(match)
    .map(({ key, value, joint, first }) => `${joint}${first ? `${MATCH_WORDS[key]} ` : ''}${value}`)
    .join('');
  const asked = factAnswers(match.facts).map(factWords);
  return [...(named ? [named] : []), ...(asked.length > 0 ? [`that ${asked.join(' and ')}`] : [])].join(', ');
}

/** How the owner and a sender (or a domain) know each other, as pointing at its icon says it. */
export const CONTACT_SAYS = {
  new: 'The first time Sift has seen them',
  mutual: 'You have written to them',
  'one-way': 'They write often and you have never written back',
} as const;

/** How the owner and a sender know each other, as a filter names it. */
export const CONTACT_FILTER = [
  ['', 'Anyone'],
  ['new', 'New'],
  ['mutual', 'You write to them'],
  ['one-way', 'Never written back'],
] as const;

/** A standing the owner gave: the press that gives it, and the state it leaves. */
export const STANDINGS = [
  ['trusted', 'Trust', 'Trusted'],
  ['unwanted', 'Unwanted', 'Unwanted'],
  ['blocked', 'Block', 'Blocked'],
] as const;

// Mail no tier could place is left in the inbox with Sift's own Gmail label: what Sift did there is ask.
const DID: Record<string, string> = {
  archive: 'Archived',
  digest: 'Put in the digest',
  spam: 'Marked spam',
  block: 'Blocked',
  keep: 'Kept',
  review: 'Asked you',
};
const DOING: Record<string, string> = { archive: 'archive', digest: 'put in the digest', spam: 'mark spam', block: 'block', keep: 'keep', review: 'ask you' };
/**
 * What happened to a message, as a log says it: "Archived", "Not archived", "Waiting to archive". `tone`
 * says how to show it: an undone change is struck through, what did not happen is quiet, the rest are plain.
 */
export function happened(d: { carryOut: boolean; outcome: string | null; actionStatus: string | null; disposition: string; labelId: string | null }): {
  text: string;
  tone: 'plain' | 'undone' | 'quiet';
} {
  const s = status(d);
  // Leave in inbox is said as itself, as every list says it: "Would leave in inbox", not "Would keep".
  const inbox = doesName(d.labelId, d.disposition) === INBOX_NAME;
  const doing = inbox ? 'leave in inbox' : DOING[d.disposition];
  const did = inbox ? 'Left in inbox' : DID[d.disposition];
  if (s === 'failed') return { text: d.disposition === 'review' ? 'Not asked' : `Not ${(did ?? d.disposition).toLowerCase()}`, tone: 'quiet' };
  if (s === 'undone') return { text: did ?? d.disposition, tone: 'undone' };
  if (s === 'waiting') return { text: `Waiting to ${doing ?? d.disposition}`, tone: 'quiet' };
  if (s === 'suggested') return { text: `Would ${doing ?? d.disposition}`, tone: 'quiet' };
  if (s === 'skipped') return { text: 'Skipped', tone: 'quiet' };
  return { text: did ?? d.disposition, tone: 'plain' };
}

/** A day in the log: "Today", "Yesterday", else "Thu, Nov 12". */
export function dayName(ms: number, now: number = Date.now()): string {
  const start = (at: number) => {
    const d = new Date(at);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const back = Math.round((start(now) - start(ms)) / 86_400_000);
  if (back === 0) return 'Today';
  if (back === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}
/** A time in the next few days: "today at 3:40 PM", "tomorrow at 3:40 PM", else "Thursday at 3:40 PM". */
export function ahead(ms: number, now: number): string {
  const start = (at: number) => {
    const d = new Date(at);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((start(ms) - start(now)) / 86_400_000);
  const day = days === 0 ? 'today' : days === 1 ? 'tomorrow' : new Date(ms).toLocaleDateString(undefined, { weekday: 'long' });
  return `${day} at ${clock(ms)}`;
}
export const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
