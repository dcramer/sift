'use client';
import { ArrowLeftIcon, ChevronDownIcon, ChevronUpIcon, EllipsisVerticalIcon, ReplyIcon } from 'lucide-react';
import { type ComponentProps, type ReactNode, type Ref, createContext, useContext, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { AnswerPicker } from './answer-picker.tsx';
import { Button } from './button.tsx';
import { keyName, useShortcut } from './keys.tsx';
import { Menu } from './menu.tsx';
import { Heads, Table, Td, Th, Tr } from './table.tsx';
import { Tooltip } from './tooltip.tsx';
import { Kbd } from './type.tsx';

/** As wide as a line of mail reads well, and as wide as a 600px email with room either side. */
const READING = 'max-w-[46rem]';

/**
 * One message or conversation, opened from a list in the list's place, inside the frame: the bar (`ReaderBar`), the
 * subject as the page's heading, Sift's part (`AnswerRow`), then the conversation and whatever answers it. `side` is a
 * column beside the conversation on a wide screen, and under it narrower, for what is said about the message rather
 * than in it. It takes the focus as it opens, so Enter presses nothing and the keys are its own.
 */
export function Reader({
  ref,
  bar,
  title,
  answer,
  side,
  children,
}: {
  ref?: Ref<HTMLElement>;
  bar: ReactNode;
  title: ReactNode;
  answer?: ReactNode;
  side?: ReactNode;
  children: ReactNode;
}) {
  const own = useRef<HTMLElement>(null);
  useImperativeHandle(ref, () => own.current!, []);
  // Unless what it opened with took the focus first: a reply opened by its address.
  useEffect(() => {
    if (!own.current?.contains(document.activeElement)) own.current?.focus({ preventScroll: true });
  }, []);
  const heading = useId();
  return (
    <section ref={own} tabIndex={-1} aria-labelledby={heading} className="flex flex-col gap-4 outline-none">
      <div className={READING}>{bar}</div>
      <div className={cn('flex flex-col gap-3 phone:gap-2', READING)}>
        <h1 id={heading} className="statement subject wrap-anywhere">
          {title}
        </h1>
        {answer}
      </div>
      <div className={side ? 'mt-4 flex flex-col gap-12 xl:grid xl:grid-cols-[minmax(0,46rem)_20rem] xl:items-start xl:gap-16' : cn('mt-4', READING)}>
        <div className="flex min-w-0 flex-col gap-6">{children}</div>
        {side ? <aside className="flex min-w-0 flex-col gap-8">{side}</aside> : null}
      </div>
    </section>
  );
}

const NO_PRESSES: readonly Press[] = [];

interface Press {
  label: string;
  key: string;
  onPress: () => void;
  disabled?: boolean;
  quiet?: boolean;
}

/** Presses on what the reader shows, each with its key, on one line: Archive and Mark unread in its bar, Reply, Reply all and Forward under the conversation. */
export function Presses({ presses }: { presses: readonly Press[] }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {presses.map((p) => (
        <Button key={p.label} {...(p.quiet ? { variant: 'quiet' as const } : {})} shortcut={p.key} disabled={p.disabled} onClick={p.onPress}>
          {p.label}
        </Button>
      ))}
    </span>
  );
}

/**
 * The top of the reader: back to the list by its name (Esc), the presses on what it shows, where it is in the list,
 * and previous and next (K and J, or ← and →). On a phone the presses take a line under Back, without keycaps; nothing wraps.
 */
export function ReaderBar({
  back,
  onBack,
  presses = NO_PRESSES,
  position,
  onPrevious,
  onNext,
}: {
  /** The list's name: "Inbox". */
  back: string;
  onBack: () => void;
  presses?: readonly Press[];
  /** "3 of 12". */
  position?: string | undefined;
  onPrevious?: (() => void) | undefined;
  onNext?: (() => void) | undefined;
}) {
  const stepping = onPrevious !== undefined || onNext !== undefined;
  return (
    <div className="flex items-center gap-x-3 phone:gap-x-1.5">
      <Button
        variant="quiet"
        className="-ml-3 phone:w-11 phone:justify-center phone:px-0"
        aria-label={`Back to ${back}`}
        shortcut={{ key: 'Escape', label: 'Back to the list' }}
        onClick={onBack}
      >
        <ArrowLeftIcon aria-hidden />
        <span className="phone:hidden">{back}</span>
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        {presses.length > 0 ? <Presses presses={presses} /> : null}
        {position ? <span className="ml-auto px-2 text-sm whitespace-nowrap text-muted-foreground tabular-nums phone:hidden">{position}</span> : null}
        {stepping && !position ? <span className="ml-auto" /> : null}
        {stepping && position ? <span className="ml-auto md:hidden" /> : null}
        {stepping ? (
          <>
            <Step label="Previous" keys={['k', 'ArrowLeft']} onPress={onPrevious} icon={<ChevronUpIcon aria-hidden />} />
            <Step label="Next" keys={['j', 'ArrowRight']} onPress={onNext} icon={<ChevronDownIcon aria-hidden />} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** Previous or next in the list. Its keys work only while there is somewhere to go; the first is drawn. */
function Step({ label, keys, onPress, icon }: { label: string; keys: readonly string[]; onPress: (() => void) | undefined; icon: ReactNode }) {
  const hint = useShortcut(keys, label, () => onPress?.(), { enabled: onPress !== undefined });
  return (
    <Button variant="quiet" aria-label={label} aria-keyshortcuts={keys.join(' ')} disabled={!onPress} onClick={() => onPress?.()} className="px-2">
      {icon}
      {hint ? <Kbd className="hidden md:inline-flex">{keyName(keys[0])}</Kbd> : null}
    </Button>
  );
}

/**
 * Sift's part of the reader, on one line under the title: what the message is (an `AnswerPicker`, agreed in one
 * press), Why, and the presses that make a rule (`children`). Why opens what Sift said under the line; `whyOpen` starts
 * it open, where answering is the job (For review). On a phone the picker takes what the presses leave.
 */
export function AnswerRow({
  picker,
  why,
  whyOpen = false,
  children,
}: {
  picker: ComponentProps<typeof AnswerPicker>;
  why?: ReactNode;
  whyOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(whyOpen);
  const said = useId();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-1">
        <AnswerPicker {...picker} className={cn('min-w-0 phone:flex-1 md:w-72', picker.className)} />
        {why ? (
          <Button variant="quiet" className="ml-1" aria-expanded={open} aria-controls={said} onClick={() => setOpen(!open)}>
            Why
          </Button>
        ) : null}
        {children}
      </div>
      {why && open ? (
        <div id={said} className="flex flex-col gap-3 text-muted-foreground">
          {why}
        </div>
      ) : null}
    </div>
  );
}

/** A message of a conversation as `MessageStack` lists it. */
interface Listed {
  id: string;
  /** Who sent it, in words: its folded row, and what its presses are called. */
  from: string;
  /** The first line of its text. */
  preview: string | null;
  at: ReactNode;
}

/**
 * Past this many messages a conversation folds its middle into one "N more" row, keeping the first and the last two
 * in sight, so a long one opens on its end. Messages open in the middle stay out of it.
 */
const FOLDS_PAST = 5;
const KEPT_AT_END = 2;

/** What the head of an open message in a `MessageStack` can do: fold it again, named by its sender. */
const Opened = createContext<{ from: string; fold: (() => void) | null }>({ from: '', fold: null });

type Item = { open: Listed } | { folded: Listed } | { more: Listed[] };

/**
 * A conversation, oldest first, read by scrolling the page: each message open (`children` draws it, a `MessageHead`
 * over its text) or folded to a row of who sent it, its first line and when. A press on a folded row opens it in
 * place and a press on an open one's head folds it, so several can be open at once. One message alone is open and
 * stays so.
 */
export function MessageStack({
  messages,
  open,
  onToggle,
  children,
}: {
  messages: readonly Listed[];
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
  children: (id: string) => ReactNode;
}) {
  const [whole, setWhole] = useState(false);
  const alone = messages.length === 1;
  const hides = (i: number) => !whole && messages.length > FOLDS_PAST && i > 0 && i < messages.length - KEPT_AT_END;
  const items: Item[] = [];
  for (const [i, m] of messages.entries()) {
    const last = items.at(-1);
    if (alone || open.has(m.id)) items.push({ open: m });
    else if (!hides(i)) items.push({ folded: m });
    else if (last && 'more' in last) last.more.push(m);
    else items.push({ more: [m] });
  }
  // Folded rows next to each other are one table; each open message stands alone between them.
  const runs: (Listed | Item[])[] = [];
  for (const item of items) {
    const last = runs.at(-1);
    if ('open' in item) runs.push(item.open);
    else if (Array.isArray(last)) last.push(item);
    else runs.push([item]);
  }
  const row = (m: Listed) => (
    <Tr key={m.id} onOpen={() => onToggle(m.id)}>
      <Td className="w-full max-w-0">
        <span className="flex items-baseline gap-3">
          <span className="shrink-0 font-semibold">{m.from}</span>
          <span className="min-w-0 truncate text-muted-foreground">{m.preview}</span>
        </span>
      </Td>
      <Td num quiet>
        {m.at}
      </Td>
    </Tr>
  );
  return (
    <div className="flex min-w-0 flex-col">
      {runs.map((run) =>
        Array.isArray(run) ? (
          <div key={`folded/${'folded' in run[0] ? run[0].folded.id : 'more' in run[0] ? run[0].more[0].id : ''}`} className="row py-1">
            <Table>
              <Heads>
                <Th>From</Th>
                <Th num>Received</Th>
              </Heads>
              <tbody>
                {run.map((item) =>
                  'folded' in item ? (
                    row(item.folded)
                  ) : 'more' in item && item.more.length > 1 ? (
                    <Tr key={`more/${item.more[0].id}`} onOpen={() => setWhole(true)}>
                      <Td colSpan={2} className="font-semibold text-muted-foreground">
                        {item.more.length} more
                      </Td>
                    </Tr>
                  ) : 'more' in item ? (
                    row(item.more[0])
                  ) : null,
                )}
              </tbody>
            </Table>
          </div>
        ) : (
          <article key={run.id} className="row flex min-w-0 flex-col gap-4 py-5 first:pt-1">
            <Opened value={{ from: run.from, fold: alone ? null : () => onToggle(run.id) }}>{children(run.id)}</Opened>
          </article>
        ),
      )}
    </div>
  );
}

interface Answers {
  reply: () => void;
  all: () => void;
  forward: () => void;
}

/**
 * Who wrote a message and when, over its text: the name, the address after it (not on a phone), the time at the right,
 * who it went to under them. In a `MessageStack` of several, a press anywhere on it but a link folds the message.
 * `answers` puts Reply, and Reply all and Forward behind one more press, at its end, for answering this message
 * rather than the newest.
 */
export function MessageHead({ from, address, at, to, answers }: { from: ReactNode; address?: ReactNode; at: ReactNode; to?: ReactNode; answers?: Answers }) {
  const opened = useContext(Opened);
  // Laid over by the head's words, which let a press through to it but on a link or a button of their own.
  const through = 'pointer-events-none relative [&_a]:pointer-events-auto [&_button]:pointer-events-auto';
  return (
    <header className="relative flex flex-col gap-1">
      {opened.fold ? (
        <button
          type="button"
          aria-expanded
          aria-label={`Fold the message from ${opened.from}`}
          onClick={opened.fold}
          className="absolute -inset-x-(--bleed) -inset-y-2 cursor-pointer hover:bg-(--fill)"
        />
      ) : null}
      <div className={cn('flex items-center gap-x-3', through)}>
        <span className="flex min-w-0 flex-1 items-baseline gap-x-2">
          <span className="name flex min-w-0 items-baseline gap-1.5 [&>a]:truncate">{from}</span>
          {address ? <span className="min-w-0 truncate text-sm text-muted-foreground max-sm:hidden">{address}</span> : null}
        </span>
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{at}</span>
        {answers ? (
          <span className="-my-1 -mr-2 flex shrink-0 items-center">
            <Tooltip says="Reply">
              <Button variant="quiet" size="icon" aria-label={`Reply to ${opened.from}`} onClick={answers.reply}>
                <ReplyIcon aria-hidden />
              </Button>
            </Tooltip>
            <Menu
              label="Reply all or forward"
              align="end"
              trigger={
                <span className="flex size-(--control) items-center justify-center text-foreground/75">
                  <EllipsisVerticalIcon aria-hidden className="size-[1.15em]" />
                </span>
              }
              items={[
                { label: 'Reply all', onSelect: answers.all },
                { label: 'Forward', onSelect: answers.forward },
              ]}
            />
          </span>
        ) : null}
      </div>
      {to ? <div className={cn('text-sm text-muted-foreground', through)}>{to}</div> : null}
    </header>
  );
}

/**
 * Writing in place at the foot of the conversation (Reply, Reply all, Forward): `about` says which message it answers
 * when that is not the newest, then its fields and text, and Send and Discard (`actions`) on a line under them. It
 * brings itself into view as it opens, under however much conversation is above it.
 */
export function ReplyBox({ label, about, actions, children }: { label: string; about?: ReactNode; actions: ReactNode; children: ReactNode }) {
  const own = useRef<HTMLElement>(null);
  // Braced: a browser may answer a scroll with a promise, which React would take for the effect's cleanup.
  useEffect(() => {
    own.current?.scrollIntoView({ block: 'nearest' });
  }, []);
  return (
    <section ref={own} aria-label={label} className="mt-2 flex scroll-mb-6 flex-col gap-4">
      {about ? <p className="text-sm text-muted-foreground">{about}</p> : null}
      {children}
      <div className="flex flex-wrap items-center gap-1.5">{actions}</div>
    </section>
  );
}
