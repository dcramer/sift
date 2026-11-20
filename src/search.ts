/**
 * What Inbox's search reads in mail, and how it matches: whole words, the last also as the start of one, case and accents
 * aside. The index is built from the same words (`src/store/search.ts`), so it finds what this would match and more,
 * never less.
 */

/** Longer runs are kept to their start: a word that long is a link's or a code's, and matched by its start. */
const MAX_WORD = 40;
/**
 * Starts shorter than this are not indexed: one would let through most of the mail. Such a last word is checked in the
 * text of what the words before it let through, and typed alone is matched whole.
 */
const MIN_PREFIX = 3;
/** The index holds the starts of each word up to this long; a longer start typed is looked up by its first letters, and the text checked. */
const MAX_PREFIX = 6;

/** The words of `text`: runs of letters and digits, lowercased, with accents taken off ("Café" is "cafe"). */
export function wordsOf(text: string): string[] {
  return (
    text
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).map((word) => word.slice(0, MAX_WORD));
}

/** What the index holds for these words: each whole, and each start of each from `MIN_PREFIX` letters to `MAX_PREFIX`. */
export function indexTerms(words: Iterable<string>): Set<string> {
  const terms = new Set<string>();
  for (const word of words) {
    terms.add(`=${word}`);
    for (let length = MIN_PREFIX; length <= Math.min(word.length, MAX_PREFIX); length++) terms.add(`^${word.slice(0, length)}`);
  }
  return terms;
}

/** A search as typed: words every match has whole, and the last, which may be the start of one. */
export interface Search {
  whole: string[];
  /** Null when the last word is a short one typed alone, so it is among `whole`. */
  start: string | null;
}

/** Null when nothing typed is a word. */
export function searchOf(typed: string): Search | null {
  const words = wordsOf(typed);
  const last = words.at(-1);
  if (last === undefined) return null;
  return last.length >= MIN_PREFIX || words.length > 1 ? { whole: words.slice(0, -1), start: last } : { whole: words, start: null };
}

/** The terms a message's index must hold for it to match `search`. */
export const searchTerms = (search: Search): string[] => [
  ...new Set([
    ...search.whole.map((w) => `=${w}`),
    ...(search.start !== null && search.start.length >= MIN_PREFIX ? [`^${search.start.slice(0, MAX_PREFIX)}`] : []),
  ]),
];

/** Whether a message with these words matches. */
export function matches(words: ReadonlySet<string>, search: Search): boolean {
  if (!search.whole.every((w) => words.has(w))) return false;
  const { start } = search;
  if (start === null || words.has(start)) return true;
  for (const word of words) if (word.startsWith(start)) return true;
  return false;
}
