import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip } from './tooltip.tsx';
import { Anchor } from './anchor.tsx';

/** A stroke of highlighter. It means "look here", so a screen has few of them. */
export function Highlight({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('hl', className)}>{children}</span>;
}

/** The name, always highlighted. */
export function Wordmark({ size = 'md' }: { size?: 'md' | 'lg' }) {
  return (
    <span className={cn('wordmark', size === 'lg' && 'large')}>
      <span className="hl mx-0 px-[0.35em] py-[0.08em]">sift</span>
    </span>
  );
}

/** `text` with every occurrence of `term` highlighted, as a search result would be marked by hand. */
export function Marked({ text, term }: { text: string; term?: string }) {
  const needle = term?.trim().toLowerCase();
  if (!needle) return <>{text}</>;
  const parts: ReactNode[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at));
    parts.push(
      <mark key={at} className="hl mx-0 px-0.5">
        {text.slice(at, at + needle.length)}
      </mark>,
    );
    from = at + needle.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/** Something typed or pasted: a command, an address, a setting. */
export function Code({ children }: { children: ReactNode }) {
  return <code className="rounded-[2px] bg-foreground/8 px-[0.35em] py-[0.1em] font-mono text-[0.9em]">{children}</code>;
}

/**
 * One thing about what it follows, as a small icon after it, said in words when pointed at. `look` is yellow. `said`
 * puts the words beside the icon instead, where they are the point (under a sender's name on their own page).
 */
export function Hint({ icon: Icon, says, tone = 'plain', said }: { icon: LucideIcon; says: string; tone?: 'plain' | 'look'; said?: boolean }) {
  if (said)
    return (
      <span>
        <Icon
          aria-hidden
          className={cn('mr-1.5 inline size-3.5 align-[-0.125em]', tone === 'look' ? 'text-highlight' : 'text-muted-foreground')}
          strokeWidth={2.25}
        />
        {says}
      </span>
    );
  return (
    <Tooltip says={says} className={cn('inline-flex shrink-0', tone === 'look' ? 'text-highlight' : 'text-muted-foreground')}>
      <Icon aria-hidden className="size-3.5" strokeWidth={2.25} />
      <span className="sr-only">{says}</span>
    </Tooltip>
  );
}

/**
 * A link inside text or a cell: underlined, so it reads as one without colour. `away` opens another
 * site in a new tab, so the reader comes back to where they were.
 */
export function TextLink({ href, away, children, className }: { href: string; away?: boolean; children: ReactNode; className?: string }) {
  return (
    <Anchor
      href={href}
      {...(away ? { target: '_blank', rel: 'noreferrer' } : {})}
      className={cn('underline decoration-foreground/35 underline-offset-[0.2em] hover:decoration-foreground', className)}
    >
      {children}
    </Anchor>
  );
}

/**
 * A key on the keyboard, drawn as a small keycap beside the control it presses. `ink` is for a cap on a
 * filled control (the highlighted button, the choice that is on), where it takes the control's own ink.
 */
export function Kbd({ children, tone, className }: { children: ReactNode; tone?: 'ink'; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[1.5em] min-w-[1.5em] items-center justify-center rounded-(--cut) border px-[0.35em] font-mono text-label leading-none font-normal',
        tone === 'ink' ? 'border-current/40 opacity-80' : 'border-(--frame) text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** A word in yellow ink for what is left to the reader, inside a line ("Not sure"). Like every yellow, few on a screen. */
export function Look({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-highlight">{children}</span>;
}
