import { type Search, indexTerms, searchTerms, wordsOf } from '../search.ts';
import { searchHash } from '../secrets.ts';
import { type AnyColumn, type SQL, and, sql } from './query.ts';
import type { Sql } from './sql.ts';

/**
 * A message's search index is a Bloom filter: each term (`indexTerms`) sets the bits its keyed hash names, so the database
 * can tell a message that may have a word from one that has not, and learns no word. Its size is the power of two that
 * gives each term about `BITS_PER_TERM` bits, so one in a few hundred to one in tens of thousands of messages a term
 * would not find passes for it, and the text is read to drop those (docs/security.md, docs/inbox.md).
 */
const HASHES = 7;
const BITS_PER_TERM = 12;
const MIN_BITS = 1024;
/** 4 KB: past about 2,700 terms (a long newsletter) more of them pass by chance, and their text is read to drop them. */
const MAX_BITS = 32_768;

/** What a message is found by: its text, its sender's name and address, and its subject. */
export interface Searched {
  text: string;
  fromName: string | null;
  fromAddress: string;
  subject: string;
}

export const searchedWords = (m: Searched): Set<string> => new Set(wordsOf([m.fromName ?? '', m.fromAddress, m.subject, m.text].join('\n')));

/** The bits a term sets, before they are folded into a filter's size: the low bits of each, so one hash serves every size. */
function hashesOf(db: Sql, term: string): number[] {
  if (db.person === null) throw new Error('Only a person’s handle indexes their mail.');
  const hash = searchHash(db.keys, db.person, term);
  return Array.from({ length: HASHES }, (_, i) => hash.readUInt32BE(i * 4));
}

/** The index of one message, as `mail_bodies.search` holds it. Bit n is bit n % 8 of byte n / 8, as Postgres's `get_bit` reads it. */
export function searchIndex(db: Sql, message: Searched): Uint8Array {
  const terms = indexTerms(searchedWords(message));
  let bits = MIN_BITS;
  while (bits < terms.size * BITS_PER_TERM && bits < MAX_BITS) bits *= 2;
  const index = new Uint8Array(bits / 8);
  for (const term of terms)
    for (const hash of hashesOf(db, term)) {
      const bit = hash & (bits - 1);
      index[bit >> 3]! |= 1 << (bit & 7);
    }
  return index;
}

/** True of every message whose index `column` says may match `search`, and of some that do not; false of a null one. */
export function mayMatch(db: Sql, column: AnyColumn, search: Search): SQL {
  return and(
    ...searchTerms(search).flatMap((term) =>
      hashesOf(db, term).map((hash) => sql`get_bit(${column}, (${hash}::bigint & (octet_length(${column}) * 8 - 1))::integer) = 1`),
    ),
  )!;
}
