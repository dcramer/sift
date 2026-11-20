/**
 * What the dashboard API sends, and the bodies the page sends it, as schemas the server parses them
 * with. The web app imports only their types, so zod stays out of the page; keep this file's imports to
 * zod and the pure triage types.
 *
 * What Sift stores encrypted is `held` here: a string in the JSON, `Confidential` to the type checker
 * (src/confidential.ts), so the page draws it only through `reveal`, in the browser.
 */
import { z } from 'zod';
import type { Confidential } from '../confidential.ts';
import { RULE_FACTS, type RuleFacts as Conditions, factCondition } from '../triage/facts.ts';
import { GIVEN } from '../triage/standing.ts';
import { DRAFT_ACTIONS } from '../triage/proposal.ts';
import { REASONING } from '../model/reasoning.ts';
import { MAIL_WINDOWS } from '../mail-window.ts';
import { DECIDED } from '../triage/types.ts';

export const STAGES = ['rules', 'classifier', 'model', 'fallback'] as const;
export type StageKey = (typeof STAGES)[number];
const stage = z.enum(STAGES);

const LABEL_ID = /^[a-z0-9_-]{1,40}$/;
/** Text a person typed or the page sent, not empty and not long. */
export const text = (max = 200) => z.string().min(1).max(max);
export const labelId = z.string().regex(LABEL_ID);
export const decided = z.enum(DECIDED);
const ruleKind = z.enum(['label', 'action', 'when-label']);
/** A rule's conditions on facts: each fact named once, with one of the answers `RULE_FACTS` gives it. */
export const RuleFacts = z.strictObject(
  Object.fromEntries(
    Object.keys(RULE_FACTS).map((key) => [
      key,
      z
        .unknown()
        .refine((want) => factCondition(key, want) !== null, { error: `is not an answer Sift has for ${key}` })
        .optional(),
    ]),
  ),
) as unknown as z.ZodType<Conditions>;
export type RuleFacts = Conditions;
/** Text Sift stores encrypted: what came from mail, what names a sender, and the person's words to the models. */
const held = z.custom<Confidential>((value) => typeof value === 'string', { error: 'is not text' });
const values = z.array(z.string()).optional();
const match = z.object({
  from: values,
  fromDomain: values,
  fromName: values,
  fromNameContains: values,
  to: values,
  listId: values,
  subjectContains: values,
  facts: RuleFacts.optional(),
});
export type RuleMatch = z.infer<typeof match>;
const heldValues = z.array(held).optional();
/** A rule's conditions as a reply carries them. Its facts are Sift's own words for what it checked. */
const heldMatch = z.object({
  from: heldValues,
  fromDomain: heldValues,
  fromName: heldValues,
  fromNameContains: heldValues,
  to: heldValues,
  listId: heldValues,
  subjectContains: heldValues,
  facts: RuleFacts.optional(),
});

/** The facts For review and Activity can be narrowed by (`?fact=`), each a condition on what sift recorded about the message. */
export const FACT_FILTERS = {
  reply: { isReply: true },
  list: { listId: true },
  'one-click': { unsubscribe: 'one-click' },
  'bulk-service': { bulkService: true },
  'not-to-you': { addressed: 'neither' },
  unproven: { dmarc: ['fail', 'none'] },
  attachments: { hasAttachments: true },
} as const satisfies Record<string, Conditions>;
export type FactFilter = keyof typeof FACT_FILTERS;
export const FACT_FILTER_KEYS = Object.keys(FACT_FILTERS) as FactFilter[];
const answered = z.object({ reviewed: z.number(), right: z.number() });

/** What was done in Gmail on a day: changes that stand, by what they did. */
export const DayChanges = z.object({
  archive: z.number(),
  spam: z.number(),
  keep: z.number(),
});
export type DayChanges = z.infer<typeof DayChanges>;

export const DecisionRow = z.object({
  id: z.number(),
  accountId: z.string(),
  messageId: z.string(),
  decidedAt: z.number(),
  receivedAt: z.number(),
  stage,
  disposition: z.string(),
  /** What sift said the mail is, or null if it could not place it. */
  labelId: z.string().nullable(),
  labelName: z.string().nullable(),
  gmailLabel: z.string().nullable(),
  /** The decision also says to unsubscribe. */
  unsubscribe: z.boolean(),
  reason: held,
  confidence: z.number().nullable(),
  model: z.string().nullable(),
  costUsd: z.number(),
  fromAddress: held,
  fromName: held.nullable(),
  subject: held,
  /** To be carried out in Gmail. Otherwise a suggestion, recorded only. */
  carryOut: z.boolean(),
  /** Null for a suggestion, and while a decision to carry out is waiting for a pass. */
  outcome: z.string().nullable(),
  /** Why Sift left it alone (`skipped`), in its own words. Never an error's. */
  outcomeDetail: z.string().nullable(),
  actionId: z.number().nullable(),
  actionStatus: z.string().nullable(),
  /** The user's own answer, not sift's decision. */
  byUser: z.boolean(),
});
export type DecisionRow = z.infer<typeof DecisionRow>;

/** How the owner and a sender know each other (`contactOf`, src/store/senders.ts). Null for everyone in between. */
const Contact = z.enum(['new', 'mutual', 'one-way']).nullable();
export type Contact = z.infer<typeof Contact>;

/** A decision in a list, with how its sender and the owner know each other. */
const ListedDecision = DecisionRow.extend({ contact: Contact });
export type ListedDecision = z.infer<typeof ListedDecision>;

/** Mail Sift took out of the inbox, and the seconds that saved the reader (`saved`, src/dashboard/queries/saved.ts). */
export const Saved = z.object({ messages: z.number(), seconds: z.number() });
export type Saved = z.infer<typeof Saved>;

export const Summary = z.object({
  days: z.number(),
  accounts: z.array(z.object({ email: z.string(), lastSyncedAt: z.number().nullable() })),
  totals: z.object({
    /** Messages received in the window. */
    messages: z.number(),
    /** Messages sift first decided in the window. */
    decided: z.number(),
    /** Of those, how many it decided without a model. */
    withoutInference: z.number(),
    /** Messages the model was asked about in the window, whatever came of it: what `costUsd` paid for. */
    judged: z.number(),
    costUsd: z.number(),
    /** Recorded messages with no decision yet (all time). */
    awaitingTriage: z.number(),
  }),
  /** Messages by the tier that first decided them, with what that cost. */
  byStage: z.array(z.object({ stage, decisions: z.number(), costUsd: z.number(), tokens: z.number() })),
  byDisposition: z.array(z.object({ disposition: z.string(), decisions: z.number() })),
  /** One entry per day in the window, oldest first, with a count for every stage. */
  daily: z.array(
    z.object({
      day: z.string(),
      counts: z.record(stage, z.number()),
      changes: DayChanges,
      costUsd: z.number(),
      /** Of the mail counted, how much was the label asked about. */
      labelled: z.number().optional(),
    }),
  ),
  topSenders: z.array(z.object({ address: held, messages: z.number(), lastDisposition: z.string().nullable() })),
  /**
   * What Sift took out of the inbox in the window, less the digests it put back, by the label it gave, most first;
   * and the senders it unsubscribed from, with what they sent in the month before.
   */
  saved: Saved.extend({
    byLabel: z.array(z.object({ labelId: z.string().nullable(), labelName: z.string().nullable(), messages: z.number() })),
    unsubscribed: z.object({ senders: z.number(), monthly: z.number() }),
  }),
  /** The ten latest decisions in the window. */
  recent: z.array(ListedDecision),
  /**
   * How often sift's suggestion was what the user wanted, from the answers given in the window. Answers
   * to mail sift could not place are not counted.
   */
  accuracy: z.object({
    reviewed: z.number(),
    right: z.number(),
    /** Every tier, in cascade order. */
    byStage: z.array(z.object({ stage, reviewed: z.number(), right: z.number() })),
    /** Per label sift gave, most answers first. */
    byLabel: z.array(z.object({ labelId: z.string(), labelName: z.string(), reviewed: z.number(), right: z.number() })),
    /** What sift called one label when the user said another, commonest first. */
    confusion: z.array(z.object({ suggested: z.string(), correct: z.string(), count: z.number() })),
  }),
});
export type Summary = z.infer<typeof Summary>;

/** GET /api/usage: what the model cost, in dollars, over the last day, week and 30 days; `daily` is those 30 days, oldest first. */
export const Usage = z.object({
  day: z.number(),
  week: z.number(),
  month: z.number(),
  daily: z.array(z.number()),
  /** What Sift took out of the inbox over the same windows; `daily` in seconds. `wouldHave`: 30 days of what it would have, had it been on. */
  saved: z.object({ day: Saved, week: Saved, month: Saved, daily: z.array(z.number()), wouldHave: Saved }),
});
export type Usage = z.infer<typeof Usage>;

/** GET /api/decisions: a page of decisions, and how many match in all. */
export const DecisionPage = z.object({ total: z.number(), rows: z.array(ListedDecision) });
export type DecisionPage = z.infer<typeof DecisionPage>;

const authentication = z.enum(['pass', 'fail', 'none']);

/** What sift checked about one message. Mirrors `Facts` in src/triage/facts.ts, which says what each means. */
const MessageFactSet = z.object({
  unsubscribe: z.enum(['none', 'header', 'one-click']),
  listId: held.nullable(),
  markedBulk: z.boolean(),
  autoGenerated: z.boolean(),
  dmarc: authentication,
  spf: authentication,
  dkim: authentication,
  bulkService: z.string().nullable(),
  replyToDiffers: z.boolean(),
  addressed: z.enum(['to', 'cc', 'neither']),
  isReply: z.boolean(),
  category: z.enum(['personal', 'social', 'promotions', 'updates', 'forums']).nullable(),
  /** Absent for mail recorded before sift read it. */
  important: z.boolean().optional(),
  /** These five are known only once a model has been asked about the message; the last four only for mail with HTML. */
  hasAttachments: z.boolean().optional(),
  trackingPixel: z.boolean().optional(),
  linkHosts: z.number().optional(),
  trackedLinks: z.boolean().optional(),
  linksOffDomain: z.boolean().optional(),
  /** Known only for a reply a model has been asked about. */
  earlierInThread: z.number().optional(),
  ownerInThread: z.boolean().optional(),
});
type MessageFactSet = z.infer<typeof MessageFactSet>;

/** What sift knows about one sender, or about everyone at one domain, to judge their mail by. */
/** A standing the owner gives a sender or domain: a rule for exactly them that says only what happens to their mail. */
export const Given = z.enum(GIVEN);
export type Given = z.infer<typeof Given>;

export const SenderProfile = z.object({
  /** An address, or for a domain's profile the domain. */
  address: held,
  contact: Contact,
  /** What the owner's own rule for exactly them says, given on their page. */
  given: Given.nullable(),
  lastSeenAt: z.number().nullable(),
  /** Messages in the last 30 days. */
  recent: z.number(),
  /** Their mail Sift took out of the inbox, ever. */
  saved: Saved,
  /** For a domain: how many addresses have written from it. */
  senders: z.number(),
  /** The owner's answers about their mail. */
  answers: z.object({ right: z.number(), wrong: z.number() }),
  /** The sender's domain. Null for a domain's own profile and for a domain anyone can get an address at. */
  domain: z.object({ name: held, contact: Contact }).nullable(),
  /** Messages recorded from this address. */
  messages: z.number(),
  firstSeenAt: z.number().nullable(),
  /** Whether the account owner has ever written to this address. Null if that has not been checked. */
  userHasWritten: z.boolean().nullable(),
  /** What this sender's mail currently is, by label, most first. */
  labels: z.array(z.object({ id: z.string(), name: z.string(), messages: z.number() })),
  /** Rules that name this sender or their domain. */
  rules: z.array(
    z.object({
      id: z.string(),
      match: heldMatch,
      name: held.nullable(),
      labelId: z.string().nullable(),
      labelName: z.string().nullable(),
      disposition: z.string().nullable(),
      source: z.string(),
      kind: ruleKind,
      when: z.string().nullable(),
    }),
  ),
});
export type SenderProfile = z.infer<typeof SenderProfile>;

const address = z.object({ address: held, name: held.optional() });

export const MessageDetail = z.object({
  accountId: z.string(),
  messageId: z.string(),
  fromAddress: held,
  fromName: held.nullable(),
  to: z.array(address),
  cc: z.array(address),
  subject: held,
  receivedAt: z.number(),
  /** Triage headers as synced. */
  headers: z.record(z.string(), held),
  /**
   * The readable text, where sift holds it: while the message is waiting on the user (and sift would move it or
   * could not place it), or for good once the user has answered for it. Null otherwise. Its HTML is held with it.
   */
  body: held.nullable(),
  /** Whether sift holds its HTML, beside the text, to show in a frame (`/api/message/html`). */
  hasHtml: z.boolean(),
  facts: MessageFactSet,
  sender: SenderProfile,
  /**
   * Whether sift could leave the list this message came from. `available`: yes, with one request to the sender.
   * `done`: it already has. `manual`: the message has an unsubscribe link sift will not use (it needs an
   * email sent or a page opened, or the message did not prove who sent it). `none`: it offers no way.
   */
  unsubscribe: z.enum(['available', 'done', 'manual', 'none']),
  /** Every decision made about this message, oldest first. */
  decisions: z.array(
    DecisionRow.extend({
      ruleId: z.string().nullable(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      durationMs: z.number().nullable(),
      /** What the user said this message is, where they answered for this decision; it beats the decision. */
      answer: z.object({ labelId: z.string().nullable(), disposition: z.string() }).nullable(),
    }),
  ),
  /** Every mailbox change made to this message, oldest first. */
  actions: z.array(
    z.object({
      id: z.number(),
      type: z.string(),
      status: z.string(),
      added: z.array(held),
      removed: z.array(held),
      createdAt: z.number(),
    }),
  ),
});
export type MessageDetail = z.infer<typeof MessageDetail>;

/**
 * What a sender's or domain's next message gets (`nextOf`, src/dashboard/queries/contacts.ts): what the rule for all their
 * mail does (`ruleId`), or else what their mail has been, the reader's answers included; `usually` when it is of several kinds.
 */
const NextMail = z.object({
  labelId: z.string().nullable(),
  labelName: z.string().nullable(),
  disposition: z.string(),
  usually: z.boolean(),
  ruleId: z.string().nullable(),
});
export type NextMail = z.infer<typeof NextMail>;

/** GET /api/sender and /api/domain. */
export const SenderPage = z.object({
  kind: z.enum(['sender', 'domain']),
  /** The name the sender last used. */
  name: held.nullable(),
  profile: SenderProfile,
  next: NextMail,
  /** For an address that sends under more than one name: each name (null for mail with none), most mail first, with what its mail is by label. */
  names: z.array(
    z.object({
      name: held.nullable(),
      messages: z.number(),
      lastSeenAt: z.number(),
      labels: z.array(z.object({ id: z.string(), name: z.string(), messages: z.number() })),
      /** Mail a rule gave no label, only an action. */
      actions: z.array(z.object({ action: z.string(), messages: z.number() })),
    }),
  ),
  /** For a domain: who writes from it, most mail first. */
  senders: z.array(z.object({ address: held, name: held.nullable(), messages: z.number(), lastSeenAt: z.number(), contact: Contact })),
  /** Their mail, newest first. */
  decisions: z.array(ListedDecision),
});
export type SenderPage = z.infer<typeof SenderPage>;

/** GET /api/contacts: everyone the person has mail from, newest first, a page of them and how many match in all. */
export const ContactPage = z.object({
  total: z.number(),
  rows: z.array(
    z.object({
      address: held,
      /** The name on their newest message. */
      name: held.nullable(),
      contact: Contact,
      given: Given.nullable(),
      /** Rules that name them or their domain. */
      rules: z.number(),
      next: NextMail,
      /** Messages in the last 30 days. */
      recent: z.number(),
      lastSeenAt: z.number(),
    }),
  ),
});
export type ContactPage = z.infer<typeof ContactPage>;

/** One sender's mail that is waiting on the user. GET /api/suggestion. */
export const SuggestionDetail = z.object({
  messages: z.array(
    z.object({
      accountId: z.string(),
      decisionId: z.number(),
      messageId: z.string(),
      subject: held,
      receivedAt: z.number(),
      labelId: z.string().nullable(),
    }),
  ),
});
export type SuggestionDetail = z.infer<typeof SuggestionDetail>;

/** A rule's standing as a Gmail filter, which runs in Gmail itself and so applies when sift is off. */
export const RuleFilter = z.object({
  /**
   * `none`: not in Gmail. `active`: sift wrote it and it is still there. `changed`: it was edited in Gmail,
   * and sift leaves it alone. `gone`: it was deleted in Gmail. `outdated`: the rule no longer says what the
   * filter does; sift replaces or removes it once it is on. `RuleSummary.filterId` says whether Gmail still has one.
   */
  state: z.enum(['none', 'active', 'changed', 'gone', 'outdated']),
  /** Whether the rule as it stands can be written as a filter. */
  possible: z.boolean(),
  /** Why not, in a sentence. */
  reason: z.string().nullable(),
  /** The filter Gmail would hold, when it can be one: to show before the user asks for it. */
  plan: z
    .object({
      criteria: z.object({ from: held.optional(), to: held.optional(), subject: held.optional() }),
      /** The Gmail label it applies, by name. */
      gmailLabel: z.string().optional(),
      archive: z.boolean(),
    })
    .nullable(),
  /** Where Gmail will not do exactly what the rule does. To show before the user asks for the filter. */
  differs: z.array(z.string()),
  /** When sift last compared it with Gmail. */
  checkedAt: z.number().nullable(),
  /** Each time sift wrote the filter to a mailbox's Gmail (`filter`) or took it out, and how that went, oldest first: one press is one per mailbox. */
  history: z.array(z.object({ type: z.enum(['filter', 'unfilter']), status: z.string(), error: z.string().nullable(), at: z.number(), mailbox: z.string() })),
});
export type RuleFilter = z.infer<typeof RuleFilter>;

export const RuleSummary = z.object({
  id: z.string(),
  match: heldMatch,
  except: z.array(heldMatch),
  /**
   * `label`: the mail is `labelId`, and that label's action applies unless the rule has its own.
   * `action`: only what happens, whatever the mail is. `when-label`: what happens once a tier has said
   * the mail is `whenLabel`.
   */
  kind: ruleKind,
  /** What the user calls it, said in place of its conditions. */
  name: held.nullable(),
  labelId: z.string().nullable(),
  whenLabel: z.string().nullable(),
  /** The name of the label the rule names or waits for. Null for an `action` rule. */
  labelName: z.string().nullable(),
  /** The rule's own action. For a `label` rule it is an exception to the label's. */
  override: z.string().nullable(),
  /** What happens to mail the rule decides: its own action, else its label's. */
  disposition: z.string().nullable(),
  /** Extras for mail the rule matches, from the rule or its label. */
  markRead: z.boolean(),
  unsubscribe: z.boolean(),
  /** A plain-language condition only the model can apply. */
  when: z.string().nullable(),
  /** `user`: written by the user. `correction`: made by correcting sift. `learned`: made by sift when it blocked the sender. */
  source: z.string(),
  hits: z.number(),
  lastHitAt: z.number().nullable(),
  /** Model calls that checked the rule's condition over the last 30 days, met or not, and what they cost in dollars. */
  checks: z.number(),
  checkCost: z.number(),
  /** The rule's filter in Gmail, while there is one. */
  filterId: z.string().nullable(),
  filter: RuleFilter,
  createdAt: z.number(),
});
export type RuleSummary = z.infer<typeof RuleSummary>;

const InboxMessage = z.object({ accountId: z.string(), messageId: z.string(), subject: held, receivedAt: z.number() });

/**
 * What a rule decided and Sift has not moved: the newest of them, and how many in all. `applying`: how far
 * applying it to the inbox has got (`listed` false: still finding them, so `total` is how many so far).
 */
export const RuleWaiting = z.object({
  total: z.number(),
  messages: z.array(InboxMessage),
  applying: z.object({ listed: z.boolean(), done: z.number(), total: z.number() }).nullable(),
});
export type RuleWaiting = z.infer<typeof RuleWaiting>;

/**
 * What a rule decided each day, oldest first: `changed` was carried out in Gmail, `left` was not (Sift was
 * off, or it never landed). `costUsd` is the model calls that checked its condition that day, met or not.
 */
export const RuleUsage = z.object({
  daily: z.array(z.object({ day: z.string(), changed: z.number(), left: z.number(), costUsd: z.number() })),
  /** Of what it decided in those 30 days, what it took out of the inbox. */
  saved: Saved,
});
export type RuleUsage = z.infer<typeof RuleUsage>;

/**
 * What applying a rule to the inbox would do, from the newest mail Gmail finds for it: those examples, and how
 * many it would decide (`exact`, or scaled from them), of which `reading` a model must read first. `most`: how
 * many one press goes through, when more match than that. `costEach`: one model call with the person's model, in dollars, when known.
 */
export const RuleInbox = z.object({
  examples: z.array(InboxMessage),
  messages: z.number(),
  reading: z.number(),
  exact: z.boolean(),
  most: z.number().nullable(),
  costEach: z.number().nullable(),
});
export type RuleInbox = z.infer<typeof RuleInbox>;

/** What Sift thinks of a message: its current decision, as For review's rows and Inbox's show it. */
const Thinks = z.object({
  decisionId: z.number(),
  /** What sift would do. `review` without a label means it could not place the mail. */
  disposition: z.string(),
  /** What sift says the mail is, or null if it could not place it. */
  labelId: z.string().nullable(),
  labelName: z.string().nullable(),
  /** Which tier decided, and how sure a model was (0 to 1); null when no model was asked. */
  stage,
  confidence: z.number().nullable(),
});

/** One waiting suggestion: what sift proposes for one message, which the user has not answered. */
export const SuggestionItem = z.object({
  accountId: z.string(),
  messageId: z.string(),
  sender: held,
  senderName: held.nullable(),
  contact: Contact,
  subject: held,
  receivedAt: z.number(),
  ...Thinks.shape,
  /**
   * What else it might be, most likely first: the labels the sender's other mail has had, with the share
   * of it each had. Until the model ranks its own guesses, this is the best second opinion sift holds.
   */
  alternatives: z.array(z.object({ id: z.string(), name: z.string(), share: z.number() })),
  /** The start of the message's text, on one line, where sift holds it: enough to tell what it is without opening it. */
  preview: held.nullable(),
});
export type SuggestionItem = z.infer<typeof SuggestionItem>;

/** A rule Sift thinks is worth having, for the user to accept or dismiss. */
const ProposalSummary = z.object({
  id: z.number(),
  accountId: z.string(),
  match: heldMatch,
  labelId: z.string(),
  labelName: z.string(),
  /** What the user has been doing to the label's mail, which the rule would do. */
  disposition: z.string(),
  /** What the label does. */
  labelDisposition: z.string(),
  /** How many decisions in a row it rests on. */
  agreed: z.number(),
});
type ProposalSummary = z.infer<typeof ProposalSummary>;

export const Suggestions = z.object({
  /** Newest first. */
  items: z.array(SuggestionItem),
  proposals: z.array(ProposalSummary),
  /** Messages waiting, which can be more than `items` holds. */
  waiting: z.number(),
  /** From the user's answers so far. */
  accuracy: answered,
  /** The labels the user can say something is, with what sift does for each. */
  labels: z.array(z.object({ id: z.string(), name: z.string(), disposition: z.string() })),
  /** Whether Sift is on for the viewer. Off, nothing listed has been done in Gmail. */
  active: z.boolean(),
  /** Sift is going through the inbox, or mail it found there waits for the model: more suggestions are coming. */
  importing: z.boolean(),
});
export type Suggestions = z.infer<typeof Suggestions>;

/** The body of POST /api/feedback: what one message is. It makes no rule; only the rule dialog does. */
export const FeedbackRequest = z.strictObject({
  accountId: z.string(),
  sender: z.string(),
  label: labelId,
  /** What should happen to it. Left out: what the label does. */
  disposition: decided.optional(),
  decisionId: z.int().optional(),
  /** The one message the answer is about, which need not be waiting: this is how a decision already made is corrected. */
  messageId: text(),
});
export type FeedbackRequest = z.infer<typeof FeedbackRequest>;

/** What POST /api/feedback answers. */
export const FeedbackReply = z.object({
  /** Why sift's own change to the corrected message could not be taken back in Gmail. The answer is saved either way. */
  notFixed: z.string().nullable(),
});
export type FeedbackReply = z.infer<typeof FeedbackReply>;

const party = z.strictObject({ address: text(320), name: text().optional() });
const sending = {
  /** The mailbox that sends it. */
  accountId: text(),
  /** Its Message-ID, made by the page once for the press of Send and given again when that press is tried again, so it goes once. */
  id: text(),
  /** That mailbox's address or one of its aliases. */
  from: party,
  to: z.array(party).max(100),
  cc: z.array(party).max(100),
  text: z.string().max(200_000),
};

/**
 * The body of POST /api/mail/send: what the person wrote. A reply names the message it answers, in the same mailbox; its
 * subject, conversation and the Message-IDs it follows are read from the record, not sent.
 */
export const SendRequest = z.union([
  z.strictObject({ ...sending, subject: z.string().max(900) }),
  z.strictObject({ ...sending, replyTo: z.strictObject({ messageId: text() }) }),
]);
export type SendRequest = z.infer<typeof SendRequest>;

/** A label: what mail is, and what sift does with it. */
export const LabelSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  /** What sift does with it: `keep`, `archive`, `spam`, `block` (spam, and the sender's later mail too) or `digest` (archive, and list it once a day). */
  disposition: z.string(),
  /** Also mark the mail read. Only with `keep` and `archive`. */
  markRead: z.boolean(),
  /** Also leave the sender's mailing list, where that can be done safely. */
  unsubscribe: z.boolean(),
  /** Null for Leave in inbox. */
  gmailLabel: z.string().nullable(),
  /** Rules that say mail is this label. */
  rules: z.number(),
  /** Messages whose current decision carries this label. */
  messages: z.number(),
  /** Of the suggestions for this label the user has answered, how many sift had right. */
  record: answered,
});
export type LabelSummary = z.infer<typeof LabelSummary>;

/** A label the model suggested from what the person wants. Nothing is made until they accept it. */
const LabelDraft = z.object({
  name: held,
  description: held,
  disposition: z.enum(DRAFT_ACTIONS),
  markRead: z.literal(true).optional(),
  unsubscribe: z.literal(true).optional(),
  /** Which part of what they asked for it serves. */
  why: held,
});

export const LabelProposal = z.object({
  id: z.number(),
  goal: held,
  drafts: z.array(LabelDraft),
  /** What its labels leave out of what was asked, such as what a label they have covers already. */
  note: held.optional(),
  at: z.number(),
});
export type LabelProposal = z.infer<typeof LabelProposal>;

/** A rule the model filled in from what the person wants, for the rule dialog to show. Nothing is made until they add it. */
export const RuleDraft = z.object({
  match: heldMatch,
  name: held.optional(),
  label: held.optional(),
  whenLabel: held.optional(),
  when: held.optional(),
  disposition: decided.optional(),
  markRead: z.literal(true).optional(),
  unsubscribe: z.literal(true).optional(),
  /** What else they need, or what a rule cannot do. */
  note: held.optional(),
});
export type RuleDraft = z.infer<typeof RuleDraft>;

/**
 * A ChatGPT sign-in waiting on the person: where to go, and by device code the code to enter there.
 * Without a code, it is a Sign in with ChatGPT, finished by pasting back the address it ends on.
 */
export const SignInCode = z.object({ code: z.string().optional(), url: z.string(), expiresAt: z.number() });
export type SignInCode = z.infer<typeof SignInCode>;

/** Going through the viewer's inboxes: where it has got, all mailboxes together, or how it went last. */
const InboxProgress = z.object({
  /** `listed` false: still reading what is in the inbox, so `total` is what has been found so far. `spent` in dollars. */
  going: z.object({ listed: z.boolean(), done: z.number(), total: z.number(), spent: z.number(), startedAt: z.number() }).nullable(),
  /** `total`: how many it went through, which is fewer than were there when it was stopped. */
  last: z.object({ finishedAt: z.number(), total: z.number(), spent: z.number(), stopped: z.boolean() }).nullable(),
});

/** GET /api/inbox: what going through the viewer's inboxes would take. */
export const InboxEstimate = z.object({
  messages: z.number(),
  /** Of `messages`, about how many need the model: as many as did lately. */
  model: z.number(),
  /** About what those calls cost, in dollars, through ChatGPT what they would cost through the API; null when the price is not known. */
  cost: z.number().nullable(),
});
export type InboxEstimate = z.infer<typeof InboxEstimate>;

/** Which conversations Inbox lists: all, those Sift would leave in the inbox or could not place, or those it would move out. */
export const MAIL_VIEWS = ['all', 'needs', 'sorted'] as const;
export type MailView = (typeof MAIL_VIEWS)[number];

/** GET /api/mail/threads: one conversation with mail in the inbox now. */
export const MailThread = z.object({
  accountId: z.string(),
  threadId: z.string(),
  /** Its newest message's. */
  subject: held,
  /** Who wrote the messages Sift has of it, oldest first, each once: a name, or the address of a sender without one; the reader's own mailboxes as "me". */
  who: z.array(held),
  /** The messages Sift has recorded of it, oldest first; the newest is the one the reader opens. Sync records mail that arrives, not what the person sent. */
  messageIds: z.array(z.string()),
  unread: z.boolean(),
  newestAt: z.number(),
  /** Where it is, for a search that looks past the inbox: in it, out of it, or only what the person sent. */
  place: z.enum(['inbox', 'archived', 'sent']),
  /** The start of its newest message's text, on one line, where Sift holds it. */
  preview: held.nullable(),
  /** About its newest message; null when Sift has not decided it. */
  thinks: Thinks.nullable(),
});
export type MailThread = z.infer<typeof MailThread>;

export const MailThreads = z.object({
  /** Newest first. */
  threads: z.array(MailThread),
  /** Where the next page starts, for `before`; null at the end. A search may give fewer than a page and still have more. */
  next: z.string().nullable(),
});
export type MailThreads = z.infer<typeof MailThreads>;

/** GET /api/mail/thread: the messages Sift has of one conversation, oldest first, each as its folded row shows it. A message's text is `/api/message`'s. */
export const MailConversation = z.object({
  accountId: z.string(),
  threadId: z.string(),
  messages: z.array(
    z.object({
      messageId: z.string(),
      fromAddress: held,
      fromName: held.nullable(),
      receivedAt: z.number(),
      unread: z.boolean(),
      preview: held.nullable(),
    }),
  ),
});
export type MailConversation = z.infer<typeof MailConversation>;

/** The body of POST /api/mail/change: the person's own press on messages in their inbox. */
export const MailChange = z.strictObject({
  accountId: z.string(),
  messageIds: z.array(z.string().min(1).max(200)).min(1).max(200),
  change: z.enum(['archive', 'read', 'unread']),
});
export type MailChange = z.infer<typeof MailChange>;

/** POST /api/mail/ask: the person's words as a filter on Inbox's list, each part of it one the list takes, or why there is none. Held as it is stored. */
export const MailAsk = z.union([
  z.object({
    filter: z.object({
      from: heldValues,
      domain: heldValues,
      label: held.optional(),
      view: z.enum(['needs', 'sorted']).optional(),
      unread: z.literal(true).optional(),
      /** `YYYY-MM-DD`, in the reader's days. */
      since: held.optional(),
      /** Words for Inbox's search, which the page puts in it. */
      words: heldValues,
    }),
    /** What of their words it leaves out. */
    note: held.optional(),
  }),
  z.object({ cannot: held }),
]);
export type MailAsk = z.infer<typeof MailAsk>;

/** Which of the newest messages a press goes through: the whole inbox, or enough to teach with. */
export const InboxReach = z.enum(['inbox', 'recent']);

/** How far back Inbox keeps the viewer's mail. */
export const MailWindow = z.enum(MAIL_WINDOWS);

/** GET /api/mail/reach: for each window, about how many messages copying it reads from Gmail, what they take to keep, in bytes, and how long reading them takes. */
const Reach = z.object({ messages: z.number(), bytes: z.number(), minutes: z.number() });
export const MailReach = z.object({ year: Reach, three_years: Reach, all: Reach });
export type MailReach = z.infer<typeof MailReach>;

/** GET /api/manage: everything the Settings view shows. */
export const ManageState = z.object({
  /** Whether the viewer owns the install, and so may change what applies to all of it. */
  owner: z.boolean(),
  /** Whether sift is on for the viewer. Off, it only suggests for their mail; on, it carries its decisions out in Gmail. */
  active: z.boolean(),
  /** Whether Inbox is on for the viewer: Sift keeps a copy of their mail, and may send as them. */
  mail: z.boolean(),
  mailWindow: MailWindow,
  /** Copying the viewer's mailboxes for Inbox, all of them together: `total` is Gmail's estimate. Null when none is going. */
  copying: z.object({ done: z.number(), total: z.number(), startedAt: z.number() }).nullable(),
  /** The viewer's own model: which one they chose, how they can reach one, and a ChatGPT sign-in under way. */
  model: z.object({
    chosen: z.string().nullable(),
    reasoning: z.enum(REASONING),
    choices: z.array(z.object({ provider: z.string(), label: z.string(), how: z.enum(['device-code', 'redirect', 'key']) })),
    signedIn: z.array(z.string()),
    pending: z.union([SignInCode, z.object({ error: z.string() })]).nullable(),
  }),
  activity: z.object({ running: z.boolean(), lastPassAt: z.number().nullable(), problems: z.array(z.string()), expired: z.array(z.string()) }),
  /** `canSend`: Google let Sift send from it (`/auth/login?grant=send&mailbox=…` asks). `aliases`: its other addresses in Gmail, which it may send as. */
  accounts: z.array(
    z.object({
      id: z.string(),
      email: z.string(),
      lastSyncedAt: z.number().nullable(),
      primary: z.boolean(),
      canSend: z.boolean(),
      aliases: z.array(z.string()),
      /** When Google will end its sign-in, known only once one has ended a week after it was given (a client in Testing). */
      signInEnds: z.number().nullable(),
    }),
  ),
  /** In order. */
  labels: z.array(LabelSummary),
  /** How many labels a person may have. */
  labelLimit: z.number(),
  /** Mail waiting on the viewer that Sift would move or could not place: For review's count. */
  waiting: z.number(),
  inbox: InboxProgress,
  /** The hour of the viewer's day a label's digest arrives, and the zone it is read in: null when their browser never said, which is UTC. */
  digest: z.object({ hour: z.number(), timeZone: z.string().nullable() }),
});
export type ManageState = z.infer<typeof ManageState>;

/** GET /api/models: the models the viewer's sign-ins offer. */
export const Models = z.object({
  models: z.array(z.string()),
  /** Per provider, the few to offer before the full list; the first is the one to suggest. */
  shortlist: z.record(z.string(), z.array(z.string())),
  /** Per model, dollars for 1,000 messages at its catalog price, where the catalog has one. */
  costs: z.record(z.string(), z.number()),
  /** A provider could not be reached. */
  error: z.string().optional(),
});
export type Models = z.infer<typeof Models>;

/** GET /api/session. */
export const Session = z.object({
  /** False when this dashboard does not ask for sign-in. */
  required: z.boolean(),
  /** The signed-in account, or null. */
  email: z.string().nullable(),
  canSignIn: z.boolean(),
  /** Why not: no Google client is set up, or Google cannot return to this address. */
  reason: z.enum(['no-client', 'address']).nullable(),
  /** Addresses sign-in works at. */
  addresses: z.array(z.string()),
  /** `SIFT_CLOUD`: this Sift is a service for other people. Someone's own copy has no terms, privacy policy or security page. */
  cloud: z.boolean(),
  /** Where the page sends how long it took and what failed in it: this server's Sentry project. Null when the server sends nothing. */
  telemetry: z.object({ dsn: z.string(), release: z.string().nullable(), environment: z.string().nullable() }).nullable(),
  /** Which build of the page this server came with; null when it was not built with one (tests). */
  build: z.string().nullable(),
});
export type Session = z.infer<typeof Session>;

/** Right, wrong, "unsure" and failed calls among some judged examples. Accuracy is `right / (total - failed)`. */
const EvalTally = z.object({
  total: z.number(),
  right: z.number(),
  wrong: z.number(),
  unsure: z.number(),
  /** Calls that returned nothing usable. Not counted for or against. */
  failed: z.number(),
});
type EvalTally = z.infer<typeof EvalTally>;

const EvalScore = EvalTally.extend({
  /** By the label the user gave, most examples first. */
  byLabel: z.array(EvalTally.extend({ labelId: z.string() })),
  /** Which label was taken for which, commonest first. */
  confusion: z.array(z.object({ expected: z.string(), got: z.string(), count: z.number() })),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  /** Averages over the calls that answered. */
  perMessage: z.object({ costUsd: z.number(), inputTokens: z.number(), outputTokens: z.number() }),
});
type EvalScore = z.infer<typeof EvalScore>;

/** One replay of the model over stored examples. */
const EvalRun = z.object({
  id: z.number(),
  accountId: z.string(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  status: z.enum(['running', 'done', 'failed']),
  error: z.string().nullable(),
  /** What it ran with. Runs that agree on all of these were asked the same question the same way. */
  model: z.string(),
  promptHash: z.string(),
  labelsHash: z.string(),
  labels: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  fewShot: z.boolean(),
  /** Examples in the run. `score.total` is how many have been judged so far. */
  total: z.number(),
  score: EvalScore,
  /** Of the answers, those given with an example from the same sender in the prompt, which makes them easy. */
  withSenderExample: z.object({ answered: z.number(), right: z.number() }),
});
type EvalRun = z.infer<typeof EvalRun>;

/** GET /api/evals. */
export const Evals = z.object({
  /** Newest first. */
  runs: z.array(EvalRun),
  /** Stored examples a run could use, per account. */
  examples: z.record(z.string(), z.number()),
  defaultLimit: z.number(),
  maxLimit: z.number(),
});
export type Evals = z.infer<typeof Evals>;

/** GET /api/eval?id=. */
export const EvalDetail = z.object({
  run: EvalRun,
  results: z.array(
    z.object({
      messageId: z.string(),
      fromAddress: held,
      subject: held,
      /** The user's label. */
      expected: z.string(),
      /** A label id, `unsure`, or null when the call failed. */
      got: z.string().nullable(),
      /** Why the call failed: its status and kind. */
      error: z.string().nullable(),
      confidence: z.number().nullable(),
      inputTokens: z.number(),
      outputTokens: z.number(),
      costUsd: z.number(),
      durationMs: z.number(),
      /** Examples shown beside it, and how many of those were from the same sender. */
      shots: z.number(),
      senderShots: z.number(),
    }),
  ),
});
export type EvalDetail = z.infer<typeof EvalDetail>;

/** The body of POST /api/evals/run. Answers `{ id }`; the run goes on in the background. */
export const EvalRequest = z.strictObject({
  accountId: text(),
  /** Show the model the other stored examples, as a pass always does. Default: true. */
  fewShot: z.boolean().optional(),
  /** How many examples, newest answers first. At most `Evals.maxLimit`. */
  limit: z.int().min(1).optional(),
});
export type EvalRequest = z.infer<typeof EvalRequest>;

/** GET /api/examples: the messages held whole because the user answered for them. No content. */
export const Examples = z.object({
  /** Newest answers first, at most 500. */
  examples: z.array(
    z.object({
      accountId: z.string(),
      messageId: z.string(),
      fromAddress: held,
      fromName: held.nullable(),
      subject: held,
      /** The user's answer. */
      labelId: z.string().nullable(),
      markedAt: z.number(),
      /** `pending`: not fetched yet. `gone`: the message no longer existed, so only the answer is held. */
      status: z.enum(['pending', 'captured', 'gone']),
    }),
  ),
  /** How many are held per account, including any beyond the list. */
  held: z.record(z.string(), z.number()),
});
export type Examples = z.infer<typeof Examples>;

/** What POST /api/mailbox/remove and /api/account/delete answer. */
export const Removed = z.object({
  /** Mailboxes whose access Google could not be reached to revoke. Removed all the same. */
  notRevoked: z.array(z.string()),
  /** Their session has ended. */
  signedOut: z.boolean(),
});
export type Removed = z.infer<typeof Removed>;
