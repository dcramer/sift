/**
 * The database, as Drizzle describes it. Change it here, then `pnpm db:generate` writes the migration
 * (into `src/store/migrations/`); never edit one that has been applied, and never write schema SQL by
 * hand anywhere else.
 *
 * Two kinds of table. `users` and `accounts` say who the people are and which mailboxes are whose, and
 * are read before anyone is known. Every other table holds one person's data: it carries their
 * `user_id`, which the handle sets (src/store/own.ts), and row-level security lets a transaction see and
 * write only that person's rows (src/store/sql.ts). Every key and foreign key between them includes
 * `user_id`, so no row can point at another person's.
 *
 * Deleting is one statement. Deleting a `users` row deletes everything of theirs; deleting an `accounts`
 * row deletes its mailbox and, through it, every row with that `account_id`. Keys into `messages`,
 * `decisions` and `model_runs` do not cascade, so retention has to delete those rows on purpose.
 */
import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { REASONING } from '../model/reasoning.ts';
import { MAIL_WINDOWS } from '../mail-window.ts';
import type { Facts } from '../triage/facts.ts';
import { DECIDED, DISPOSITIONS, LEAVE_IN_INBOX, STAGE_NAMES, SUBSCRIPTION_ACTIONS } from '../triage/types.ts';

export const CREDENTIAL_KINDS = ['gmail', 'model'] as const;
export const DECISION_OUTCOMES = ['none', 'done', 'skipped', 'failed', 'unknown'] as const;
/**
 * `digest`: a digest put into the mailbox, which changes no message Sift recorded. `send`: mail the person sent through Sift.
 * `read` and `unread`: the person's own press in Inbox, as is an `archive` with no decision.
 */
export const ACTION_TYPES = ['archive', 'spam', 'label', 'undo', 'unsubscribe', 'filter', 'unfilter', 'digest', 'send', 'read', 'unread'] as const;
export const ACTION_STATUSES = ['pending', 'done', 'failed', 'unknown', 'undone'] as const;
/** `learned`: sift made it (blocking a sender). */
export const RULE_SOURCES = ['user', 'learned', 'correction'] as const;
/** `changed`: edited in Gmail. `gone`: deleted there. `outdated`: the rule no longer says what the filter does. */
export const FILTER_STATES = ['active', 'changed', 'gone', 'outdated'] as const;
const PROPOSAL_STATUSES = ['open', 'accepted', 'dismissed'] as const;
/** right: sift's suggestion was what they wanted. wrong: it was not. answered: sift had no suggestion. */
export const VERDICTS = ['right', 'wrong', 'answered'] as const;
const FEEDBACK_VIA = ['dashboard', 'gmail'] as const;
export const EXAMPLE_STATUSES = ['pending', 'captured', 'gone'] as const;
export const EVAL_STATUSES = ['running', 'done', 'failed'] as const;

/** What sift's own queries run as: it owns nothing and cannot bypass row-level security. */
export const siftApp = pgRole('sift_app', { createRole: false });

// After a transaction that set it, the setting reads as '' for the rest of the session: that is nobody too.
const OWN = sql`user_id = nullif(current_setting('sift.user', true), '')::integer`;
/** Each person's table: only their rows, read or written. */
const own = () => pgPolicy('own', { for: 'all', to: siftApp, using: OWN, withCheck: OWN });

/** Holds the column to `values`, the same list its TypeScript type comes from. */
const oneOf = (name: string, column: AnyPgColumn, values: readonly string[]): ReturnType<typeof check> =>
  check(name, sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`);

/** Milliseconds since the epoch. */
const time = (name: string) => bigint(name, { mode: 'number' });
const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' });
const id = () => integer('id').primaryKey().generatedByDefaultAsIdentity();
const userId = () =>
  integer('user_id')
    .notNull()
    .default(sql`current_setting('sift.user')::integer`)
    .references((): AnyPgColumn => users.id, { onDelete: 'cascade' });

// Who the people are and which mailboxes are whose.

/** A person. The first owns the install: only they may change what applies to all of it. */
export const users = pgTable(
  'users',
  {
    id: id(),
    owner: boolean('owner').notNull().default(false),
    createdAt: time('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('users_one_owner')
      .on(t.owner)
      .where(sql`${t.owner}`),
  ],
);

/**
 * A mailbox, an identity someone signed in with. Its id is its address. It never changes hands. A person's
 * primary one is who they are, whichever they signed in with.
 */
export const accounts = pgTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: time('created_at').notNull(),
    primary: boolean('primary').notNull().default(false),
  },
  (t) => [
    unique('accounts_own').on(t.userId, t.id),
    uniqueIndex('accounts_one_primary')
      .on(t.userId)
      .where(sql`${t.primary}`),
  ],
);

// One person's data.

/** Their mailboxes, with each one's sync state. */
export const mailboxes = pgTable(
  'mailboxes',
  {
    userId: userId(),
    id: text('id').notNull(),
    // Names the mailbox where its address must not be written: the key of its Workflow runs, which Workflow keeps unencrypted.
    number: integer('number').notNull().unique().generatedByDefaultAsIdentity(),
    historyId: text('history_id'), // Gmail history cursor; null forces a full sync
    lastSyncedAt: time('last_synced_at'),
    filtersCheckedAt: time('filters_checked_at'),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]), // Gmail send-as addresses besides the id, as of the last sync that could read them
    canSend: boolean('can_send').notNull().default(false), // Google granted `gmail.send` to the sign-in Sift holds for it
    signedInAt: time('signed_in_at'), // when its Gmail sign-in was given; null for one given before this was kept
    weeklySignIn: boolean('weekly_sign_in').notNull().default(false), // Google ended its last sign-in a week after it was given: the client is in Testing
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    foreignKey({ columns: [t.userId, t.id], foreignColumns: [accounts.userId, accounts.id] }).onDelete('cascade'),
    own(),
  ],
).enableRLS();

/** Every table with an `account_id` has this key, so removing a mailbox removes its rows. */
const mailbox = (t: { userId: AnyPgColumn; accountId: AnyPgColumn }) =>
  foreignKey({ columns: [t.userId, t.accountId], foreignColumns: [mailboxes.userId, mailboxes.id] }).onDelete('cascade');

/** Their own choices: the model their mail is judged with (`provider/model-id`). */
export const preferences = pgTable(
  'preferences',
  {
    userId: userId().primaryKey(),
    // false (off): their decisions are only suggestions. true (on): sift carries them out in their mailboxes.
    active: boolean('active').notNull().default(false),
    // Inbox: Sift keeps a copy of their mail (`messages`, `mail_bodies`), and may send as them where a mailbox lets it.
    mail: boolean('mail').notNull().default(false),
    // How far back that copy goes.
    mailWindow: text('mail_window', { enum: MAIL_WINDOWS }).notNull().default('year'),
    model: text('model'),
    reasoning: text('reasoning', { enum: REASONING }).notNull().default('low'),
    digestHour: integer('digest_hour').notNull().default(7), // the hour of their day a label's digest arrives
    timeZone: text('time_zone'), // their browser's IANA zone, as last said; null: never said, so UTC
  },
  (t) => [
    check('preferences_digest_hour', sql`${t.digestHour} BETWEEN 0 AND 23`),
    oneOf('preferences_reasoning', t.reasoning, REASONING),
    oneOf('preferences_mail_window', t.mailWindow, MAIL_WINDOWS),
    own(),
  ],
).enableRLS();

/**
 * Their sign-ins, each encrypted for its row (src/secrets.ts). `gmail`: a mailbox's refresh token, by
 * address. `model`: a model provider's credential, by provider id.
 */
export const credentials = pgTable(
  'credentials',
  {
    userId: userId(),
    kind: text('kind', { enum: CREDENTIAL_KINDS }).notNull(),
    key: text('key').notNull(),
    value: text('value').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.kind, t.key] }), oneOf('credentials_kind', t.kind, CREDENTIAL_KINDS), own()],
).enableRLS();

/** Every message sift has seen, without the body: enough to triage it again and show what sift did. */
export const messages = pgTable(
  'messages',
  {
    userId: userId(),
    accountId: text('account_id').notNull(),
    id: text('id').notNull(), // provider message id
    threadId: text('thread_id').notNull(),
    // Who sent it, by keyed hash (src/secrets.ts): what a sender's or domain's mail is found by.
    senderHash: text('sender_hash').notNull(),
    domainHash: text('domain_hash').notNull(),
    receivedAt: time('received_at').notNull(),
    // The headers Gmail was asked for (METADATA_HEADERS), sender, recipients and subject among them, as encrypted JSON (src/store/content.ts).
    headers: text('headers').notNull(),
    // As the last sync read them from Gmail's history; stale for what changed while its cursor had expired (`recovery`).
    labelIds: jsonb('label_ids').$type<string[]>().notNull().default([]),
    syncedAt: time('synced_at').notNull(),
    suggestOnly: boolean('suggest_only').notNull().default(false), // first recorded by an inbox run that only suggests: a pass never carries it out
    applyRule: text('apply_rule'), // pulled in by "Apply to inbox" on this rule: what it decides here is carried out, Sift on or off
    facts: jsonb('facts').$type<Facts>().notNull(),
    readAt: time('read_at'), // when a sync saw the user had opened it
    // A decision has been recorded for it (`recordDecision`), or it is not mail to triage: the person's own, or copied for Inbox
    // (`recordKept`). What is neither is the triage queue, which a tick looks at every minute.
    decided: boolean('decided').notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.accountId, t.id] }),
    mailbox(t),
    index('messages_sender').on(t.accountId, t.senderHash),
    index('messages_domain').on(t.accountId, t.domainHash),
    index('messages_received').on(t.accountId, t.receivedAt),
    index('messages_thread').on(t.userId, t.accountId, t.threadId),
    // What is in the inbox now, newest first: what Inbox lists and what a pass keeps the text of while it is on.
    index('messages_inbox')
      .on(t.accountId, t.receivedAt)
      .where(sql`${t.labelIds} @> '["INBOX"]'::jsonb`),
    index('messages_undecided')
      .on(t.accountId, t.receivedAt)
      .where(sql`NOT ${t.decided}`),
    // Lists narrowed by a fact ask `facts @> {…}`.
    index('messages_facts').using('gin', t.facts),
    own(),
  ],
).enableRLS();

const message = (t: { userId: AnyPgColumn; accountId: AnyPgColumn; messageId: AnyPgColumn }) =>
  foreignKey({ columns: [t.userId, t.accountId, t.messageId], foreignColumns: [messages.userId, messages.accountId, messages.id] });

/** What mail can be, and what sift does with each: the person's, for every mailbox of theirs. */
export const labels = pgTable(
  'labels',
  {
    userId: userId(),
    id: text('id').notNull(), // stable; the name can change without orphaning history
    name: text('name').notNull(),
    description: text('description').notNull(), // how to recognise it; shown to the model
    disposition: text('disposition', { enum: DISPOSITIONS }).notNull(),
    block: boolean('block').notNull().default(false),
    // Archived as it arrives, and listed once a day in one message put into the inbox (`digests`).
    digest: boolean('digest').notNull().default(false),
    markRead: boolean('mark_read').notNull().default(false),
    unsubscribe: boolean('unsubscribe').notNull().default(false),
    gmailLabel: text('gmail_label'), // null only for Leave in inbox
    position: integer('position').notNull(),
    // Kept so what was said of mail stays named; offered to nothing. Adding the name again brings it back.
    removedAt: time('removed_at'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    oneOf('labels_disposition', t.disposition, DISPOSITIONS),
    check('labels_gmail_label', sql`(${t.id} = ${sql.raw(`'${LEAVE_IN_INBOX}'`)}) = (${t.gmailLabel} IS NULL)`),
    check(
      'labels_everything_else_keeps',
      sql`${t.id} <> ${sql.raw(`'${LEAVE_IN_INBOX}'`)} OR (${t.disposition} = 'keep' AND NOT ${t.block} AND NOT ${t.digest} AND NOT ${t.markRead} AND NOT ${t.unsubscribe})`,
    ),
    check('labels_digest_archives', sql`NOT ${t.digest} OR ${t.disposition} = 'archive'`),
    own(),
  ],
).enableRLS();

/** What a row says mail is: one of the person's labels. Labels are never deleted, only removed (`removed_at`). */
const label = (name: string, t: { userId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({ name, columns: [t.userId, column], foreignColumns: [labels.userId, labels.id] });

/** Every call to the model about a message, with what it cost. One that failed reached no decision, so the message is asked about again on a later pass. */
export const modelRuns = pgTable(
  'model_runs',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    messageId: text('message_id').notNull(),
    model: text('model').notNull(),
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'), // null: the pass stopped part-way. An error says it failed; no decision pointing at it says it reached none
    error: text('error'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    retriedAt: time('retried_at'), // the user put the message back in the queue: this failure no longer counts
    ruleId: text('rule_id'), // the rule whose condition in words the call checked, met or not; what that rule costs. Not a key: a removed rule's calls were still paid for
  },
  (t) => [
    unique('model_runs_own').on(t.userId, t.id),
    mailbox(t),
    message(t),
    index('model_runs_message').on(t.accountId, t.messageId),
    index('model_runs_time').on(t.accountId, t.startedAt),
    // A rule is the person's, so its calls are asked for across their mailboxes.
    index('model_runs_rule')
      .on(t.userId, t.ruleId, t.startedAt)
      .where(sql`${t.ruleId} IS NOT NULL`),
    own(),
  ],
).enableRLS();

/** An append-only log: a message can be decided more than once, and the highest id is current. */
export const decisions = pgTable(
  'decisions',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    messageId: text('message_id').notNull(),
    stage: text('stage', { enum: STAGE_NAMES }).notNull(),
    disposition: text('disposition', { enum: DISPOSITIONS }).notNull(),
    subscription: text('subscription', { enum: SUBSCRIPTION_ACTIONS }).notNull(),
    labelId: text('label_id'),
    block: boolean('block').notNull().default(false),
    digest: boolean('digest').notNull().default(false), // archived to be listed in its label's next digest
    markRead: boolean('mark_read').notNull().default(false),
    ruleId: text('rule_id'),
    confidence: doublePrecision('confidence'),
    reason: text('reason').notNull(), // encrypted: it names the rule's sender and says what the model read (src/store/content.ts)
    runId: integer('run_id'), // the model call that reached it; null when no model was asked
    durationMs: integer('duration_ms'),
    decidedAt: time('decided_at').notNull(),
    // false: a suggestion, recorded only. true: to be carried out in Gmail; outcome is null until it has been.
    carryOut: boolean('carry_out').notNull().default(false),
    outcome: text('outcome', { enum: DECISION_OUTCOMES }),
    outcomeDetail: text('outcome_detail'),
    // The user's own answer, from the dashboard or from what they did in Gmail. Carried out even while sift is off.
    byUser: boolean('by_user').notNull().default(false),
  },
  (t) => [
    unique('decisions_own').on(t.userId, t.id),
    mailbox(t),
    message(t),
    label('decisions_label', t, t.labelId),
    foreignKey({ columns: [t.userId, t.runId], foreignColumns: [modelRuns.userId, modelRuns.id] }),
    oneOf('decisions_stage', t.stage, STAGE_NAMES),
    oneOf('decisions_disposition', t.disposition, DISPOSITIONS),
    oneOf('decisions_subscription', t.subscription, SUBSCRIPTION_ACTIONS),
    oneOf('decisions_outcome', t.outcome, DECISION_OUTCOMES),
    check('decisions_settled_if_carried_out', sql`${t.carryOut} OR ${t.outcome} IS NULL`),
    check('decisions_digest_archives', sql`NOT ${t.digest} OR ${t.disposition} = 'archive'`),
    index('decisions_message').on(t.accountId, t.messageId, t.id),
    index('decisions_time').on(t.accountId, t.decidedAt),
    index('decisions_run').on(t.userId, t.runId),
    // A rule is the person's, so what it decided is asked for across their mailboxes.
    index('decisions_rule')
      .on(t.userId, t.ruleId, t.decidedAt)
      .where(sql`${t.ruleId} IS NOT NULL`),
    // What the next digest of a label lists is looked for every minute until it goes.
    index('decisions_digest')
      .on(t.userId, t.labelId)
      .where(sql`${t.digest}`),
    index('decisions_unsettled')
      .on(t.accountId)
      .where(sql`${t.carryOut} AND ${t.outcome} IS NULL`),
    own(),
  ],
).enableRLS();

const decision = (t: { userId: AnyPgColumn; decisionId: AnyPgColumn }) =>
  foreignKey({ columns: [t.userId, t.decisionId], foreignColumns: [decisions.userId, decisions.id] });

/** The audit log. Intent is written before the provider call and the outcome after read-back, so every change can be undone. */
export const actions = pgTable(
  'actions',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    messageId: text('message_id'),
    decisionId: integer('decision_id'), // null for changes made by hand and for undos
    type: text('type', { enum: ACTION_TYPES }).notNull(),
    payload: text('payload').notNull(), // encrypted JSON: an unsubscribe's host and a filter's criteria name senders (src/store/content.ts)
    originalLabels: jsonb('original_labels').$type<string[]>().notNull(), // as read immediately before
    finalLabels: jsonb('final_labels').$type<string[]>(), // as read back afterwards
    status: text('status', { enum: ACTION_STATUSES }).notNull(),
    error: text('error'),
    createdAt: time('created_at').notNull(),
    completedAt: time('completed_at'),
  },
  (t) => [
    mailbox(t),
    message(t),
    decision(t),
    oneOf('actions_type', t.type, ACTION_TYPES),
    oneOf('actions_status', t.status, ACTION_STATUSES),
    // Led by user_id, as the other tables' keys are, for deleting a person.
    index('actions_message').on(t.userId, t.accountId, t.messageId),
    index('actions_time').on(t.accountId, t.createdAt),
    index('actions_open')
      .on(t.status)
      .where(sql`${t.status} IN ('pending', 'unknown')`),
    index('actions_decision').on(t.decisionId),
    // A rule's filter history is read across the person's mailboxes.
    index('actions_filters')
      .on(t.userId, t.accountId, t.id)
      .where(sql`${t.type} IN ('filter', 'unfilter')`),
    own(),
  ],
).enableRLS();

/**
 * Conditions, then what mail is (label_id), what happens to it (disposition), or both; with when_label,
 * what happens only once a tier has said it is that label. The person's, for every mailbox of theirs.
 */
export const rules = pgTable(
  'rules',
  {
    userId: userId(),
    id: text('id').notNull(),
    position: integer('position').notNull(),
    // Conditions name senders, so they are encrypted JSON (src/store/content.ts), found by the keyed hash of both.
    match: text('match').notNull(),
    except: text('except_matches').notNull(),
    conditions: text('conditions').notNull(),
    name: text('name'), // what the user calls it, encrypted JSON: it may name senders
    labelId: text('label_id'),
    whenLabel: text('when_label'),
    disposition: text('disposition', { enum: DECIDED }),
    subscription: text('subscription', { enum: SUBSCRIPTION_ACTIONS }).notNull().default('preserve'),
    markRead: boolean('mark_read').notNull().default(false),
    condition: text('condition'), // a condition in the user's words; needs label_id
    source: text('source', { enum: RULE_SOURCES }).notNull(),
    hits: integer('hits').notNull().default(0),
    createdAt: time('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.id] }),
    label('rules_label', t, t.labelId),
    label('rules_when_label', t, t.whenLabel),
    oneOf('rules_disposition', t.disposition, DECIDED),
    oneOf('rules_subscription', t.subscription, SUBSCRIPTION_ACTIONS),
    oneOf('rules_source', t.source, RULE_SOURCES),
    check('rules_says_something', sql`${t.labelId} IS NOT NULL OR ${t.whenLabel} IS NOT NULL OR ${t.disposition} IS NOT NULL`),
    check('rules_label_or_wait', sql`${t.labelId} IS NULL OR ${t.whenLabel} IS NULL`),
    check('rules_condition_needs_label', sql`${t.condition} IS NULL OR ${t.labelId} IS NOT NULL`),
    index('rules_order').on(t.userId, t.position),
    own(),
  ],
).enableRLS();

/** A rule's Gmail filter in one mailbox. A rule is the person's; each of their mailboxes keeps its own filters. */
export const ruleFilters = pgTable(
  'rule_filters',
  {
    userId: userId(),
    ruleId: text('rule_id').notNull(),
    accountId: text('account_id').notNull(),
    filterId: text('filter_id'), // the filter in Gmail, while there is one
    state: text('state', { enum: FILTER_STATES }),
    // What each side last said, as src/actions/rule-filters.ts keeps it: encrypted JSON.
    written: text('written'),
    checkedAt: time('checked_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.ruleId, t.accountId] }),
    foreignKey({ columns: [t.userId, t.ruleId], foreignColumns: [rules.userId, rules.id] }).onDelete('cascade'),
    mailbox(t),
    oneOf('rule_filters_state', t.state, FILTER_STATES),
    own(),
  ],
).enableRLS();

/** Rules sift thinks are worth having, waiting on the user. */
export const proposals = pgTable(
  'proposals',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    match: text('match').notNull(), // encrypted, and found by its keyed hash, as a rule's
    conditions: text('conditions').notNull(),
    labelId: text('label_id').notNull(),
    disposition: text('disposition', { enum: DECIDED }).notNull(), // what the rule does to the label's mail, which the label would not
    agreed: integer('agreed').notNull(), // how many decisions in a row it rests on
    status: text('status', { enum: PROPOSAL_STATUSES }).notNull().default('open'),
    createdAt: time('created_at').notNull(),
    resolvedAt: time('resolved_at'),
  },
  (t) => [
    mailbox(t),
    label('proposals_label', t, t.labelId),
    unique('proposals_once').on(t.userId, t.accountId, t.conditions),
    oneOf('proposals_status', t.status, PROPOSAL_STATUSES),
    oneOf('proposals_disposition', t.disposition, DECIDED),
    own(),
  ],
).enableRLS();

/** Whether the owner has ever written to an address. Cached, because finding out is a mailbox search. */
export const correspondents = pgTable(
  'correspondents',
  {
    userId: userId(),
    accountId: text('account_id').notNull(),
    addressHash: text('address_hash').notNull(), // keyed hashes, as in `messages`
    domainHash: text('domain_hash').notNull(),
    userHasWritten: boolean('user_has_written').notNull(),
    checkedAt: time('checked_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.accountId, t.addressHash] }), index('correspondents_domain').on(t.accountId, t.domainHash), mailbox(t), own()],
).enableRLS();

/** What the user said about a decision, one answer per decision: what the mail is, and what should happen to it. */
export const feedback = pgTable(
  'feedback',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    decisionId: integer('decision_id').notNull(),
    verdict: text('verdict', { enum: VERDICTS }).notNull(),
    disposition: text('disposition', { enum: DECIDED }).notNull(),
    labelId: text('label_id'),
    via: text('via', { enum: FEEDBACK_VIA }).notNull(),
    createdAt: time('created_at').notNull(),
  },
  (t) => [
    unique('feedback_once').on(t.userId, t.decisionId),
    mailbox(t),
    decision(t),
    label('feedback_label', t, t.labelId),
    oneOf('feedback_verdict', t.verdict, VERDICTS),
    oneOf('feedback_disposition', t.disposition, DECIDED),
    oneOf('feedback_via', t.via, FEEDBACK_VIA),
    index('feedback_account').on(t.accountId, t.createdAt),
    own(),
  ],
).enableRLS();

/**
 * Mail the user answered for, kept whole as evaluation and training data. The dashboard cannot reach
 * Gmail, so answering creates the row and the next pass fetches the message into it.
 */
export const examples = pgTable(
  'examples',
  {
    userId: userId(),
    accountId: text('account_id').notNull(),
    messageId: text('message_id').notNull(),
    labelId: text('label_id'),
    markedAt: time('marked_at').notNull(),
    status: text('status', { enum: EXAMPLE_STATUSES }).notNull().default('pending'),
    bodyText: text('body_text'), // the readable text, as the model would be shown it
    bodyHtml: text('body_html'), // its HTML part as Gmail holds it, cleaned only when shown; null when it has none
    // What mail like it is found by (`exampleKeys`, src/store/content.ts), as keyed hashes: its sender's name, and its subject
    // with the numbers taken out. Null when it has none worth matching; `unset:` until the start-up pass hashes it.
    nameHash: text('name_hash').default('unset:'),
    subjectHash: text('subject_hash').default('unset:'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.accountId, t.messageId] }),
    mailbox(t),
    message(t),
    label('examples_label', t, t.labelId),
    oneOf('examples_status', t.status, EXAMPLE_STATUSES),
    index('examples_pending')
      .on(t.accountId)
      .where(sql`${t.status} = 'pending'`),
    // The newest examples like a message, and the newest of each label, are read by these for every message the model judges.
    index('examples_by_name')
      .on(t.accountId, t.nameHash, t.markedAt)
      .where(sql`${t.status} = 'captured'`),
    index('examples_by_subject')
      .on(t.accountId, t.subjectHash, t.markedAt)
      .where(sql`${t.status} = 'captured'`),
    index('examples_by_label')
      .on(t.accountId, t.labelId, t.markedAt)
      .where(sql`${t.status} = 'captured'`),
    own(),
  ],
).enableRLS();

/**
 * The text of a message Sift read whole with Inbox off (for the model, for mail waiting on the person, for an example), kept 30
 * days from reading whatever becomes of the message, so nothing reads it from Gmail again (`keepRead`, src/store/kept.ts).
 */
export const readBodies = pgTable(
  'read_bodies',
  {
    userId: userId(),
    accountId: text('account_id').notNull(),
    messageId: text('message_id').notNull(),
    bodyText: text('body_text').notNull(), // all of its readable text, up to `MAX_MAIL_CHARS` (src/gmail/body.ts); before 0070, the model's 4,000
    bodyHtml: text('body_html'), // its HTML part as Gmail holds it, cleaned only when shown; null when it has none
    fetchedAt: time('fetched_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.accountId, t.messageId] }), mailbox(t), message(t), own()],
).enableRLS();

/**
 * The text of mail in the inbox, all of it, for Inbox to show: held only while the person has Inbox on, and deleted with
 * the rest when they turn it off. Mail that left the inbox keeps its text while its record stays.
 */
export const mailBodies = pgTable(
  'mail_bodies',
  {
    userId: userId(),
    accountId: text('account_id').notNull(),
    messageId: text('message_id').notNull(),
    bodyText: text('body_text').notNull(), // all of its readable text, up to `MAX_MAIL_CHARS` (src/gmail/body.ts)
    bodyHtml: text('body_html'), // its HTML part as Gmail holds it, cleaned only when shown; null when it has none
    fetchedAt: time('fetched_at').notNull(),
    // What search finds it by: a keyed Bloom filter of its words, its sender's and its subject's (src/store/search.ts).
    // Null until the pass indexes text kept before there was one. Kept in the row (STORAGE MAIN), where a search scans it.
    search: bytes('search'),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.accountId, t.messageId] }),
    mailbox(t),
    message(t),
    index('mail_bodies_unindexed')
      .on(t.userId, t.accountId)
      .where(sql`${t.search} IS NULL`),
    own(),
  ],
).enableRLS();

/**
 * Copying a mailbox for Inbox: its mail received from `since` (null: all of it) to `before`, and what is in its inbox, listed
 * newest first a page at a time, each message recorded with its text (`copyMail`, src/work/copy.ts). One a mailbox.
 */
export const mailCopies = pgTable(
  'mail_copies',
  {
    userId: userId(),
    accountId: text('account_id').notNull(),
    since: time('since'),
    before: time('before').notNull(),
    pageToken: text('page_token'), // where the page under way starts in Gmail's listing; null: at the top
    done: integer('done').notNull().default(0), // listed and recorded, in this listing
    total: integer('total').notNull().default(0), // Gmail's estimate of what the listing holds, from its first page
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'), // null while it goes on
  },
  (t) => [primaryKey({ columns: [t.userId, t.accountId] }), mailbox(t), own()],
).enableRLS();

/** A replay of the model over stored examples, with the settings it ran with: the same hashes mean the model was asked the same way. */
export const evalRuns = pgTable(
  'eval_runs',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'),
    status: text('status', { enum: EVAL_STATUSES }).notNull(),
    error: text('error'),
    model: text('model').notNull(),
    promptHash: text('prompt_hash').notNull(), // the system prompt and the layout around a message
    labelsHash: text('labels_hash').notNull(),
    labels: jsonb('labels').$type<{ id: string; name: string; description: string }[]>().notNull(), // as the model was given them
    fewShot: boolean('few_shot').notNull(),
    total: integer('total').notNull(),
    examples: jsonb('examples').$type<string[]>().notNull().default([]), // message ids of the examples it judges, chosen at the start
  },
  (t) => [unique('eval_runs_own').on(t.userId, t.id), mailbox(t), oneOf('eval_runs_status', t.status, EVAL_STATUSES), own()],
).enableRLS();

/**
 * A press of "Go through inbox": every message in the inbox when it began (the newest `most`), each decided
 * as if it had just arrived. It goes on over ticks until `next` reaches the end of `messages`, or the person stops it.
 */
export const inboxRuns = pgTable(
  'inbox_runs',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    // Applying this rule to the mail it finds in the inbox, as the user's press. Null: deciding the whole inbox as new mail.
    ruleId: text('rule_id'),
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'), // null while it goes on
    stopped: boolean('stopped').notNull().default(false),
    // Whether Sift was on at the press: what it decides is carried out only then, and only while Sift stays on.
    acts: boolean('acts').notNull(),
    most: integer('most').notNull(),
    listed: boolean('listed').notNull().default(false), // every id it will go through is in `messages`
    pageToken: text('page_token'), // where listing the inbox got to
    messages: jsonb('messages').$type<string[]>().notNull().default([]), // newest first, as Gmail lists them
    next: integer('next').notNull().default(0), // how many of `messages` it has been through
  },
  (t) => [
    unique('inbox_runs_own').on(t.userId, t.id),
    mailbox(t),
    uniqueIndex('inbox_runs_one_going')
      // One whole-inbox run, and one per rule, at a time.
      .on(t.userId, t.accountId, sql`coalesce(${t.ruleId}, '')`)
      .where(sql`${t.finishedAt} IS NULL`),
    own(),
  ],
).enableRLS();

/**
 * Labels the model suggested from what the person said they want, with what the call cost. Their words and
 * the suggestions are encrypted, since either may name a sender. `labels` is null when the call failed.
 */
export const labelProposals = pgTable(
  'label_proposals',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'),
    model: text('model').notNull(),
    goal: text('goal').notNull(),
    labels: text('labels'),
    note: text('note'), // encrypted: what it says its labels leave out, such as what a label of theirs covers already
    error: text('error'), // its status and kind, never the provider's text
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
  },
  (t) => [unique('label_proposals_own').on(t.userId, t.id), mailbox(t), index('label_proposals_time').on(t.accountId, t.startedAt), own()],
).enableRLS();

/** One row per call asking the person's model to fill in a rule from their words; the rule is made, or not, in the dialog. */
export const ruleDrafts = pgTable(
  'rule_drafts',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'),
    model: text('model').notNull(),
    goal: text('goal').notNull(), // encrypted, as a label proposal's
    rule: text('rule'), // the draft, encrypted JSON
    lookups: integer('lookups').notNull().default(0), // look-ups of the person's senders it made
    error: text('error'), // its status and kind, never the provider's text
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
  },
  (t) => [unique('rule_drafts_own').on(t.userId, t.id), mailbox(t), index('rule_drafts_time').on(t.accountId, t.startedAt), own()],
).enableRLS();

/** One row per Ask in Inbox's search: the person's words turned into a filter on the list by their model. */
export const mailAsks = pgTable(
  'mail_asks',
  {
    id: id(),
    userId: userId(),
    accountId: text('account_id').notNull(),
    startedAt: time('started_at').notNull(),
    finishedAt: time('finished_at'),
    model: text('model').notNull(),
    words: text('words').notNull(), // encrypted, as a rule draft's goal
    answer: text('answer'), // the filter, or why there is none, encrypted JSON
    lookups: integer('lookups').notNull().default(0),
    error: text('error'), // its status and kind, never the provider's text
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
  },
  (t) => [unique('mail_asks_own').on(t.userId, t.id), mailbox(t), index('mail_asks_time').on(t.accountId, t.startedAt), own()],
).enableRLS();

/** One row per example judged: labels and cost, no message content. */
export const evalResults = pgTable(
  'eval_results',
  {
    userId: userId(),
    runId: integer('run_id').notNull(),
    messageId: text('message_id').notNull(),
    expected: text('expected').notNull(), // the owner's label
    got: text('got'), // a label id or 'unsure'; null when the call failed
    error: text('error'), // why the call failed: its status and kind, never the provider's text
    confidence: doublePrecision('confidence'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    durationMs: integer('duration_ms').notNull(),
    shots: integer('shots').notNull(), // examples shown beside it
    senderShots: integer('sender_shots').notNull(), // of those, from the same sender
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.runId, t.messageId] }),
    foreignKey({ columns: [t.userId, t.runId], foreignColumns: [evalRuns.userId, evalRuns.id] }).onDelete('cascade'),
    own(),
  ],
).enableRLS();

/**
 * One label's mail of a day, put into the person's primary mailbox as one message: what Sift archived from it in
 * `(since, until]`, by when the archive was confirmed. Written before the model is asked and before the message
 * is put in, so a step run again finishes it rather than writing another.
 */
export const digests = pgTable(
  'digests',
  {
    id: id(),
    userId: userId(),
    labelId: text('label_id').notNull(),
    accountId: text('account_id').notNull(), // the mailbox it is put in
    since: time('since').notNull(),
    until: time('until').notNull(),
    messageId: text('message_id').notNull(), // the Message-ID it is given, `<digest.…@sift.invalid>`: how sync tells it is Sift's own
    gmailId: text('gmail_id'), // null until Gmail has it
    count: integer('count').notNull(),
    // What the model picked as worth a look, `{ id, why }[]`, encrypted: the reasons come from mail (src/store/content.ts).
    highlights: text('highlights'),
    model: text('model'), // null: no model was asked
    error: text('error'), // why the model's call failed: its status and kind, never the provider's text
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    createdAt: time('created_at').notNull(),
    insertedAt: time('inserted_at'),
  },
  (t) => [
    unique('digests_own').on(t.userId, t.id),
    unique('digests_message').on(t.userId, t.messageId),
    mailbox(t),
    label('digests_label', t, t.labelId),
    index('digests_label_until').on(t.userId, t.labelId, t.until),
    index('digests_open')
      .on(t.userId)
      .where(sql`${t.gmailId} IS NULL`),
    own(),
  ],
).enableRLS();
