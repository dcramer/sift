import type { ContentFacts } from '../triage/facts.ts';
import { parseAddress } from '../triage/features.ts';
import { htmlFacts } from '../triage/html.ts';

/** The shape of a Gmail message payload that body extraction needs. */
interface BodyPart {
  mimeType?: string | null;
  filename?: string | null;
  headers?: { name?: string | null; value?: string | null }[] | null;
  body?: { data?: string | null } | null;
  parts?: BodyPart[] | null;
}

/** Long enough to judge what a message is; short enough to keep a classification cheap. */
export const MAX_BODY_CHARS = 4000;
/**
 * What Inbox keeps of a message's text, which it shows whole: far past any letter a person writes, while bounding what one
 * row holds and what a pass's batch of 50 holds in memory. HTML is kept as it comes, as for waiting mail.
 */
const MAX_MAIL_CHARS = 200_000;

const decode = (data: string) => Buffer.from(data, 'base64url').toString('utf8');

function find(part: BodyPart, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = find(child, mimeType);
    if (found !== null) return found;
  }
  return null;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

/** The readable text of a message: the plain part if there is one, otherwise the HTML with markup removed. Truncated. */
export function extractText(payload: BodyPart | null | undefined): string {
  return shortened(readable(payload));
}

/** All of a message's readable text: its plain part, or else its HTML's text. */
function readable(payload: BodyPart | null | undefined): string {
  if (!payload) return '';
  const plain = find(payload, 'text/plain');
  const html = plain === null ? find(payload, 'text/html') : null;
  const text = plain ?? (html === null ? '' : htmlToText(html));
  return text
    .replace(/\r/g, '')
    .replace(/[ \t ​-‍﻿]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cut = (text: string, most: number) => (text.length > most ? `${text.slice(0, most)}\n[truncated]` : text);
const shortened = (text: string) => cut(text, MAX_BODY_CHARS);

const header = (part: BodyPart, name: string) => part.headers?.find((h) => h.name?.toLowerCase() === name)?.value ?? '';

function hasAttachment(part: BodyPart): boolean {
  if (part.filename && !/^\s*inline/i.test(header(part, 'content-disposition'))) return true;
  return (part.parts ?? []).some(hasAttachment);
}

/** What sift takes from a whole message: its readable text, its HTML part, and facts about the rest. */
export interface MessageContent {
  text: string;
  /** More of the text than `text` holds, up to `MAX_MAIL_CHARS`, for Inbox; absent when `text` is all of it. */
  whole?: string;
  /** The HTML part as the message carries it, uncleaned. Null when it has none. */
  html: string | null;
  facts: ContentFacts;
}

export function readContent(payload: BodyPart | null | undefined): MessageContent {
  const html = payload ? find(payload, 'text/html') : null;
  const sender = payload ? parseAddress(header(payload, 'from')) : null;
  const whole = readable(payload);
  return {
    text: shortened(whole),
    ...(whole.length > MAX_BODY_CHARS ? { whole: cut(whole, MAX_MAIL_CHARS) } : {}),
    html,
    facts: {
      hasAttachments: payload ? hasAttachment(payload) : false,
      words: whole === '' ? 0 : whole.split(/\s+/).length,
      ...(html !== null && sender ? htmlFacts(html, sender.domain) : {}),
    },
  };
}

/** A message's content from all of its text that Inbox holds, as `readContent` gives it. */
export function heldContent(whole: string, html: string | null, facts: ContentFacts): MessageContent {
  return { text: shortened(whole), ...(whole.length > MAX_BODY_CHARS ? { whole } : {}), html, facts };
}
