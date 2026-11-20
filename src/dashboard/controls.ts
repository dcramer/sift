import type { Sql } from '../store/sql.ts';
import type { Reach } from '../store/inbox.ts';
import type { InboxEstimate, LabelProposal, MailAsk, MailChange, MailReach, RuleDraft, RuleInbox } from './types.ts';

/**
 * What the dashboard can ask the rest of sift to do. The dashboard itself may not import Gmail, the
 * action executor or the work code, so the process that starts it hands these in. Anything that changes
 * the mailbox goes through here and is audited like any other change. `db` is the database of whoever
 * asked, which is where the thing named is looked for.
 */
export interface Controls {
  /** The models this person's sign-ins offer, and for each provider the one to suggest first. */
  models(db: Sql): Promise<{ models: string[]; shortlist: Record<string, string[]>; costs: Record<string, number> }>;
  /** The ways to reach a model, which of them this person has signed in to, and a ChatGPT sign-in under way. */
  modelSignIns(db: Sql): Promise<ModelSignIns>;
  /**
   * Start signing this person in to ChatGPT, the install's one way. Resolves with where to go, and for a
   * device code the code to enter there; that completes in the background, a redirect by `finishChatGPT`.
   */
  signInChatGPT(db: Sql): Promise<PendingChatGPT>;
  /** Finish this person's Sign in with ChatGPT with the address their browser was sent back to. Rejects with what went wrong. */
  finishChatGPT(db: Sql, address: string): Promise<void>;
  /** Store an API key for one of the providers that takes one. */
  saveModelKey(db: Sql, provider: string, key: string): Promise<void>;
  signOutModel(db: Sql, provider: string): Promise<void>;
  /**
   * Reverse one mailbox change. Resolves with what the page cannot show for itself (it shows the change
   * as undone), or null when there is nothing more to say.
   */
  undo(db: Sql, actionId: number): Promise<string | null>;
  /**
   * The person's own press on messages of theirs in the inbox, through the executor, Sift on or off. Messages no longer in
   * the inbox are left as they are. Resolves with the changes that landed, which `undo` takes back, and how many Gmail did
   * not take, which a failed call counts too, so those that landed before it can still be taken back.
   */
  changeMail(db: Sql, accountId: string, messageIds: readonly string[], change: MailChange['change']): Promise<{ actions: number[]; missed: number }>;
  /**
   * What going through the newest `reach` of these of the person's inboxes would take, read from Gmail: how
   * many messages, how many of those likely need the model, and about what that costs.
   */
  inboxEstimate(db: Sql, mailboxes: readonly string[], reach: Reach): Promise<InboxEstimate>;
  /** What copying these of the person's mailboxes for Inbox would take for each window it can keep, read from Gmail's counts. */
  mailReach(db: Sql, mailboxes: readonly string[]): Promise<MailReach>;
  /**
   * After the user has corrected a decision: take back what sift last did to that message, so the new
   * decision can be carried out from where the message started.
   */
  putBack(db: Sql, accountId: string, messageId: string): Promise<void>;
  /**
   * Replay the model over an account's stored examples, in the background. Every example is a model call
   * that costs money, so this only ever runs because the user asked. Resolves with the run's id.
   */
  startEval(db: Sql, request: { accountId: string; fewShot: boolean; limit: number }): Promise<number>;
  /**
   * Ask the person's model for labels that serve what they said they want. Its own call, with their words
   * and their labels, and no mail. Rejects with a sentence for them when there is no model or the call failed.
   */
  proposeLabels(db: Sql, request: { accountId: string; goal: string }): Promise<LabelProposal>;
  /**
   * Ask the person's model to fill in a rule from what they want, looking up the senders Sift has recorded
   * in that mailbox as it needs. Rejects with a sentence for them when there is no model or the call failed.
   */
  draftRule(db: Sql, request: { accountId: string; goal: string }): Promise<RuleDraft>;
  /**
   * Ask the person's model to turn their words into a filter on Inbox's list, looking up their senders as the rule
   * drafter does. `today` is the reader's, `YYYY-MM-DD`. Rejects with a sentence for them when there is no model or the call failed.
   */
  askMail(db: Sql, request: { accountId: string; words: string; today: string }): Promise<MailAsk>;
  /**
   * Copy a rule to Gmail as a filter (`on`), or take its filter out again. Rejects with a sentence for
   * the user when the rule cannot be a filter or Gmail refused.
   */
  ruleFilter(db: Sql, ruleId: string, on: boolean): Promise<void>;
  /** What applying a rule to the inbox would do, from a sample read from the rule's mailbox in Gmail. Nothing is changed. */
  ruleInbox(db: Sql, ruleId: string): Promise<RuleInbox>;
  /**
   * Revoke sift's Gmail access to one of this person's mailboxes at Google, before it is removed, and stop
   * reporting on it. Resolves false when Google could not be reached; the mailbox is removed anyway.
   */
  revokeGmail(db: Sql, email: string): Promise<boolean>;
  /**
   * Send what the person wrote, as them, from one of their mailboxes, into `threadId` when it answers a message there
   * (`sendMail`, src/actions/send.ts). Resolves with Gmail's id for it and its conversation; rejects with a sentence for
   * them when they may not send or Gmail refused.
   */
  send(db: Sql, sending: { accountId: string; id: string; threadId?: string; mail: Outgoing }): Promise<{ id: string; threadId: string }>;
  /** Pass this person's mailboxes now instead of at the next tick. */
  checkNow(db: Sql): Promise<void>;
  /** How the last passes over these mailboxes went. */
  activity(mailboxes: string[]): Promise<Activity>;
}

interface Party {
  address: string;
  name?: string;
}

/** Mail the person wrote, as `sendMail` takes it: plain text; a reply names the Message-IDs it follows. */
interface Outgoing {
  from: Party;
  to: Party[];
  cc: Party[];
  subject: string;
  text: string;
  inReplyTo?: string;
  references?: string[];
}

interface Activity {
  /** False when only the dashboard is running, with nothing classifying mail. */
  running: boolean;
  lastPassAt: number | null;
  /** What went wrong on each mailbox's last pass, starting with its address. Empty when it went well. */
  problems: string[];
  /** Addresses of accounts whose Google sign-in expired, as of the last pass. Each must sign in again. */
  expired: string[];
}

/**
 * Signing in with Google from the browser. One sign-in does two things: it gives sift its access to the
 * Gmail account, and it proves the viewer owns that account, which is what lets them use the dashboard.
 */
export interface SignIn {
  hasClient(): boolean;
  /**
   * Google's sign-in address for a browser that should come back to `redirectUri`. `send`: a mailbox already connected,
   * for which Google is asked only to let Sift send.
   */
  url(redirectUri: string, state: string, challenge: string, send: string | null): string;
  /**
   * Finish a sign-in. Who may is Google's to say: the client's test users, or anyone once it is published.
   * An account sift does not know is connected as another mailbox of `addTo` (the address of whoever is
   * signed in and asked to add it), or else as a new person's. With `send`, it must be that mailbox, whose
   * sign-in is replaced and which then may send if Google granted it. Records whether each mailbox may send.
   * Resolves with the account's address; rejects with a message for the user.
   */
  complete(redirectUri: string, code: string, verifier: string, addTo: string | null, send: string | null): Promise<string>;
}

interface ModelSignIns {
  choices: { provider: string; label: string; how: 'device-code' | 'redirect' | 'key' }[];
  /** Providers this person has a sign-in for. */
  signedIn: string[];
  /** A ChatGPT sign-in waiting on them, or how the last one failed. */
  pending: PendingChatGPT | { error: string } | null;
}

/** Where to sign in to ChatGPT, until when, and by device code the code to enter there. */
interface PendingChatGPT {
  code?: string;
  url: string;
  expiresAt: number;
}
