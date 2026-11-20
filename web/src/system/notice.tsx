import type { ReactNode } from 'react';
import { Anchor } from './anchor.tsx';

/**
 * A state of sift itself, true on every screen, so it goes at the top of every page: sift cannot be reached, a
 * sign-in has expired. `look` is for one the reader has to do something about, with `href` and `action`
 * for where; plain ink with a pulse is for one that mends itself. News about one page is a `Note`.
 */
export function Notice({ tone = 'plain', href, action, children }: { tone?: 'plain' | 'look'; href?: string; action?: string; children: ReactNode }) {
  return (
    <p role="status" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium text-foreground">
      {tone === 'look' ? (
        <span className="hl mx-0">{children}</span>
      ) : (
        <>
          <span aria-hidden className="size-2 shrink-0 animate-pulse rounded-full border border-foreground motion-reduce:animate-none" />
          {children}
        </>
      )}
      {href && action ? (
        <Anchor className="underline underline-offset-2" href={href}>
          {action}
        </Anchor>
      ) : null}
    </p>
  );
}
