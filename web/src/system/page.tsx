import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Narrowed } from './mailbox.tsx';
import { Blank } from './state.tsx';
import { ListHead } from './list-view.tsx';

/**
 * The top of a page: its name, and on the right the page's own action or one quiet line of numbers, the
 * two centred on each other. `badge` sits beside the title, for a stamp that says what the page's subject
 * is; `meta` is a line under it naming that subject (a sender's address), and `null` holds its room
 * until it is known. The mailbox the dashboard is narrowed to, if any, follows the title. No count and no explanation. On a phone the action stays beside a title alone; a title
 * with a line under it keeps its width, and the action goes under it.
 */
export function PageHeader({ title, badge, meta, actions }: { title: ReactNode; badge?: ReactNode; meta?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3">
      <div className={cn('min-w-0 flex-1', meta === undefined ? 'basis-40' : 'basis-64')}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="statement min-w-0 wrap-anywhere">{title}</h1>
          {badge}
          <Narrowed />
        </div>
        {meta === undefined ? null : <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">{meta ?? <Blank />}</div>}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/**
 * The page a list is on: its header, with the page's own action, then the `ListView`. Every screen that lists
 * something is one. The server draws it; what is in it that moves or loads is the `ListView` and the action.
 */
export function ListPage({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <ListHead title={title} actions={actions}>
      {children}
    </ListHead>
  );
}

/**
 * A part of a page or a panel under its own heading: the heading, a count or short fact beside it, and
 * at most one action on the right. Space sets it apart; it has no rule or box.
 */
export function Section({
  title,
  meta,
  action,
  children,
  className,
}: {
  title: string;
  meta?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-3', className)}>
      <header className="flex min-h-(--control) flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="heading">{title}</h2>
        {meta ? <span className="text-muted-foreground tabular-nums">{meta}</span> : null}
        {action ? <div className="ml-auto flex items-center gap-2">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}
