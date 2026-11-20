'use client';
import { MailIcon, MailsIcon } from 'lucide-react';
import { useContext } from 'react';
import { Mailbox } from '@/lib/narrowed.ts';
import { Select } from './select.tsx';

export interface MailboxChoice {
  mailboxes: readonly string[];
  /** `''` for all of them. */
  value: string;
  onChange: (mailbox: string) => void;
}

/**
 * Which of the person's mailboxes the dashboard shows: All mailboxes first, set apart, then each address. Nothing for
 * someone with one. `compact` is the rail's: an icon over All or the address, cut to the rail's width, with the choices
 * in full; otherwise a select as wide as what holds it.
 */
export function MailboxSwitch({ mailboxes, value, onChange, compact = false }: MailboxChoice & { compact?: boolean }) {
  if (mailboxes.length < 2) return null;
  const Icon = value ? MailIcon : MailsIcon;
  return (
    <Select
      label={`Mailbox, ${value || 'All mailboxes'}`}
      value={value}
      options={[['', 'All mailboxes'], null, ...mailboxes.map((mailbox) => [mailbox, mailbox] as const)]}
      onChange={onChange}
      {...(compact
        ? {
            face: (
              <span className="flex w-14 flex-col items-center gap-1 py-1.5 text-label font-semibold text-muted-foreground">
                <Icon aria-hidden className="size-5" strokeWidth={1.75} />
                <span className="w-full truncate text-center">{value || 'All'}</span>
              </span>
            ),
          }
        : { wide: true })}
    />
  );
}

/** The mailbox the page is narrowed to, beside its title, so a list that looks short says why. */
export function Narrowed() {
  const mailbox = useContext(Mailbox);
  return mailbox ? <span className="text-muted-foreground">{mailbox}</span> : null;
}
