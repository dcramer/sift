import { createContext, useContext } from 'react';
import { panelEntry, paramNow, setParams } from './params.ts';

/**
 * What the composer writes: a new message, to someone already (`to`, from their page) or to be said; a reply to one, to
 * its sender alone or (`all`) to everyone on it too; or a forward of one, which is new mail with the message quoted under it.
 */
export type Writing = { kind: 'new'; to?: string } | { kind: 'reply'; messageId: string; all: boolean } | { kind: 'forward'; messageId: string };

/**
 * Open the composer. In the address, as a message is: `?compose=new` (with `to` for someone already, from their page) is
 * a panel of its own, which Back closes; `reply`, `all` or `forward` is written in the reader, at the foot of the
 * conversation, in the reader's own history entry, so Back goes to the list. It answers the reader's message
 * (`?message=<id>`), or another of its conversation, named by `answering`.
 */
export function openComposer(what: Writing = { kind: 'new' }) {
  if (what.kind === 'new') {
    setParams({ compose: 'new', ...(what.to ? { to: what.to } : {}) }, { state: { panel: true } });
    return;
  }
  const reading = paramNow('message') || what.messageId;
  setParams({
    compose: what.kind === 'forward' ? 'forward' : what.all ? 'all' : 'reply',
    message: reading,
    answering: reading === what.messageId ? '' : what.messageId,
  });
}

/** Closes the composer written in the reader. */
export const closeReply = () => setParams({ compose: '', answering: '' });

/** Closes the panel a new message is written in. */
export function closeComposer() {
  if (panelEntry()) window.history.back();
  else setParams({ compose: '', to: '' });
}

/** What the address says the composer is writing, or null when it is closed. */
export function writing(compose: string, messageId: string): Writing | null {
  if (compose === 'new') return { kind: 'new' };
  if (!messageId) return null;
  if (compose === 'reply' || compose === 'all') return { kind: 'reply', messageId, all: compose === 'all' };
  if (compose === 'forward') return { kind: 'forward', messageId };
  return null;
}

/** Opens the composer; null while Inbox is off, when nothing offers it. */
export const ComposeContext = createContext<typeof openComposer | null>(null);

/** For a press that writes a message: `compose()` for a new one, `compose({ kind: 'reply' | 'forward', … })` to answer or forward one. */
export const useCompose = () => useContext(ComposeContext);

/** Everything in the composer, kept in this browser, for whoever wrote it, until it is sent or discarded, or they sign out. */
export interface Draft {
  /** The address it is from; empty for the one it starts on. */
  from: string;
  to: string;
  cc: string;
  /** Cc was asked for, or has something in it. */
  showCc: boolean;
  subject: string;
  text: string;
  /** Its Message-ID, made at the first press of Send and kept until it has gone, so trying again cannot send it twice. */
  id: string | null;
}

const DRAFT = 'sift:draft:';

/** `who` is whoever is signed in, so someone else signed in on this browser finds none of theirs. */
const draftKey = (who: string, what: Writing) =>
  `${DRAFT}${who}:${what.kind === 'new' ? `new${what.to ? `/${what.to}` : ''}` : `${what.kind === 'forward' ? 'forward/' : ''}${what.messageId}`}`;

/** The unsent draft `who` kept for this, if any; a new message to someone starts as one to them. */
export function keptDraft(who: string, what: Writing): Draft | null {
  const started = what.kind === 'new' && what.to ? { from: '', to: what.to, cc: '', showCc: false, subject: '', text: '', id: null } : null;
  try {
    const stored = window.localStorage.getItem(draftKey(who, what));
    return stored === null ? started : (JSON.parse(stored) as Draft);
  } catch {
    return started;
  }
}

/** Keep a draft, or with null forget it. */
export function keepDraft(who: string, what: Writing, draft: Draft | null) {
  try {
    if (draft === null) window.localStorage.removeItem(draftKey(who, what));
    else window.localStorage.setItem(draftKey(who, what), JSON.stringify(draft));
  } catch {
    // Not kept; it is still there until the composer is closed.
  }
}

/** Every draft kept in this browser, whoever's. */
export function forgetDrafts() {
  try {
    for (const key of Object.keys(window.localStorage)) if (key.startsWith(DRAFT)) window.localStorage.removeItem(key);
  } catch {
    // Nothing was kept.
  }
}

/** A Message-ID for mail from `from`, made once for a press of Send. */
export function newMessageId(from: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `<${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}@${from.slice(from.lastIndexOf('@') + 1)}>`;
}
