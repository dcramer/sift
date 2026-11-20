'use client';
import { type ReactNode, useDeferredValue, useState } from 'react';
import { ErrorNote } from '@/components/bits.tsx';
import { useAsk } from '@/components/ask.tsx';
import { TurnInboxOn } from '@/components/inbox-switch.tsx';
import { Thinks, useMailPress, whoWrote } from '@/components/mail.tsx';
import { type MailThread, type MailView, api, useLoaded, usePages } from '@/lib/api.ts';
import { useHidden } from '@/lib/action.ts';
import { useCompose } from '@/lib/compose.ts';
import { inboxFirst, period } from '@/lib/format.ts';
import { messageKey, threadKey, useParam } from '@/lib/params.ts';
import { useOpenMessages } from '@/lib/open-messages.ts';
import { reveal } from '@/lib/reveal.ts';
import {
  Arrived,
  Button,
  Callout,
  Check,
  Empty,
  Failure,
  FilterGroup,
  Heads,
  ListView,
  More,
  Note,
  RowCheck,
  Sub,
  Table,
  Td,
  Th,
  Tr,
  TrGroup,
  useNow,
} from '@/system';

const VIEWS = [
  ['all', 'Everything'],
  ['needs', 'Needs you'],
  ['sorted', 'Sorted'],
] as const satisfies readonly (readonly [MailView, string])[];

/** The newest message, which the reader opens on. */
const newest = (t: MailThread) => ({ accountId: t.accountId, messageId: t.messageIds.at(-1)! });

/** Where a conversation a search found is, when that is not the inbox, in front of its subject as Gmail puts a label. */
function Place({ thread }: { thread: MailThread }) {
  if (thread.place === 'inbox') return null;
  return <span className="mr-2 font-normal text-muted-foreground">{thread.place === 'sent' ? 'Sent' : 'Archived'}</span>;
}

/**
 * One conversation: who wrote, how many messages, the subject and the start of the newest, what Sift thinks the newest
 * is, and when. Unread is in bold. On a phone it reads as For review's rows do: who and when, the subject, then a line of
 * the text with what Sift thinks.
 */
function ThreadRow({ thread, selected, onSelect, onOpen }: { thread: MailThread; selected: boolean; onSelect: (on: boolean) => void; onOpen: () => void }) {
  const subject = reveal(thread.subject) || '(no subject)';
  const who = whoWrote(thread.who);
  const many = thread.messageIds.length > 1 ? <span className="font-normal text-muted-foreground tabular-nums">{thread.messageIds.length}</span> : null;
  const strong = thread.unread ? 'font-semibold text-foreground' : '';
  return (
    <Tr onOpen={onOpen} holds={thread.messageIds.map((messageId) => messageKey({ accountId: thread.accountId, messageId }))}>
      <RowCheck checked={selected} onChange={onSelect} label={`Select ${subject}`} />
      <Td className="max-w-0 phone:py-2 md:w-[22%] md:min-w-48">
        <span className={`flex min-w-0 items-baseline gap-1.5 phone:hidden ${thread.unread ? 'name' : ''}`}>
          <span className="truncate">{who}</span>
          {many}
        </span>
        {/* On a phone, a mail app's three lines set close: who and when, the subject, the start of the text with what Sift thinks. Unread is bold and bright, read is plain. */}
        <span className="flex flex-col leading-snug md:hidden">
          <span className="flex items-baseline gap-3">
            <span className={`flex min-w-0 flex-1 items-baseline gap-1.5 ${thread.unread ? 'name leading-snug' : 'text-foreground/85'}`}>
              <span className="truncate">{who}</span>
              {many}
            </span>
            <span className={`shrink-0 text-sm tabular-nums ${thread.unread ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
              <Arrived at={thread.newestAt} />
            </span>
          </span>
          <span className={`truncate ${thread.unread ? 'font-semibold text-foreground' : 'text-foreground/85'}`}>
            <Place thread={thread} />
            {subject}
          </span>
          <span className="flex items-baseline gap-3 text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{thread.preview ? reveal(thread.preview) : null}</span>
            <span className="shrink-0 text-sm">
              <Thinks thinks={thread.thinks} />
            </span>
          </span>
        </span>
      </Td>
      <Td phone="hide" className="max-w-0 md:w-full">
        <span className={`block truncate ${strong}`}>
          <Place thread={thread} />
          {subject}
        </span>
        {thread.preview ? <Sub>{reveal(thread.preview)}</Sub> : null}
      </Td>
      <Td phone="hide" quiet className="whitespace-nowrap">
        <Thinks thinks={thread.thinks} />
      </Td>
      <Td phone="hide" num quiet>
        <Arrived at={thread.newestAt} />
      </Td>
    </Tr>
  );
}

/** Compose on a phone, which has no rail. Nothing while Inbox is off. */
export function PhoneCompose() {
  const compose = useCompose();
  return compose ? (
    <Button className="md:hidden" onClick={() => compose()}>
      Compose
    </Button>
  ) : null;
}

/** Inbox: the conversations in the inbox, as a mail app lists them, with what Sift thinks of each; a search looks through all the mail Sift keeps. */
export function InboxView({ loading: loadingRows }: { loading: ReactNode }) {
  const onOpen = useOpenMessages();
  const manage = useLoaded('manage', (signal) => api.manage(signal), 60_000);
  const [search, setSearch] = useParam('q');
  const [label, setLabel] = useParam('label');
  // Everything is the list unnarrowed, with nothing in the address.
  const [asked, setView] = useParam<MailView | ''>('view', VIEWS);
  const view = asked || 'all';
  const [unread, setUnread] = useParam('unread');
  const q = useDeferredValue(search.trim());
  const ask = useAsk();
  const query = { view, label, q, unread: unread === '1', ...ask.query } as const;
  const on = manage.data?.mail === true;
  const pages = usePages(`mail-threads-${on}-${query.view}-${label}-${query.unread}-${q}-${JSON.stringify(ask.query)}`, (before, signal) =>
    on ? api.mailThreads(query, before, signal) : Promise.resolve({ threads: [], next: null }),
  );
  const hidden = useHidden();
  const threads = pages.pages.flatMap((page) => page.threads).filter((t) => !hidden.has(threadKey(t)));
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const chosen = threads.filter((t) => selected.has(threadKey(t)));
  const { press, error } = useMailPress();
  const act = (what: 'archive' | 'read' | 'unread') => press(chosen, what, () => setSelected(new Set()));
  const names = new Map((manage.data?.labels ?? []).map((l) => [l.id, l.name] as const));
  const now = useNow();
  const periods: { title: string | null; rows: MailThread[] }[] = [];
  for (const thread of threads) {
    const title = now === null ? null : period(thread.newestAt, now);
    const last = periods.at(-1);
    if (last?.title === title) last.rows.push(thread);
    else periods.push({ title, rows: [thread] });
  }
  const refs = threads.map((t) => ({ ...newest(t), subject: t.subject, threadId: t.threadId }));

  if (manage.data && !on)
    return (
      <Callout title="Inbox is off" action={<TurnInboxOn label="Turn Inbox on" />}>
        <p>
          Read and handle your mail here, with what Sift thinks of each message beside it. Sift keeps a copy of the mail in your inbox to show it; turning Inbox
          off deletes that copy.
        </p>
      </Callout>
    );

  const narrowed = q !== '' || label !== '' || unread === '1' || view !== 'all' || ask.narrowed;
  return (
    <ListView
      search={{ value: search, onChange: setSearch, placeholder: 'Search mail', ask: { onAsk: () => ask.ask(search.trim()), busy: ask.busy } }}
      view={{ label: 'Show', value: view, options: VIEWS, onChange: (next) => setView(next === 'all' ? '' : (next as MailView)) }}
      filters={{
        active: [
          ...(label === '' ? [] : [{ label: `Label: ${names.get(label) ?? label}`, clear: () => setLabel('') }]),
          ...(unread === '1' ? [{ label: 'Unread', clear: () => setUnread('') }] : []),
          ...ask.active,
        ],
        panel: (
          <>
            <FilterGroup label="Label" value={label} options={[['', 'Any'] as const, null, ...inboxFirst(names)]} onChange={setLabel} />
            <Check checked={unread === '1'} onChange={(next) => setUnread(next ? '1' : '')}>
              Unread
            </Check>
          </>
        ),
      }}
      selected={{
        count: chosen.length,
        clear: () => setSelected(new Set()),
        actions: [
          { label: 'Archive', key: 'e', onPress: () => act('archive') },
          { label: 'Mark read', key: 'Shift+i', onPress: () => act('read') },
          { label: 'Mark unread', key: 'Shift+u', onPress: () => act('unread') },
        ],
      }}
    >
      {pages.error ? <ErrorNote message={pages.error} /> : null}
      {error ? <ErrorNote message={error} /> : null}
      <Failure>{ask.error}</Failure>
      {ask.said ? (
        <Note>
          <p>{ask.said}</p>
        </Note>
      ) : null}
      {pages.loading || !manage.data ? (
        loadingRows
      ) : threads.length === 0 ? (
        <Empty>{q !== '' || ask.narrowed ? 'No mail matches.' : narrowed ? 'Nothing in your inbox matches.' : 'Nothing is in your inbox.'}</Empty>
      ) : (
        <>
          <Table keys>
            <Heads>
              <Th phone="hide">Select</Th>
              <Th>From</Th>
              <Th phone="hide">Subject</Th>
              <Th phone="hide">Label</Th>
              <Th phone="hide">Received</Th>
            </Heads>
            {periods.map(({ title, rows }) => (
              <tbody key={title ?? ''}>
                {title ? <TrGroup title={title} span={5} /> : null}
                {rows.map((thread) => (
                  <ThreadRow
                    key={threadKey(thread)}
                    thread={thread}
                    selected={selected.has(threadKey(thread))}
                    onSelect={(next) =>
                      setSelected((was) => {
                        const changed = new Set(was);
                        if (next) changed.add(threadKey(thread));
                        else changed.delete(threadKey(thread));
                        return changed;
                      })
                    }
                    onOpen={() => onOpen(refs, threads.indexOf(thread))}
                  />
                ))}
              </tbody>
            ))}
          </Table>
          {pages.more ? <More onReach={pages.next} /> : null}
        </>
      )}
    </ListView>
  );
}
