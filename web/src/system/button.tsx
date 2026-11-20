'use client';
import { type ComponentProps, type ReactNode, useId, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Anchor } from './anchor.tsx';
import { ariaKeys, useShortcut } from './keys.tsx';
import { Tooltip } from './tooltip.tsx';

const BASE =
  'press inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 border border-transparent font-semibold whitespace-nowrap select-none aria-disabled:pointer-events-none disabled:pointer-events-none [&_svg]:size-[1.15em] [&_svg]:shrink-0';

/** What is filled when it can be pressed is an outline in quiet ink while it cannot. A busy press keeps its look. */
const UNPRESSABLE =
  'disabled:not-aria-busy:border-(--frame) disabled:not-aria-busy:bg-transparent disabled:not-aria-busy:text-muted-foreground aria-disabled:border-(--frame) aria-disabled:bg-transparent aria-disabled:text-muted-foreground aria-busy:opacity-60';

const VARIANT = {
  /** The one thing on the screen that is waiting on the reader. At most one per screen, and never repeated down a list. */
  mark: `bg-highlight font-semibold text-highlight-ink hover:brightness-105 ${UNPRESSABLE}`,
  /** What finishes a dialog or a form, and the choice that is on in a group. Never repeated down a list. */
  ink: `bg-foreground font-semibold text-background hover:bg-foreground/85 ${UNPRESSABLE}`,
  /** A page's own action (adding to its list), and everything else that is not repeated. */
  plain: `bg-(--fill) hover:bg-(--fill-strong) ${UNPRESSABLE}`,
  /** A press that destroys what nothing brings back, said once (a panel's Remove, Delete account…): red words, filled only when pointed at. Never down a list. */
  danger: `text-destructive hover:bg-(--fill) ${UNPRESSABLE}`,
  /** The press that does the destroying, once asked: red, with dark words, as a failure's toast has (light words on that red cannot be read). */
  destroy: `bg-destructive font-semibold text-background hover:brightness-110 ${UNPRESSABLE}`,
  /** Actions that repeat down a list (they firm up when their row is pointed at), and ways out. */
  quiet:
    'text-foreground/75 hover:bg-(--fill) hover:text-foreground group-hover/row:bg-(--fill-strong) group-hover/row:text-foreground disabled:opacity-45 aria-disabled:opacity-45',
} as const;

/** `md` everywhere a control sits in a row or a toolbar; `lg` for the one action a screen is about; `icon` for an icon alone, with an `aria-label`. */
const SIZE = {
  md: 'h-(--control) px-3 text-sm',
  icon: 'size-(--control) text-sm',
  lg: 'h-12 px-5 text-base',
} as const;

interface Own {
  variant?: keyof typeof VARIANT;
  size?: keyof typeof SIZE;
  /** Waiting on something this press started. Stops further presses. */
  busy?: boolean;
  /**
   * The key that presses this, drawn beside its label. A string when the button's label is plain text;
   * otherwise the key with a few words for the list of all keys. Inside a table row it is live, and
   * shown, only on the row the reader is on.
   */
  shortcut?: string | { key: string; label: string };
  /**
   * Why it cannot be pressed now, shown on hover and read with the button. Given only with `disabled`. A
   * disabled button takes no pointer, so the reason sits on what holds it.
   */
  why?: string;
  children: ReactNode;
}

type Props = Own & (({ href: string } & Omit<ComponentProps<'a'>, 'children'>) | ({ href?: undefined } & Omit<ComponentProps<'button'>, 'children'>));

/** Something you press. Given `href` it is a link that looks the same. */
export function Button({ variant = 'plain', size = 'md', busy = false, shortcut, why, className, children, ...rest }: Props) {
  const classes = cn(BASE, VARIANT[variant], SIZE[size], busy && 'pointer-events-none', className);
  const element = useRef<HTMLButtonElement & HTMLAnchorElement>(null);
  const reason = useId();
  const key = typeof shortcut === 'string' ? shortcut : shortcut?.key;
  const hint = useShortcut(
    key,
    typeof shortcut === 'object' ? shortcut.label : typeof children === 'string' ? children : '',
    () => element.current?.click(),
    variant === 'mark' || variant === 'ink' ? { tone: 'ink' as const } : {},
  );
  const content = (
    <>
      {children}
      {hint}
      {busy ? <span aria-hidden className="busy-dots" /> : null}
    </>
  );
  if (rest.href !== undefined) {
    return (
      <Anchor ref={element} className={classes} aria-busy={busy || undefined} {...(key ? { 'aria-keyshortcuts': ariaKeys(key) } : {})} {...rest}>
        {content}
      </Anchor>
    );
  }
  const { type = 'button', disabled, ...button } = rest;
  const explained = disabled && why !== undefined;
  const pressable = (
    <button
      ref={element}
      type={type}
      className={classes}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...(explained ? { 'aria-describedby': reason } : {})}
      {...(key ? { 'aria-keyshortcuts': ariaKeys(key) } : {})}
      {...button}
    >
      {content}
    </button>
  );
  if (!explained) return pressable;
  return (
    <Tooltip says={why} className="inline-flex cursor-not-allowed">
      {pressable}
      <span id={reason} className="sr-only">
        {why}
      </span>
    </Tooltip>
  );
}

/**
 * The `ink` press that finishes what is being written in a layer (the composer's Send): ⌘↵, or Ctrl ↵ off a Mac, presses it
 * from anywhere in the layer, typing included, since the chord types nothing.
 */
export function Finish({
  children,
  ...rest
}: Omit<Own, 'variant' | 'shortcut' | 'children'> & Omit<ComponentProps<'button'>, 'children'> & { children: string }) {
  return (
    <Button variant="ink" shortcut="Mod+Enter" {...rest}>
      {children}
    </Button>
  );
}
