'use client';
import { Dialog } from '@base-ui/react/dialog';
import { MenuIcon, XIcon } from 'lucide-react';
import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { handOver, useBackCloses } from '@/lib/params.ts';
import { Anchor } from './anchor.tsx';
import { Button } from './button.tsx';
import { Cloud, FinePrint } from './fine-print.tsx';
import { type MailboxChoice, MailboxSwitch } from './mailbox.tsx';
import { Avatar, type MenuItem } from './menu.tsx';
import type { NavItem } from './rail.tsx';
import { Wordmark } from './type.tsx';
import { cn } from '@/lib/utils';

/**
 * The phone's top bar's own room, where a list puts its search: given by what draws the bar (the dashboard), `null` until
 * the bar is drawn. Without one (`undefined`), a list keeps its search on the page.
 */
export const BarSlot = createContext<HTMLElement | null | undefined>(undefined);

/** Draws `children` in the phone's top bar, while there is one: a list's search, in place of the name. */
export function ToBar({ children }: { children: ReactNode }) {
  const at = useContext(BarSlot);
  return at ? createPortal(children, at) : null;
}

/**
 * Whether the bar is out of the way: going down the page, past its top, until the reader scrolls back up. It keeps
 * `--bar` at the bar's height while it shows and at the status bar's while it does not, so what sticks under it (a
 * day's heading) follows it.
 */
function useAway(): [boolean, (bar: HTMLElement | null) => void] {
  const [away, setAway] = useState(false);
  const [bar, setBar] = useState<HTMLElement | null>(null);
  useEffect(() => {
    let last = window.scrollY;
    const moved = () => {
      const y = window.scrollY;
      if (Math.abs(y - last) < 6) return;
      setAway(y > last && y > 120);
      last = y;
    };
    window.addEventListener('scroll', moved, { passive: true });
    return () => window.removeEventListener('scroll', moved);
  }, []);
  useEffect(() => {
    if (!bar) return;
    const root = document.documentElement.style;
    const measured = new ResizeObserver(() => root.setProperty('--bar', away ? 'var(--safe-top)' : `${bar.offsetHeight}px`));
    measured.observe(bar, { box: 'border-box' });
    return () => {
      measured.disconnect();
      root.removeProperty('--bar');
    };
  }, [bar, away]);
  return [away, setBar];
}

const ICON_PRESS = 'press flex size-11 shrink-0 cursor-pointer items-center justify-center hover:bg-(--fill)';

/**
 * The top of every screen on a phone, where `Rail` is not shown: one outlined field, the menu button at its start, then
 * a list's search (`ToBar`) or the name. `aside` (Sift's line) is in the menu, not the bar.
 * The sections and `account` move into a panel that covers the screen, the sections followed by `FinePrint` as a list,
 * with `detail` (what `aside`'s hover card says, which a touch screen never shows) framed above the account, and the
 * `mailbox` the dashboard shows under whose they are. Back closes it; where a press in it goes takes its place in history.
 */
export function Masthead({
  items,
  current,
  aside,
  detail,
  mailbox,
  account,
  slot,
}: {
  slot?: (element: HTMLDivElement | null) => void;
  items: readonly NavItem[];
  current: string;
  aside?: ReactNode;
  detail?: ReactNode;
  mailbox?: MailboxChoice | undefined;
  account?: { name: string; items: readonly MenuItem[] } | undefined;
}) {
  const [open, setOpen] = useState(false);
  useBackCloses(open, () => setOpen(false));
  const leave = () => {
    handOver();
    setOpen(false);
  };
  // Going somewhere closes the panel.
  const [shownAt, setShownAt] = useState(current);
  if (shownAt !== current) {
    setShownAt(current);
    setOpen(false);
  }
  const cloud = useContext(Cloud);
  const [away, measure] = useAway();
  const here = items.find((item) => item.to === current);
  const waiting = items.reduce((sum, item) => sum + (item.count ?? 0), 0);

  // No sections: the page before it knows who is signed in, which may yet be the sign-in page, so the name alone.
  if (items.length === 0)
    return (
      <header className="flex items-center pt-[calc(1rem+var(--safe-top))] pb-6 md:hidden">
        {/* As tall as the row the menu button makes, so the name stays put as it arrives. */}
        <Anchor href="/" aria-label="Sift" className="flex min-h-11 items-center">
          <Wordmark />
        </Anchor>
      </header>
    );

  return (
    // One outlined field across the top, the menu at its start; on a list it is the list's search, and elsewhere the name.
    // It gets out of the way going down the page, and comes back going up.
    <header
      ref={measure}
      className={cn(
        'sticky top-0 z-20 -mx-4 bg-background px-4 pt-[calc(0.5rem+var(--safe-top))] pb-2 transition-[translate] duration-200 motion-reduce:transition-none md:hidden',
        away && '-translate-y-full',
      )}
    >
      <div className="flex h-12 items-center rounded-(--corner) border border-(--frame) transition-colors focus-within:border-foreground/45">
        <Dialog.Root open={open} onOpenChange={setOpen}>
          <Dialog.Trigger aria-label="Menu" className={`${ICON_PRESS} relative`}>
            <MenuIcon className="size-5" />
            {waiting > 0 && here?.count === undefined ? <span aria-hidden className="absolute top-2 right-2 size-2 rounded-full bg-highlight" /> : null}
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Popup className="fixed inset-0 z-50 flex flex-col overflow-y-auto bg-background pt-[calc(1rem+var(--safe-top))] pr-[max(1rem,var(--safe-right))] pb-[calc(2rem+var(--safe-bottom))] pl-[max(1rem,var(--safe-left))] outline-none transition-opacity duration-150 data-ending-style:pointer-events-none data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none md:hidden">
              <div className="flex items-center justify-between">
                <Wordmark />
                <Dialog.Title className="sr-only">Menu</Dialog.Title>
                <Dialog.Close aria-label="Close menu" className={`${ICON_PRESS} -mr-2`}>
                  <XIcon className="size-5" />
                </Dialog.Close>
              </div>
              <nav aria-label="Sections" className="mt-14">
                <ul className="flex flex-col gap-1">
                  {items.map((item) => (
                    <li key={item.to}>
                      <Anchor
                        href={`/${item.to}`}
                        aria-current={item.to === current ? 'page' : undefined}
                        className="statement flex min-h-12 items-center gap-3 text-muted-foreground"
                        replace
                        onClick={leave}
                      >
                        <span className={item.to === current ? 'hl mx-0 px-2' : undefined}>{item.label}</span>
                        {item.count ? <span className="text-base font-medium tabular-nums">{item.count}</span> : null}
                      </Anchor>
                    </li>
                  ))}
                </ul>
              </nav>
              {cloud ? (
                <div className="mt-8">
                  <FinePrint list />
                </div>
              ) : null}
              {aside || detail ? (
                <div className="sheet mt-auto flex flex-col gap-4 p-4 text-sm">
                  {aside ? <div className="text-muted-foreground">{aside}</div> : null}
                  {detail}
                </div>
              ) : null}
              {account ? (
                <div className={`${aside || detail ? 'mt-6' : 'mt-auto'} flex flex-col gap-4 border-t border-(--rule) pt-5`}>
                  <p className="flex items-center gap-3 text-sm text-muted-foreground">
                    <Avatar name={account.name} />
                    <span className="min-w-0 break-all">{account.name}</span>
                  </p>
                  {mailbox ? (
                    <MailboxSwitch
                      {...mailbox}
                      onChange={(chosen) => {
                        setOpen(false);
                        mailbox.onChange(chosen);
                      }}
                    />
                  ) : null}
                  <div className="grid auto-cols-fr grid-flow-col gap-2">
                    {account.items.map((item) => (
                      <Button
                        key={item.label}
                        disabled={item.disabled}
                        {...(item.note ? { why: item.note } : {})}
                        className="justify-center"
                        onClick={() => {
                          leave();
                          item.onSelect();
                        }}
                      >
                        {item.label}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
        <div ref={slot} className="peer flex min-w-0 flex-1 items-center self-stretch empty:hidden" />
        <Anchor href={`/${items[0]?.to ?? ''}`} aria-label="Sift" className="flex min-h-11 items-center peer-[:not(:empty)]:hidden">
          <Wordmark />
        </Anchor>
      </div>
    </header>
  );
}
