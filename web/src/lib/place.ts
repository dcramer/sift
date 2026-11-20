import { useEffect } from 'react';

const KEY = 'sift:place';
/** What the reader does that says they have moved on from where the page was. */
const MOVED = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;
/** How long a list is waited for to grow back to where it was. */
const WAIT_MS = 10_000;

const here = () => window.location.pathname + window.location.search;

/** How far down this address was when the page was last left, in this tab. */
function keptHere(): number | null {
  try {
    const kept = JSON.parse(window.sessionStorage.getItem(KEY) ?? 'null') as { at?: unknown; y?: unknown } | null;
    return kept?.at === here() && typeof kept.y === 'number' ? kept.y : null;
  } catch {
    return null;
  }
}

/**
 * Where the page was scrolled to, kept for this tab and taken up again after a reload. The browser's own restoring
 * gives up, since the list is fetched after the page loads and is too short then: this scrolls as it grows back,
 * a list read a page at a time reading the next as each end is reached, until it is there or the reader moves.
 */
export function useKeptPlace() {
  useEffect(() => {
    const keep = () => {
      try {
        window.sessionStorage.setItem(KEY, JSON.stringify({ at: here(), y: Math.round(window.scrollY) }));
      } catch {
        // Not kept: a reload starts at the top.
      }
    };
    const hidden = () => document.visibilityState === 'hidden' && keep();
    window.addEventListener('pagehide', keep);
    document.addEventListener('visibilitychange', hidden);
    const forget = () => {
      window.removeEventListener('pagehide', keep);
      document.removeEventListener('visibilitychange', hidden);
    };

    const kept = keptHere();
    const [loaded] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
    const y = kept ?? 0;
    if (loaded?.type !== 'reload' || y <= 0) return forget;

    window.history.scrollRestoration = 'manual';
    const reach = () => {
      window.scrollTo(0, y);
      if (Math.abs(window.scrollY - y) < 2) stop();
    };
    const grows = new ResizeObserver(reach);
    const timer = setTimeout(() => stop(), WAIT_MS);
    function stop() {
      grows.disconnect();
      clearTimeout(timer);
      for (const event of MOVED) window.removeEventListener(event, stop);
      window.history.scrollRestoration = 'auto';
    }
    grows.observe(document.body);
    for (const event of MOVED) window.addEventListener(event, stop, { passive: true });
    return () => {
      stop();
      forget();
    };
  }, []);
}
