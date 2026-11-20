'use client';
import { type LucideIcon, SquarePenIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Anchor } from './anchor.tsx';
import { useShortcut } from './keys.tsx';
import { type MailboxChoice, MailboxSwitch } from './mailbox.tsx';
import { Avatar, Menu, type MenuItem } from './menu.tsx';
import { Wordmark } from './type.tsx';

export interface NavItem {
  /** The path, without the leading `/`. */
  to: string;
  label: string;
  icon: LucideIcon;
  /** Something waiting there, shown as a bubble on the icon's corner. */
  count?: number;
}

/**
 * The sections down the left of every screen on a desktop: the name at the top, then `compose` (writing a new message,
 * with Inbox on, also C, with no keycap: the rail is not a list worked through), then each section as its icon over
 * its name, the current one's icon in the highlighter, then at the foot `aside` (Sift's line, stacked), the
 * `mailbox` the dashboard shows, beside whose they are, and `account` (who is signed in, behind their `Avatar`). No fill; a line sets it apart. As tall as the window, and never taller
 * than what holds it. Given no sections it is the name alone, as `Masthead` is.
 */
export function Rail({
  items,
  current,
  aside,
  mailbox,
  account,
  compose,
}: {
  items: readonly NavItem[];
  current: string;
  compose?: (() => void) | undefined;
  aside?: ReactNode;
  mailbox?: MailboxChoice | undefined;
  account?: { name: string; items: readonly MenuItem[] } | undefined;
}) {
  return (
    <header className="sticky top-0 hidden h-svh max-h-full w-[calc(4.5rem+var(--safe-left))] shrink-0 flex-col items-center border-r border-(--frame) pt-[calc(1.25rem+var(--safe-top))] pb-[calc(1rem+var(--safe-bottom))] pl-(--safe-left) md:flex">
      <Anchor href={`/${items[0]?.to ?? ''}`} aria-label="Sift" className="flex min-h-(--control) items-center">
        <Wordmark />
      </Anchor>
      {compose ? <Compose onPress={compose} /> : null}
      {items.length > 0 ? (
        <nav aria-label="Sections" className={cn('w-full', compose ? 'mt-5' : 'mt-8')}>
          <ul className="flex flex-col items-center gap-3">
            {items.map(({ to, label, icon: Icon, count }) => (
              <li key={to}>
                <Anchor
                  href={`/${to}`}
                  aria-current={to === current ? 'page' : undefined}
                  className="group flex w-16 cursor-pointer flex-col items-center gap-1 text-label font-semibold text-muted-foreground hover:text-foreground aria-[current=page]:text-foreground"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'relative flex h-8 w-12 items-center justify-center transition-colors duration-100 motion-reduce:transition-none',
                      to === current ? 'hl mx-0' : 'rounded-(--corner) group-hover:bg-(--fill)',
                    )}
                  >
                    <Icon className="size-5" strokeWidth={1.75} />
                    {count ? (
                      <span className="absolute -top-1.5 -right-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-foreground px-1 text-label leading-none font-semibold text-background tabular-nums">
                        {count > 99 ? '99+' : count}
                      </span>
                    ) : null}
                  </span>
                  <span className="text-center">{label}</span>
                  {/* Read after the name ("For review 12"); the bubble is hidden from a screen reader. */}
                  {count ? <span className="sr-only">{count}</span> : null}
                </Anchor>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {aside || account ? (
        <div className="mt-auto flex flex-col items-center gap-4 text-label text-muted-foreground">
          {aside}
          {mailbox ? <MailboxSwitch {...mailbox} compact /> : null}
          {account ? (
            <Menu
              label={`Account, ${account.name}`}
              trigger={<Avatar name={account.name} />}
              heading={
                <>
                  <p className="slug text-muted-foreground">Signed in</p>
                  <p className="mt-1 font-medium break-all">{account.name}</p>
                </>
              }
              items={account.items}
            />
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

/** A new message: a press like a section's, set apart above them, and C from anywhere on the page, which `?` lists. */
function Compose({ onPress }: { onPress: () => void }) {
  void useShortcut('c', 'New message', onPress);
  return (
    <button
      type="button"
      onClick={onPress}
      aria-keyshortcuts="c"
      className="group mt-8 flex w-16 cursor-pointer flex-col items-center gap-1 text-label font-semibold text-muted-foreground hover:text-foreground"
    >
      <span
        aria-hidden
        className="flex h-8 w-12 items-center justify-center rounded-(--corner) bg-(--fill) text-foreground transition-colors duration-100 group-hover:bg-(--fill-strong) motion-reduce:transition-none"
      >
        <SquarePenIcon className="size-5" strokeWidth={1.75} />
      </span>
      <span className="text-center">Compose</span>
    </button>
  );
}
