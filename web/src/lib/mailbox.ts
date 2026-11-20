import { useSyncExternalStore } from 'react';

/**
 * The mailbox the reader narrowed the dashboard to, `''` for all of them. Kept in this browser: it is the reader's
 * convenience, not the person's mail, and the server draws every page for all mailboxes.
 */
const STORE = 'sift:mailbox';
const listeners = new Set<() => void>();

function stored(): string {
  try {
    return window.localStorage.getItem(STORE) ?? '';
  } catch {
    return '';
  }
}

let chosen = typeof window === 'undefined' ? '' : stored();

export function chooseMailbox(next: string): void {
  chosen = next;
  try {
    if (next) window.localStorage.setItem(STORE, next);
    else window.localStorage.removeItem(STORE);
  } catch {
    // Not remembered; still narrowed until the page is closed.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The one chosen in this browser, while it is still one of several `mailboxes`; otherwise all of them. */
export function useChosenMailbox(mailboxes: readonly string[]): string {
  const choice = useSyncExternalStore(
    subscribe,
    () => chosen,
    () => '',
  );
  return mailboxes.length > 1 && mailboxes.includes(choice) ? choice : '';
}
