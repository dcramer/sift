import type { ExistingFilter, FilterProposal } from './filters.ts';

/** The only way the rest of sift reaches a mail provider. Implemented by src/gmail. No forward or delete. */
export interface Mailbox {
  /** Current label ids, read fresh, or null if the message no longer exists. Must not mark the message read. */
  getLabelIds(messageId: string): Promise<string[] | null>;
  /** One atomic change to a single message. Returns its labels after the change, as the provider answers it. */
  modifyLabels(messageId: string, change: { add: string[]; remove: string[] }): Promise<string[]>;
  /** Returns the id of the label, creating it if needed. */
  ensureLabel(name: string): Promise<string>;
  /** True if the account owner has ever sent mail to this address. */
  hasSentTo(address: string): Promise<boolean>;
  /** Returns the provider's filter id. Callers must run `validateFilter` first. */
  createFilter(filter: FilterProposal): Promise<string>;
  /** Resolves when the filter is already gone, too. */
  deleteFilter(filterId: string): Promise<void>;
  /** Every filter in the account, the user's own included. */
  listFilters(): Promise<ExistingFilter[]>;
  /** Puts a message Sift wrote into the mailbox, as if it had arrived: not sent, so it reaches no one else. `raw` is RFC 2822. */
  insertMessage(raw: string, labelIds: readonly string[]): Promise<{ id: string; labelIds: string[] }>;
  /** The message with this RFC 822 Message-ID, wherever it is in the mailbox, or null. */
  findByMessageId(messageId: string): Promise<{ id: string; threadId: string } | null>;
  /**
   * Sends mail the person wrote, as them, into `threadId` when it answers one. `raw` is RFC 2822. Only `src/actions/send.ts`
   * calls it, which records it first and checks they may.
   */
  send(message: { raw: string; threadId?: string }): Promise<{ id: string; threadId: string; labelIds: string[] }>;
}
