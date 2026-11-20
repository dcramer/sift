'use client';
import { type ReactNode, createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Kbd } from './type.tsx';
import { useTouch } from './touch.ts';

/**
 * Keyboard shortcuts. A control asks for its key with `useShortcut`, which binds the key and hands back
 * the hint to draw beside the control, so a key that works is always shown and a key that is shown
 * always works. Keys do nothing while the reader is typing, and only the topmost layer's keys are live:
 * with a panel or a dialog open, the page under it is deaf. The reader can turn all of it off, which is
 * remembered in this browser.
 */

interface Binding {
  keys: readonly string[];
  label: string;
  layer: number;
  run: () => void;
  /** With several bindings for one key, the one whose element holds the focus wins. */
  within?: () => Element | null;
}

const bindings = new Map<string, Binding>();
const layers: number[] = [];
let nextLayer = 1;
const top = () => layers.at(-1) ?? 0;
/** The layer of a key that works whatever is open. */
const EVERYWHERE = -1;

const STORE = 'sift:keys';
const listeners = new Set<() => void>();
function stored(): boolean {
  try {
    return window.localStorage.getItem(STORE) !== 'off';
  } catch {
    return true;
  }
}
let on = typeof window === 'undefined' ? true : stored();

/** Turn shortcuts and their hints on or off, for this browser. */
export function setShortcutsOn(next: boolean): void {
  on = next;
  try {
    window.localStorage.setItem(STORE, next ? 'on' : 'off');
  } catch {
    // Not remembered; still applies until the page is closed.
  }
  for (const listener of listeners) listener();
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
// The server draws them on: the choice is kept in the browser.
export const useShortcutsOn = () =>
  useSyncExternalStore(
    subscribe,
    () => on,
    () => true,
  );

/** Whether key hints are drawn: shortcuts are on, and this is not a touch screen. For a hint on a key the browser handles itself, such as Escape. */
export const useHintsShown = () => {
  const touch = useTouch();
  return useShortcutsOn() && !touch;
};

const NAMES: Record<string, string> = { Enter: '↵', Escape: 'esc', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'space' };
const SHIFT = 'Shift+';
/**
 * A key held with ⌘ on a Mac and Ctrl elsewhere: `Mod+Enter` sends what is being written. It works while typing, since it
 * types nothing; a key without it never does.
 */
const MOD = 'Mod+';
const onMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);
/** A key as it is drawn: letters in capitals, the named keys by their sign, a shifted letter (`Shift+i`) after ⇧, `Mod+` as ⌘ or Ctrl. */
export const keyName = (key: string): string =>
  key.startsWith(MOD)
    ? `${onMac() ? '⌘' : 'Ctrl '}${keyName(key.slice(MOD.length))}`
    : key.startsWith(SHIFT)
      ? `⇧${keyName(key.slice(SHIFT.length))}`
      : (NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key));
/** A key as `aria-keyshortcuts` names it: `Mod+` is either. */
export const ariaKeys = (key: string) => (key.startsWith(MOD) ? `Meta+${key.slice(MOD.length)} Control+${key.slice(MOD.length)}` : key);
/** A press as bindings name it. Shift makes a letter a key of its own (Gmail's Shift+I); on anything else it only picks the sign (`?`). */
const keyOf = (event: KeyboardEvent) =>
  event.metaKey || event.ctrlKey
    ? MOD + event.key
    : /^[a-z]$/i.test(event.key)
      ? `${event.shiftKey ? SHIFT : ''}${event.key.toLowerCase()}`
      : event.key.length === 1
        ? event.key.toLowerCase()
        : event.key;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.closest('[role="listbox"], [role="menu"]') !== null);

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (!on || event.defaultPrevented || event.altKey || (!mod && isTyping(event.target))) return;
    // Enter on something focused already presses it; a shortcut on Enter must not press a second thing.
    if (!mod && event.key === 'Enter' && event.target instanceof Element && event.target.closest('button, a, [tabindex="0"]')) return;
    const key = keyOf(event);
    const live = [...bindings.values()].filter((b) => (b.layer === top() || b.layer === EVERYWHERE) && b.keys.includes(key));
    const match = live.find((b) => b.within?.()?.contains(document.activeElement)) ?? live[0];
    if (!match) return;
    event.preventDefault();
    match.run();
  });
}

const Layer = createContext({ layer: 0, moves: false });
/** Whether the row a control sits in is the one the reader is on. Outside a table, always. */
export const RowActive = createContext(true);

/**
 * What floats over the page (a panel, a dialog) wraps its content in a layer: while it is open only its
 * own keys are live. `moves` says the layer steps through a list itself (J and K, ← and →), so a table inside it leaves them alone.
 */
export function KeyLayer({ moves = false, children }: { moves?: boolean; children: ReactNode }) {
  const [layer] = useState(() => nextLayer++);
  useEffect(() => {
    layers.push(layer);
    return () => void layers.splice(layers.indexOf(layer), 1);
  }, [layer]);
  return <Layer value={{ layer, moves }}>{children}</Layer>;
}

/** Whether the layer this is in steps through a list itself, so a table in it leaves its keys alone. */
export const useLayerMoves = () => useContext(Layer).moves;

/** Whether this is on the page itself rather than in something floating over it. */
export const useOnPage = () => useContext(Layer).layer === 0;

/**
 * Bind `key` to `run` for as long as the caller is on the page, and get back the hint to draw beside
 * the control (nothing when shortcuts are off or the screen is a touch screen). `label` says what the
 * key does in the list of all keys. Several keys for one thing (J and ↓) are one binding and one line
 * in that list. No `key`, or `enabled` false, binds and draws nothing. `everywhere` is for the one key
 * that must work whatever is open.
 */
export function useShortcut(
  key: string | readonly string[] | undefined,
  label: string,
  run: () => void,
  options: { enabled?: boolean; within?: () => Element | null; tone?: 'ink'; everywhere?: boolean } = {},
): ReactNode {
  const id = useId();
  const here = useContext(Layer).layer;
  const layer = options.everywhere ? EVERYWHERE : here;
  const keys = key === undefined ? [] : typeof key === 'string' ? [key] : key;
  // A list made afresh each render is the same keys; the effect below watches them by name.
  const named = keys.join('\n');
  const active = useContext(RowActive) && options.enabled !== false && keys.length > 0;
  const hints = useHintsShown();
  const latest = useRef({ run, within: options.within });
  useLayoutEffect(() => {
    latest.current = { run, within: options.within };
  });
  useEffect(() => {
    if (!active) return;
    bindings.set(id, { keys: named.split('\n'), label, layer, run: () => latest.current.run(), within: () => latest.current.within?.() ?? null });
    return () => void bindings.delete(id);
  }, [active, id, named, label, layer]);
  if (!active || !hints) return null;
  return keys.map((one) => (
    <Kbd key={one} className="hidden md:inline-flex" {...(options.tone ? { tone: options.tone } : {})}>
      {keyName(one)}
    </Kbd>
  ));
}

/** Every key that is live right now, for the list the reader opens with `?`. One line per meaning and its keys. */
export function liveShortcuts(): { keys: string[]; label: string }[] {
  const seen = new Set<string>();
  return [...bindings.values()]
    .filter((b) => b.layer === top() || b.layer === EVERYWHERE)
    .filter((b) => !seen.has(`${b.keys.join(' ')}\n${b.label}`) && seen.add(`${b.keys.join(' ')}\n${b.label}`))
    .map((b) => ({ keys: b.keys.map(keyName), label: b.label }));
}
