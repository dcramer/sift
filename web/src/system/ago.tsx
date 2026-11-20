'use client';
import { useSyncExternalStore } from 'react';
import { ago, arrived, heard } from '@/lib/format.ts';

const MINUTE = 60_000;
const everyHalfMinute = (tick: () => void) => {
  const timer = setInterval(tick, MINUTE / 2);
  return () => clearInterval(timer);
};
const thisMinute = () => Math.floor(Date.now() / MINUTE);
const onServer = () => null;

/**
 * How long ago `at` was ("just now", "5 min ago", a date). Drawn only once the page runs in the browser: the
 * server's clock and time zone are not the reader's, and text the server drew differently would not match.
 */
export function Ago({ at }: { at: number }) {
  const now = useNow();
  return now === null ? null : <time dateTime={new Date(at).toISOString()}>{ago(at)}</time>;
}

/** When mail came, as a mail app says it under its day: "2:39 PM", "Tue", "Nov 6". Drawn in the browser, as `Ago` is. */
export function Arrived({ at }: { at: number }) {
  const now = useNow();
  return now === null ? null : <time dateTime={new Date(at).toISOString()}>{arrived(at, now)}</time>;
}

/** When a message in a conversation came, short: "7:32 PM" today, "Nov 19, 7:32 PM" before. Drawn in the browser, as `Ago` is. */
export function Heard({ at }: { at: number }) {
  const now = useNow();
  return now === null ? null : <time dateTime={new Date(at).toISOString()}>{heard(at, now)}</time>;
}

/** The time in the browser to the minute, kept current; null on the server, whose clock and zone are not the reader's. */
export function useNow(): number | null {
  const minute = useSyncExternalStore(everyHalfMinute, thisMinute, onServer);
  return minute === null ? null : minute * MINUTE;
}
