'use client';
import Link from 'next/link';
import type { ComponentProps, MouseEvent } from 'react';
import { useStale } from '@/lib/build.ts';
import { goToQuery } from '@/lib/params.ts';
import { LinkPending } from './loading-bar.tsx';

/** Paths Sift's server answers itself (the API, signing in); a link to one loads it. */
const SERVER = /^\/(api|auth)(\/|$)/;

/** A link to this page with another query (a name on its sender's page), which only narrows what it shows. */
const samePath = (href: string) => typeof window !== 'undefined' && href.startsWith(`${window.location.pathname}?`);

const plainPress = (event: MouseEvent) => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Every link a part draws. To a screen of the dashboard it is Next.js's `Link`, which goes there without loading the
 * page again, and fetches the screen ahead from the build's files: only the frame around it is drawn per request
 * (`app/(dashboard)/layout.tsx`); while one it had not fetched is on its way, the `LoadingBar` runs. A link that only changes the query (`?settings=1`) opens what it names over the
 * page, and Back closes it, without asking the server for anything. Anything else is a plain link. A press with a
 * modifier key, or on a link that opens a new tab, is the browser's. Once Sift has been updated under the page (`useStale`),
 * a link to a screen loads it whole. `replace`: the screen takes the place of the history entry the page is on.
 */
export function Anchor({ href, onClick, replace, children, ...props }: ComponentProps<'a'> & { href: string; replace?: boolean }) {
  const stale = useStale();
  if (href.startsWith('?') || samePath(href))
    return (
      <a
        href={href}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented || !plainPress(event) || props.target) return;
          event.preventDefault();
          goToQuery(href.slice(href.indexOf('?') + 1), { state: null });
        }}
        {...props}
      >
        {children}
      </a>
    );
  if (href.startsWith('/') && !SERVER.test(href) && !props.target && !stale)
    return (
      <Link href={href} {...(onClick ? { onClick } : {})} {...(replace ? { replace } : {})} {...props}>
        {children}
        <LinkPending />
      </Link>
    );
  return (
    <a
      href={href}
      onClick={(event) => {
        onClick?.(event);
        if (!replace || event.defaultPrevented || !plainPress(event) || props.target) return;
        event.preventDefault();
        window.location.replace(href);
      }}
      {...props}
    >
      {children}
    </a>
  );
}
