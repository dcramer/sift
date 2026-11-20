import type { Sql } from '../store/sql.ts';
import type { Mailbox } from '../actions/mailbox.ts';
import type { GmailApi } from '../gmail/api.ts';
import type { MessageContent } from '../gmail/body.ts';
import { mailboxAliases } from '../store/accounts.ts';
import { recordFacts, recordedThread } from '../store/messages.ts';
import { copied } from '../store/copies.ts';
import { cachedCorrespondent, domainFacts, rememberCorrespondent, senderFacts } from '../store/senders.ts';
import { answersUnderName } from '../store/examples.ts';
import { type ThreadFacts, deriveFacts, threadFacts } from '../triage/facts.ts';
import type { Evidence } from '../triage/stages/model.ts';
import type { MessageFacts } from '../triage/types.ts';

export interface EvidenceSources {
  db: Sql;
  /** For the message body, read once (`readingOnce`), and a reply's thread when the record does not hold it. */
  api: Pick<GmailApi, 'getContent' | 'getThread'>;
  /** For "has the owner written to this sender". Only read from here. */
  mailbox: Pick<Mailbox, 'hasSentTo'>;
  now?: () => number;
}

/**
 * Collect what the model is shown about one message. Reading the whole message and, for a reply, its
 * thread's labels adds to the message's recorded facts; no other message's content is read. Each lookup that fails becomes "unknown" instead
 * of failing the message; the model stage treats unknown correspondence as a reason for caution.
 */
export async function gatherEvidence(sources: EvidenceSources, facts: MessageFacts): Promise<Evidence> {
  const { db } = sources;

  let content: MessageContent | null = null;
  try {
    content = await sources.api.getContent(facts.messageId);
  } catch {
    content = null;
  }
  let thread: ThreadFacts | null = null;
  if (deriveFacts(facts).isReply) {
    try {
      thread = await threadOf(sources, facts);
    } catch {
      thread = null;
    }
  }
  const known = deriveFacts(facts, { ...content?.facts, ...thread }, await mailboxAliases(db, facts.accountId));
  if (content || thread) await recordFacts(db, facts.accountId, facts.messageId, known);

  const userHasWritten = await ownerHasWritten(sources, facts);
  const now = (sources.now ?? Date.now)();
  const sender = await senderFacts(db, [facts.accountId], facts.from.address, now);
  const domain = await domainFacts(db, [facts.accountId], facts.from.domain, now);
  const underName = await answersUnderName(db, facts.accountId, facts.from);
  return {
    facts,
    known,
    body: content?.text ?? null,
    sender: {
      messagesSeen: sender.messages,
      userHasWritten,
      standing: { standing: sender.standing, why: sender.why },
      ownerLabels: sender.answered,
      underName,
      firstSeenAt: sender.firstSeenAt,
    },
    ...(domain
      ? { domain: { messages: domain.messages, senders: domain.senders, standing: domain.standing, why: domain.why, ownerLabels: domain.answered } }
      : {}),
  };
}

/**
 * What a reply's thread shows: as an earlier read found it (a model call tried again); from the record, which holds every
 * message of it while Inbox has copied the mailbox, what the owner sent among them; and otherwise from Gmail, 40 units for the
 * labels of the thread's other messages, which Sift may never have recorded.
 */
async function threadOf(sources: Pick<EvidenceSources, 'db' | 'api'>, facts: MessageFacts): Promise<ThreadFacts | null> {
  const { known } = facts;
  if (known?.earlierInThread !== undefined && known.ownerInThread !== undefined)
    return { earlierInThread: known.earlierInThread, ownerInThread: known.ownerInThread };
  const messages = (await copied(sources.db, facts.accountId))
    ? await recordedThread(sources.db, facts.accountId, facts.threadId)
    : await sources.api.getThread(facts.threadId);
  return threadFacts(messages ?? [], facts.messageId);
}

/** Whether the owner has ever written to the sender: the cached answer, or one search of sent mail, remembered. Null if that failed. */
async function ownerHasWritten(sources: Pick<EvidenceSources, 'db' | 'mailbox' | 'now'>, facts: MessageFacts): Promise<boolean | null> {
  const { db } = sources;
  const now = (sources.now ?? Date.now)();
  const cached = await cachedCorrespondent(db, facts.accountId, facts.from.address, now);
  if (cached !== undefined) return cached;
  try {
    const written = await sources.mailbox.hasSentTo(facts.from.address);
    await rememberCorrespondent(db, facts.accountId, facts.from.address, written, now);
    return written;
  } catch {
    return null;
  }
}
