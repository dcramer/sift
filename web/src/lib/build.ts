import { useSyncExternalStore } from 'react';

/** The build this page came with (next.config.js). */
const BUILT = process.env.SIFT_BUILD ?? null;

let stale = false;
const listeners = new Set<() => void>();

/**
 * Which build the server is, as `/api/session` says. Another than the page's means Sift was updated while the page was
 * open: the page carries on, and the next screen it goes to is loaded whole, from the new one.
 */
export function serverBuild(build: string | null): void {
  if (stale || !build || !BUILT || build === BUILT) return;
  stale = true;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** True once the server is another build than the page: a link loads the page it goes to. */
export const useStale = () =>
  useSyncExternalStore(
    subscribe,
    () => stale,
    () => false,
  );

export const isStale = () => stale;
