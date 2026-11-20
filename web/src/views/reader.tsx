'use client';
import { PlusIcon } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useAnswer } from '@/components/answer.tsx';
import { StatusWord, Verdict } from '@/components/bits.tsx';
import { MessageBody, SeenFacts } from '@/components/message-parts.tsx';
import { useMailPress } from '@/components/mail.tsx';
import { usePlan } from '@/components/model-connect.tsx';
import { ContactHint, SenderFacts, SenderLink, senderHref } from '@/components/sender.tsx';
import { useAction } from '@/lib/action.ts';
import { type MailConversation, type MessageDetail, type RuleMatch, api, changeLoaded, useLoaded } from '@/lib/api.ts';
import { type Writing, closeReply, useCompose, writing } from '@/lib/compose.ts';
import { capitalised, count, dateTime, money, outcomeName, sureness, tier } from '@/lib/format.ts';
import type { MessageRef } from '@/lib/open-messages.ts';
import { messageKey, useParam } from '@/lib/params.ts';
import { AT_API_PRICES } from '@/lib/prices.ts';
import { reveal } from '@/lib/reveal.ts';
import { type RuleStart, keepStart, messageStart } from '@/lib/rule-start.ts';
import { InlineComposer } from '@/views/composer.tsx';
import { AddLabelsDialog } from '@/views/label-panel.tsx';
import { RuleDialog } from '@/views/rule-dialog.tsx';
import {
  Ago,
  AnswerRow,
  Arrived,
  Blank,
  Button,
  Code,
  Disclosure,
  Failure,
  Heads,
  Heard,
  Loading,
  MessageHead,
  MessageStack,
  Note,
  Presses,
  Reader,
  ReaderBar,
  Section,
  SomeOf,
  Table,
  Td,
  TextLink,
  Th,
  Timeline,
  TimelineEvent,
  Tr,
  useToast,
} from '@/system';

type Decision = MessageDetail['decisions'][number];
type Action = MessageDetail['actions'][number];

const CHANGE: Record<string, string> = {
  archive: 'Archived',
  spam: 'Marked spam',
  label: 'Labelled',
  undo: 'Undid a change',
  unsubscribe: 'Unsubscribed',
  read: 'Marked read',
  unread: 'Marked unread',
};
/** A change that never landed, as the lists say it ("Not archived"): it is tried again, so it is only history. */
const NOT_DONE: Record<string, string> = {
  archive: 'Not archived',
  spam: 'Not marked spam',
  label: 'Not labelled',
  undo: 'Not undone',
  unsubscribe: 'Not unsubscribed',
  read: 'Not marked read',
  unread: 'Not marked unread',
};

function DecisionEvent({ d }: { d: Decision }) {
  // Through a plan, the call was paid for by it: its cost is only what the API would have charged.
  const plan = usePlan(d.model ?? '');
  const facts = [
    d.ruleId ? `rule ${d.ruleId}` : null,
    d.confidence === null ? null : `confidence ${d.confidence.toFixed(2)}`,
    d.model ? `${d.model}, ${count(d.inputTokens + d.outputTokens)} tokens, ${money(d.costUsd)}${plan ? ` ${AT_API_PRICES}` : ''}` : null,
    d.durationMs === null ? null : `${count(d.durationMs)} ms`,
  ].filter(Boolean);
  return (
    <TimelineEvent
      at={dateTime(d.decidedAt)}
      title={
        <>
          <span className="font-medium">{d.carryOut ? 'Decided' : 'Suggested'}</span>
          <Verdict labelId={d.labelId} labelName={d.labelName} disposition={d.disposition} />
        </>
      }
    >
      <p className="text-foreground">{capitalised(reveal(d.reason))}</p>
      <p>
        By {tier(d.stage).name.toLowerCase()}
        {facts.length > 0 ? ` · ${facts.join(' · ')}` : ''}
      </p>
    </TimelineEvent>
  );
}

/** Where a change got to, when it is not done and did land. */
const ACTION_STATUS: Record<string, string> = { undone: 'Undone', pending: 'Waiting' };

function ActionEvent({ a, onUndo, busy }: { a: Action; onUndo: (id: number) => void; busy: boolean }) {
  const labels = (title: string, list: string[]) =>
    list.length === 0 ? null : (
      <p className="flex flex-wrap items-baseline gap-1.5">
        {title}
        {list.map((label) => (
          <Code key={label}>{label}</Code>
        ))}
      </p>
    );
  return (
    <TimelineEvent
      at={dateTime(a.createdAt)}
      title={
        a.status === 'failed' || a.status === 'unknown' ? (
          <span className="text-muted-foreground">{NOT_DONE[a.type] ?? a.type}</span>
        ) : (
          <>
            <span className="font-medium">{CHANGE[a.type] ?? a.type} in Gmail</span>
            {a.status === 'done' ? null : <span className="text-muted-foreground">{ACTION_STATUS[a.status] ?? a.status}</span>}
          </>
        )
      }
      {...(a.status === 'done' && a.type !== 'undo' && a.type !== 'unsubscribe'
        ? {
            action: (
              <Button busy={busy} onClick={() => onUndo(a.id)}>
                Undo
              </Button>
            ),
          }
        : {})}
    >
      {labels('Added', reveal(a.added))}
      {labels('Removed', reveal(a.removed))}
    </TimelineEvent>
  );
}

/** What happened to a message, oldest first: what Sift decided and what changed in Gmail, each with Undo. */
function History({ detail, onUndone }: { detail: MessageDetail; onUndone: () => void }) {
  const undo = useAction();
  const toast = useToast();
  const history = [
    ...detail.decisions.map((d) => ({ at: d.decidedAt, order: 0, node: <DecisionEvent key={`d${d.id}`} d={d} /> })),
    ...detail.actions.map((a) => ({
      at: a.createdAt,
      order: 1,
      node: (
        <ActionEvent
          key={`a${a.id}`}
          a={a}
          busy={undo.busy}
          onUndo={(id) =>
            undo.run(async () => {
              const { message } = await api.undo(id);
              if (message) toast(message);
              onUndone();
            })
          }
        />
      ),
    })),
  ].toSorted((x, y) => x.at - y.at || x.order - y.order);
  if (history.length === 0) return null;
  return (
    <>
      <Failure>{undo.error}</Failure>
      <Timeline>{history.map((entry) => entry.node)}</Timeline>
    </>
  );
}

const historyCount = (detail: MessageDetail) => detail.decisions.length + detail.actions.length;

/** Each address, the account's own as "me", as a mail app says it. */
const people = (list: MessageDetail['to'], account: string) => list.map((p) => (reveal(p.address) === account ? 'me' : reveal(p.address)));

/** Who a message went to, unless that was the account alone, which says nothing. A long list folds. */
function AddressedTo({ detail }: { detail: MessageDetail }) {
  if (detail.cc.length === 0 && detail.to.every((p) => reveal(p.address) === detail.accountId)) return null;
  return (
    <>
      {detail.to.length > 0 ? (
        <>
          To <SomeOf items={people(detail.to, detail.accountId)} />
        </>
      ) : null}
      {detail.cc.length > 0 ? (
        <>
          {detail.to.length > 0 ? ', cc ' : 'Cc '}
          <SomeOf items={people(detail.cc, detail.accountId)} />
        </>
      ) : null}
    </>
  );
}

type Answer = Exclude<Writing, { kind: 'new' }>;

/** One message of the conversation, open: who wrote it, to whom and when, with `onAnswer` its own presses for answering it, over its text. */
function Opened({ detail, onAnswer }: { detail: MessageDetail; onAnswer?: ((what: Answer) => void) | undefined }) {
  const address = reveal(detail.fromAddress);
  const name = reveal(detail.fromName);
  const id = detail.messageId;
  const mine = address === detail.accountId;
  return (
    <>
      <MessageHead
        from={
          mine ? (
            'me'
          ) : (
            <>
              <SenderLink address={address} name={name}>
                {name ?? address}
              </SenderLink>
              <ContactHint contact={detail.sender.contact} />
            </>
          )
        }
        {...(name && !mine ? { address: <SenderLink address={address} /> } : {})}
        at={<Heard at={detail.receivedAt} />}
        to={<AddressedTo detail={detail} />}
        {...(onAnswer
          ? {
              answers: {
                reply: () => onAnswer({ kind: 'reply', messageId: id, all: false }),
                all: () => onAnswer({ kind: 'reply', messageId: id, all: true }),
                forward: () => onAnswer({ kind: 'forward', messageId: id }),
              },
            }
          : {})}
      />
      <MessageBody key={id} detail={detail} />
    </>
  );
}

/** A message of the conversation: the reader's own as it was loaded, any other read as it is first wanted and kept. */
function useMessage(id: string, newest: MessageDetail): { detail: MessageDetail | null; error: string | null } {
  const other = id === newest.messageId ? null : id;
  const loaded = useLoaded(
    `message/${newest.accountId}/${other ?? ''}`,
    (signal) => (other ? api.message(other, signal, newest.accountId) : Promise.resolve(null)),
    30_000,
    '',
  );
  return other ? { detail: loaded.data, error: loaded.error } : { detail: newest, error: null };
}

function OpenOne({ id, newest, onAnswer }: { id: string; newest: MessageDetail; onAnswer?: ((what: Answer) => void) | undefined }) {
  const { detail, error } = useMessage(id, newest);
  if (detail) return <Opened detail={detail} onAnswer={onAnswer} />;
  return error ? <Failure>{error}</Failure> : <Loading rows={4} />;
}

/**
 * The messages of what is open: a conversation (Inbox), oldest first, the reader's own reply included; or one message.
 * Its newest, what is unread and what a reply in the address answers start open, and so does one that arrives while it
 * is (a reply just sent). Opening a conversation with unread mail marks it read. `newest` is the newest in the inbox,
 * which Sift's row is about.
 */
function Messages({
  conversation,
  newest,
  answered,
  onAnswer,
  onRead,
}: {
  conversation: MailConversation | null;
  newest: MessageDetail;
  answered: string | null;
  onAnswer?: ((what: Answer) => void) | undefined;
  onRead: () => void;
}) {
  const ids = conversation?.messages.map((m) => m.messageId) ?? [newest.messageId];
  const unread = conversation?.messages.filter((m) => m.unread).map((m) => m.messageId) ?? [];
  const [open, setOpen] = useState(() => new Set([ids.at(-1) ?? newest.messageId, ...unread, ...(answered ? [answered] : [])]));
  const [known, setKnown] = useState(ids);
  const arrived = ids.filter((id) => !known.includes(id));
  if (arrived.length > 0) {
    setKnown(ids);
    setOpen(new Set([...open, ...arrived]));
  }
  const { press } = useMailPress();
  // Read is a change in Gmail like any other, made once as it opens.
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current || !conversation || unread.length === 0) return;
    marked.current = true;
    press([{ accountId: conversation.accountId, threadId: conversation.threadId, messageIds: unread, subject: newest.subject }], 'read');
    onRead();
  });
  const messages = conversation
    ? conversation.messages.map((m) => ({
        id: m.messageId,
        from: reveal(m.fromAddress) === conversation.accountId ? 'me' : (reveal(m.fromName) ?? reveal(m.fromAddress)),
        preview: m.preview ? reveal(m.preview) : null,
        at: <Heard at={m.receivedAt} />,
      }))
    : [{ id: newest.messageId, from: reveal(newest.fromName) ?? reveal(newest.fromAddress), preview: null, at: <Arrived at={newest.receivedAt} /> }];
  const toggle = (id: string) => {
    const next = new Set(open);
    if (!next.delete(id)) next.add(id);
    setOpen(next);
  };
  return (
    <MessageStack messages={messages} open={open} onToggle={toggle}>
      {(id) => <OpenOne id={id} newest={newest} onAnswer={onAnswer} />}
    </MessageStack>
  );
}

/** The reply box, at the foot of the conversation, on the message it answers, which it names when that is not the newest. */
function Answering({ what, newest, onClose }: { what: Answer; newest: MessageDetail; onClose: () => void }) {
  const { detail, error } = useMessage(what.messageId, newest);
  if (!detail) return error ? <Failure>{error}</Failure> : <Loading rows={3} />;
  const who = reveal(detail.fromName) ?? reveal(detail.fromAddress);
  const about =
    detail.messageId === newest.messageId ? undefined : (
      <>
        {what.kind === 'forward' ? `Forwarding ${who}’s message, ` : `Replying to ${who}, `}
        <Arrived at={detail.receivedAt} />
      </>
    );
  return <InlineComposer what={what} message={detail} about={about} onClose={onClose} />;
}

/**
 * Everything about one message once it has loaded. Sift's row under the title: the answer, which starts on the reader's
 * own where they gave one, Why (Sift's reason, and in Inbox the history) and Rule…; answering moves on to the next item.
 * Then the conversation, and what answers it. Opened from anywhere but Inbox, a side column has what Sift saw, the
 * sender, what else of theirs waits, and the history.
 */
function OpenedMessage({
  detail,
  conversation,
  bar,
  onPick,
  onAnswered,
  onUndone,
  onRead,
}: {
  detail: MessageDetail;
  conversation: MailConversation | null;
  bar: ReactNode;
  /** Show another message from the same sender here. */
  onPick: (message: Pick<MessageRef, 'accountId' | 'messageId'>) => void;
  onAnswered: () => void;
  onUndone: () => void;
  /** The conversation was marked read. */
  onRead: () => void;
}) {
  const waiting = useLoaded(`suggestion/${reveal(detail.fromAddress)}`, (signal) => api.suggestion(reveal(detail.fromAddress), signal), 120_000);
  const manage = useLoaded('manage', (signal) => api.manage(signal), 60_000);
  const toast = useToast();
  const compose = useCompose();
  const [composeAs] = useParam('compose');
  const [answering] = useParam('answering');
  const root = useRef<HTMLElement>(null);
  const [adding, setAdding] = useState(false);
  // The rule dialog, opened in place on what this message shows: its sender and label, or one thing Sift saw in it.
  const [ruling, setRuling] = useState<RuleStart | null>(null);
  const current = detail.decisions.at(-1);
  // What the message is, as every list shows it: the user's answer where they gave one, else Sift's.
  const shownLabel = current?.answer ? current.answer.labelId : (current?.labelId ?? null);
  const waitingNow = waiting.data?.messages ?? [];
  const others = waitingNow.filter((m) => m.accountId !== detail.accountId || m.messageId !== detail.messageId);
  const labels = manage.data?.labels ?? [];
  // Mail Sift never decided (the model could not judge it) is answered all the same.
  const target = {
    accountId: detail.accountId,
    sender: reveal(detail.fromAddress),
    messageId: detail.messageId,
    labelId: current?.labelId ?? null,
    ...(current ? { decisionId: current.id } : {}),
  };
  const { answer, choices } = useAnswer(
    labels,
    waitingNow.map((m) => ({
      accountId: m.accountId,
      sender: reveal(detail.fromAddress),
      messageId: m.messageId,
      decisionId: m.decisionId,
      labelId: m.labelId,
    })),
    onAnswered,
  );
  // What else it might be: the labels the sender's other mail has had, most first.
  const total = detail.sender.labels.reduce((sum, l) => sum + l.messages, 0);
  const alternatives = detail.sender.labels
    .filter((l) => l.id !== current?.labelId)
    .slice(0, 2)
    .map((l) => ({ id: l.id, name: l.name, share: total ? l.messages / total : 0 }));
  // Mail that is what Sift says but matters anyway: a rule keeps the sender's mail of that kind, and this message with it.
  const given = labels.find((l) => l.id === current?.labelId);
  const keepable = given && current?.disposition !== 'keep' && given.disposition !== 'keep' && given.disposition !== 'review' ? given : null;
  // A rule covers mail from here on; this message, which may already have been moved, is answered as the rule would.
  const keep = useAction();
  const covers = (match: RuleMatch) =>
    Object.keys(match).length === 1 &&
    ((match.from ?? []).includes(reveal(detail.fromAddress)) || (match.fromDomain ?? []).includes(reveal(detail.fromAddress).split('@')[1] ?? ''));
  const keepThis = (labelId: string) => {
    keep.hide([messageKey(detail)], 'Could not save your answer', async () => {
      const reply = await api.feedback({
        accountId: detail.accountId,
        sender: reveal(detail.fromAddress),
        messageId: detail.messageId,
        ...(current ? { decisionId: current.id } : {}),
        label: labelId,
        disposition: 'keep',
      });
      if (reply.notFixed !== null) toast('Could not put the message back in Gmail', { tone: 'failure', description: reply.notFixed });
    });
    onAnswered();
  };

  // Inbox reads mail; everywhere else the job is what Sift said, so what it said about the message sits beside it.
  const inInbox = conversation !== null;
  const history = historyCount(detail) > 0;
  const said = current ? (
    <p>
      {current.answer ? 'Your answer. Sift said: ' : null}
      {current.answer ? reveal(current.reason) : capitalised(reveal(current.reason))}
      {current.carryOut ? (
        <>
          {' · '}
          <StatusWord row={current} />
        </>
      ) : null}
    </p>
  ) : null;
  const why =
    said || keepable || (inInbox && history) ? (
      <>
        {said}
        {keepable ? (
          <div className="-ml-3">
            <Button variant="quiet" onClick={() => setRuling(keepStart(reveal(detail.fromAddress), keepable.id))}>
              Keep as {keepable.name}…
            </Button>
          </div>
        ) : null}
        {inInbox ? <History detail={detail} onUndone={onUndone} /> : null}
      </>
    ) : null;
  // A reply answers the newest in the inbox, or another message of its conversation.
  const answered = conversation?.messages.some((m) => m.messageId === answering) ? answering : detail.messageId;
  const written = compose ? writing(composeAs, answered) : null;
  const reply = inInbox && compose ? compose : undefined;

  return (
    <Reader
      ref={root}
      bar={bar}
      title={reveal(detail.subject) || '(no subject)'}
      answer={
        <AnswerRow
          key={`${current?.id ?? 'undecided'}/${shownLabel ?? ''}`}
          picker={{
            label: 'What this message is',
            value: shownLabel,
            groups: choices(target, current ? sureness(current) : 1, alternatives),
            empty: outcomeName('review'),
            onSubmit: (id) => answer(target, id),
            extra: { label: 'Add a label…', lead: <PlusIcon />, onSelect: () => setAdding(true) },
          }}
          why={why}
          whyOpen={!inInbox}
        >
          <Button variant="quiet" aria-label="Make a rule…" onClick={() => setRuling(messageStart(reveal(detail.fromAddress), shownLabel))}>
            Rule…
          </Button>
        </AnswerRow>
      }
      side={
        inInbox ? undefined : (
          <>
            <SeenFacts detail={detail} onRule={setRuling} />
            <Section title="Sender" action={<TextLink href={senderHref(reveal(detail.fromAddress))}>All their mail</TextLink>}>
              <SenderFacts profile={detail.sender} />
            </Section>
            {others.length > 0 ? (
              <Section title="Also waiting" meta={count(others.length)}>
                <div className="max-h-56 overflow-y-auto">
                  <Table>
                    <Heads>
                      <Th>Message</Th>
                      <Th num>Received</Th>
                    </Heads>
                    <tbody>
                      {others.map((m) => (
                        <Tr key={`${m.accountId}/${m.messageId}`} onOpen={() => onPick(m)}>
                          <Td className="w-full max-w-0 truncate">{reveal(m.subject) || '(no subject)'}</Td>
                          <Td num quiet>
                            <Ago at={m.receivedAt} />
                          </Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
              </Section>
            ) : null}
            {/* After "Also waiting" has loaded, which would otherwise push it down from under the pointer. */}
            {history && !waiting.loading ? (
              <Disclosure summary={`History · ${historyCount(detail)}`}>
                <History detail={detail} onUndone={onUndone} />
              </Disclosure>
            ) : null}
          </>
        )
      }
    >
      <Messages conversation={conversation} newest={detail} answered={written && written.kind !== 'new' ? answered : null} onAnswer={reply} onRead={onRead} />
      {written && written.kind !== 'new' ? (
        <Answering
          key={`${composeAs}/${answered}`}
          what={written}
          newest={detail}
          onClose={() => {
            closeReply();
            root.current?.focus({ preventScroll: true });
          }}
        />
      ) : reply ? (
        <Presses
          presses={[
            { label: 'Reply', key: 'r', onPress: () => reply({ kind: 'reply', messageId: detail.messageId, all: false }) },
            { label: 'Reply all', key: 'a', onPress: () => reply({ kind: 'reply', messageId: detail.messageId, all: true }) },
            { label: 'Forward', key: 'f', onPress: () => reply({ kind: 'forward', messageId: detail.messageId }) },
          ]}
        />
      ) : null}
      {adding ? <AddLabelsDialog onClose={() => setAdding(false)} onSaved={() => setAdding(false)} /> : null}
      {ruling ? (
        <RuleDialog
          labels={labels}
          start={ruling}
          onClose={() => setRuling(null)}
          onAdded={(match, rule) => {
            if (rule.whenLabel !== undefined && rule.whenLabel === current?.labelId && rule.disposition === 'keep' && covers(match)) keepThis(rule.whenLabel);
          }}
        />
      ) : null}
    </Reader>
  );
}

/**
 * Every list opens a message here, in the list's place: `items` is the list and `index` the one showing, so previous,
 * next and "answer, then the next one" follow it. `back` names the list, which `onBack` returns to. `onShown` is told
 * which row the message is, for the list to come back to.
 */
export function MessageReader({
  items,
  index,
  back,
  onIndex,
  onBack,
  onShown,
}: {
  items: readonly MessageRef[];
  index: number;
  back: string;
  onIndex: (index: number) => void;
  onBack: () => void;
  onShown: (key: string) => void;
}) {
  const item = items[index];
  // Another message from the same sender, looked at without leaving this place in the list.
  const [picked, setPicked] = useState<Pick<MessageRef, 'accountId' | 'messageId'> | null>(null);
  const [shownAt, setShownAt] = useState(index);
  if (shownAt !== index) {
    setShownAt(index);
    setPicked(null);
  }
  const shown = picked ?? item;
  // Not narrowed: a message linked to may be in a mailbox the dashboard is not narrowed to.
  const { data, error, loading, reload } = useLoaded(
    `message/${shown.accountId}/${shown.messageId}`,
    (signal) => api.message(shown.messageId, signal, shown.accountId),
    30_000,
    '',
  );
  const threadId = picked ? undefined : item.threadId;
  const threadLoad = `thread/${item.accountId}/${threadId ?? ''}`;
  const thread = useLoaded(threadLoad, (signal) => (threadId ? api.mailThread(threadId, signal, item.accountId) : Promise.resolve(null)), 30_000, '');
  const { press } = useMailPress();
  // Each message starts at its top, as a page does.
  const go = (to: number) => {
    onIndex(to);
    window.scrollTo(0, 0);
  };
  const pick = (message: Pick<MessageRef, 'accountId' | 'messageId'>) => {
    setPicked(message);
    window.scrollTo(0, 0);
  };
  const next = () => (index < items.length - 1 ? go(index + 1) : onBack());
  const conversation = threadId ? thread.data : null;
  const pressed =
    conversation && data
      ? { accountId: conversation.accountId, threadId: conversation.threadId, messageIds: conversation.messages.map((m) => m.messageId), subject: data.subject }
      : null;
  const listed = data && !picked ? messageKey(data) : null;
  useEffect(() => {
    if (listed) onShown(listed);
  }, [listed, onShown]);

  const bar = (
    <ReaderBar
      back={back}
      onBack={onBack}
      presses={
        threadId
          ? [
              { label: 'Archive', key: 'e', disabled: !pressed, onPress: () => pressed && press([pressed], 'archive', next) },
              { label: 'Mark unread', key: 'Shift+u', quiet: true, disabled: !pressed, onPress: () => pressed && press([pressed], 'unread', onBack) },
            ]
          : []
      }
      position={items.length > 1 ? `${index + 1} of ${items.length}` : undefined}
      onPrevious={index > 0 ? () => go(index - 1) : undefined}
      onNext={index < items.length - 1 ? () => go(index + 1) : undefined}
    />
  );
  if (loading || (threadId && thread.loading))
    return (
      <Reader bar={bar} title={<Blank />}>
        <Loading rows={6} />
      </Reader>
    );
  if (!data)
    return (
      <Reader bar={bar} title={reveal(item.subject) || '(no subject)'}>
        <Note tone="failure" title="Could not load this message">
          <p>{error}</p>
        </Note>
      </Reader>
    );
  return (
    <OpenedMessage
      key={`${data.accountId}/${data.messageId}`}
      detail={data}
      conversation={conversation}
      bar={bar}
      onPick={pick}
      onUndone={reload}
      onAnswered={next}
      onRead={() =>
        changeLoaded<MailConversation | null>(threadLoad, (read) => read && { ...read, messages: read.messages.map((m) => ({ ...m, unread: false })) })
      }
    />
  );
}
