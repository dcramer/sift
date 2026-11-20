import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useStarted } from '@/system/started.ts';
import { isStale } from './build.ts';

/** A message as a list's rows name it (`holds`), which is how the panel finds its way back to one. */
export const messageKey = (m: { accountId: string; messageId: string }) => `${m.accountId}/${m.messageId}`;

const PROPOSAL = 'proposal/';

/** A proposal as For review's list names it, for hiding it while its dismissal is on its way. */
export const proposalKey = (p: { id: number }) => `${PROPOSAL}${p.id}`;

const THREAD = 'thread/';

/** A conversation as Inbox's list names it, for hiding it while its archive is on its way. */
export const threadKey = (t: { accountId: string; threadId: string }) => `${THREAD}${t.accountId}/${t.threadId}`;

export const isMessageKey = (key: string) => !key.startsWith(PROPOSAL) && !key.startsWith(THREAD);

/** The marks this page puts on a history entry: a panel opened over a list, or a layer over the page, which Back closes. */
interface Marks {
  panel?: boolean;
  layer?: string;
}

const layerOn = () => ((window.history.state ?? {}) as Marks).layer;
/** Layers' entries a press has handed to wherever it goes next, which takes the entry's place (`handOver`). */
const handed = new Set<string>();
let layers = 0;
/** The entry of a layer just closed, until it is taken off or another layer opening in the same draw takes it over. */
let releasing: string | null = null;

// The query this page last wrote, for the path it wrote it on. Read in its place, since a browser may refuse to
// rewrite the address too often (Safari, while someone types in a search box) and the page must still follow.
let wrote: { path: string; query: string } | null = null;
const listeners = new Set<() => void>();
const changed = () => {
  for (const listener of listeners) listener();
};
const current = () => (wrote && wrote.path === window.location.pathname ? wrote.query : window.location.search.slice(1));
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
};
/** The query of a layer's entry being taken off, for the entry under it (`leaveLayer`). */
let carrying: string | null = null;
// Registered as this module loads, so it runs before Next.js and the page follow the address: what a layer's entry
// was given reaches the entry under it before anything draws from that entry's own, which may name the layer again.
if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => {
    wrote = null;
    const query = carrying;
    carrying = null;
    if (query !== null && query !== window.location.search) goToQuery(query.slice(1));
  });

/**
 * Go to `query` on this path, through the History API, which Next.js follows (`useSearchParams`) without asking the
 * server for anything. With `push` it adds a history entry, so Back undoes it, marked with `push.state`; otherwise it
 * rewrites the current one and keeps its marks.
 */
export function goToQuery(query: string, push?: { state: Marks | null }, path = window.location.pathname) {
  const to = path + (query ? `?${query}` : '');
  // Only this page's own marks: Next.js adds its own to whatever it is given, and does not follow a write that already carries them.
  // A layer's entry rewritten for another path is that path's now, and closing the layer leaves it; a query written
  // to it is carried down as the layer closes (`leaveLayer`).
  const { panel, layer } = (window.history.state ?? {}) as Marks;
  const kept = { ...(panel ? { panel } : {}), ...(layer && path === window.location.pathname ? { layer } : {}) };
  const take = push !== undefined && layer !== undefined && handed.delete(layer);
  wrote = { path, query };
  try {
    if (push && !take) window.history.pushState(push.state, '', to);
    else window.history.replaceState(take ? push.state : Object.keys(kept).length ? kept : null, '', to);
  } catch {
    // The address is behind; the page is not.
  }
  changed();
}

/** Set or, with `''`, remove values in the address's query; `push` as for `goToQuery`. */
export function setParams(changes: Record<string, string>, push?: { state: Marks }) {
  const query = new URLSearchParams(current());
  for (const [name, value] of Object.entries(changes)) {
    if (value === '') query.delete(name);
    else query.set(name, value);
  }
  goToQuery(query.toString(), push);
}

/**
 * The item a list has open, held in the path after the list's own (`/rules/<id>`), so it can be linked to; `''` for
 * none. Opening another, or closing it, rewrites the address in place, with `changes` to its query. The server draws the
 * list once for every item (next.config.js), so the path is read only once the page has started.
 */
export function useOpened(list: 'rules' | 'labels'): [string, (id: string, changes?: Record<string, string>) => void] {
  const path = usePathname();
  const [, at, id] = (useStarted() ? path : '').split('/');
  return [at === list && id ? decodeURIComponent(id) : '', (next, changes = {}) => openIn(list, next, changes)];
}

/** `/<list>/<id>` (or the list alone), keeping the query but for `changes`, in place of the current entry. */
function openIn(list: string, id: string, changes: Record<string, string>) {
  const query = new URLSearchParams(current());
  for (const [name, value] of Object.entries(changes)) {
    if (value === '') query.delete(name);
    else query.set(name, value);
  }
  goToQuery(query.toString(), undefined, id ? `/${list}/${encodeURIComponent(id)}` : `/${list}`);
}

/** A rule's own address, its panel over the Rules list; `apply` opens what applying it to the inbox would do. */
export const rulePath = (id: string, apply = false) => `/rules/${encodeURIComponent(id)}${apply ? '?apply=1' : ''}`;

/** Opens a rule at its address from anywhere: in place on the Rules list, else by going there, so Back returns. */
export function useOpenRule(): (id: string, apply?: boolean) => void {
  const go = useGo();
  return (id, apply = false) => {
    if (window.location.pathname.split('/')[1] === 'rules') openIn('rules', id, { apply: apply ? '1' : '' });
    else go(rulePath(id, apply));
  };
}

/** One value in the address's query now, for code that runs after a press, outside rendering. */
export const paramNow = (name: string) => new URLSearchParams(current()).get(name) ?? '';

/**
 * While `open`, a history entry of its own for a layer over the page (a dialog, the phone's menu), so Back (Android's,
 * the browser's) closes it, through `close`, instead of leaving the page. Closed any other way its entry is taken off
 * again, unless a press handed it on (`handOver`).
 */
export function useBackCloses(open: boolean, close: () => void) {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!open) return;
    // A layer that opens as another closes, in the same draw (a dialog's next step, or the same one drawn again by
    // React's StrictMode), takes over its entry: going back and adding another would race, and Back could take the new one.
    const id = releasing !== null && layerOn() === releasing ? releasing : `layer-${++layers}`;
    releasing = null;
    if (layerOn() !== id) window.history.pushState({ ...window.history.state, layer: id }, '', window.location.href);
    let popped = false;
    const back = () => {
      if (layerOn() === id) return;
      popped = true;
      latest.current();
    };
    window.addEventListener('popstate', back);
    return () => {
      window.removeEventListener('popstate', back);
      if (popped) return;
      releasing = id;
      queueMicrotask(() => {
        if (releasing !== id) return;
        releasing = null;
        if (layerOn() === id && !handed.delete(id)) leaveLayer();
      });
    };
  }, [open]);
}

/**
 * Takes a layer's entry off by going back to the one under it, which then gets whatever was written to the layer's
 * meanwhile (a press that closed it and opened something in the address): going back alone would undo that.
 */
function leaveLayer() {
  carrying = window.location.search;
  window.history.back();
}

/**
 * A press in a layer that goes somewhere as the layer closes (a section in the menu, Settings): where it goes takes the
 * layer's entry, so Back from there returns to the page under the layer, not to a copy of it.
 */
export function handOver() {
  const layer = layerOn();
  if (layer) handed.add(layer);
}

/**
 * Go to another screen: without loading the page, unless Sift was updated since it was loaded (`isStale`). From a
 * layer's entry it replaces it: the screen goes with the layer.
 */
export function useGo(): (href: string) => void {
  const router = useRouter();
  return (href) => {
    const layer = layerOn();
    if (layer) handed.add(layer);
    if (isStale()) window.location[layer ? 'replace' : 'assign'](href);
    else router[layer ? 'replace' : 'push'](href);
  };
}

/** Whether the entry the page is on was added by opening a panel, so Back closes it. */
export const panelEntry = () => ((window.history.state ?? {}) as Marks).panel === true;

/**
 * One value kept in the address's query (`?q=invoice`), so a narrowed view can be bookmarked and
 * survives a reload. `''` is "not set". Given `options`, the `[value, label]` pairs of the control it
 * feeds, anything else in the address counts as not set. Read as it is written, so a field that writes
 * it keeps up with typing.
 */
export function useParam<T extends string = string>(name: string, options?: readonly (readonly [T, string])[]): [T, (value: T) => void] {
  // The server draws each page once for everyone, with nothing in its query.
  const query = useSyncExternalStore(subscribe, current, () => '');
  const raw = new URLSearchParams(query).get(name) ?? '';
  const value = !options || options.some(([key]) => key === raw) ? (raw as T) : ('' as T);
  return [value, (next) => setParams({ [name]: next })];
}

/** The path and query the page is on, for a sign-in to come back to: `/` on the server, which draws no query. */
export function useHere(): string {
  const path = usePathname();
  const query = useSyncExternalStore(subscribe, current, () => '');
  return path + (query ? `?${query}` : '');
}

/**
 * Where the page starts, once: Next.js moves the address bar only after it has drawn a screen gone to by a link, so the
 * query is read again then, and whatever was opened over the last screen (`?message=`) is gone with it.
 */
export function useQueryFollowsScreens() {
  const path = usePathname();
  useEffect(() => {
    if (wrote?.path !== path) wrote = null;
    changed();
  }, [path]);
}
