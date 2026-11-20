'use client';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { keyName, useHintsShown } from './keys.tsx';
import { Kbd } from './type.tsx';

/**
 * The controls of the layer the reader is in, along its bottom edge the way a game lists its buttons:
 * the key first, then what it does. `start` is what the controls act on ("3 of 31"). On a phone the
 * controls that step through a list become wide buttons a thumb can reach.
 */
export function ControlBar({ start, children, className }: { start?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center gap-x-3 text-muted-foreground', className)}>
      {start ? <span className="px-2 text-sm whitespace-nowrap tabular-nums phone:order-2">{start}</span> : null}
      <div className="flex flex-1 items-center gap-1 phone:contents md:justify-end">{children}</div>
    </div>
  );
}

const PRESS =
  'press inline-flex h-(--control) shrink-0 cursor-pointer items-center gap-2 px-2 text-sm whitespace-nowrap hover:bg-(--fill) hover:text-foreground disabled:pointer-events-none disabled:opacity-35 phone:h-11 phone:flex-1 phone:justify-center';

/**
 * One control: its keys, then what it does. Given `onPress` (or the props of a button) it can be pressed
 * as well as keyed; without, it only says what a key does. A control whose key works only with hints
 * on, like the table's J and K, is left out by its caller when hints are off.
 */
export function Control({
  keys,
  label,
  icon,
  iconAfter,
  className,
  ...button
}: {
  keys: readonly string[];
  label: string;
  /** Drawn in place of the keys while they are not: on a touch screen, with keys turned off, or with none. */
  icon?: ReactNode;
  /** The icon follows the label, as Next's arrow does. */
  iconAfter?: boolean;
} & Omit<ComponentProps<'button'>, 'children'>) {
  const hints = useHintsShown() && keys.length > 0;
  const body = hints ? (
    <>
      <span className="inline-flex items-center gap-1">
        {keys.map((key) => (
          <Kbd key={key}>{keyName(key)}</Kbd>
        ))}
      </span>
      <span>{label}</span>
    </>
  ) : (
    <>
      {iconAfter ? null : icon}
      <span>{label}</span>
      {iconAfter ? icon : null}
    </>
  );
  if (!button.onClick) return <span className={cn('inline-flex items-center gap-2 px-2 text-sm whitespace-nowrap', className)}>{body}</span>;
  return (
    <button type="button" {...(keys.length > 0 ? { 'aria-keyshortcuts': keys.join(' ') } : {})} className={cn(PRESS, className)} {...button}>
      {body}
    </button>
  );
}
