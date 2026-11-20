import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Env } from './config.ts';

/**
 * Credentials at rest, in a file or a database row. Each is either plain text or one line:
 *
 *   sift-secret:v1:<key id>:<nonce>:<ciphertext and tag>
 *
 * AES-256-GCM, with a name as associated data (a file's name, or the person and slot a row is for) so
 * one credential cannot be put in another's place. See docs/secrets.md.
 */
const PREFIX = 'sift-secret:v1:';

interface Key {
  /** A short hash of the key, recorded with everything it encrypts. Says which key, reveals nothing of it. */
  id: string;
  key: Buffer;
}

export interface Keyring {
  /** What new values are encrypted with. Null: sift stores them plain. */
  current: Key | null;
  /** Still accepted for reading, so a key can be replaced. */
  old: Key[];
}

const derived = new Map<string, Key>();

/** The salt is fixed so the same secret always gives the same key; the operator's secret is the only input. */
function derive(secret: string): Key {
  let key = derived.get(secret);
  if (!key) {
    const bytes = scryptSync(secret, 'sift-secret:v1', 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    key = { key: bytes.subarray(0, 32), id: createHash('sha256').update(bytes.subarray(32)).digest('hex').slice(0, 8) };
    derived.set(secret, key);
  }
  return key;
}

/** `SIFT_KEY` is the current key; `SIFT_OLD_KEYS` lists, comma-separated, the ones it replaced. */
export function loadKeyring(env: Env = process.env): Keyring {
  const current = env['SIFT_KEY']?.trim();
  const old = (env['SIFT_OLD_KEYS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '' && s !== current);
  return { current: current ? derive(current) : null, old: old.map(derive) };
}

/** The id of the key a stored value was encrypted with, or null if it is plain. */
function keyIdOf(stored: string): string | null {
  return stored.startsWith(PREFIX) ? (stored.slice(PREFIX.length).split(':')[0] ?? '') : null;
}

const lost = (names: string[]) =>
  new Error(
    `${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} encrypted with a key that is not in SIFT_KEY or SIFT_OLD_KEYS. ` +
      `Set the key ${names.length === 1 ? 'it was' : 'they were'} written with. If that key is lost, ` +
      'sign in to Google and the model provider again to replace what it held.',
  );

function encrypt(key: Key, name: string, text: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key.key, nonce);
  cipher.setAAD(Buffer.from(name));
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}${key.id}:${nonce.toString('base64url')}:${body.toString('base64url')}\n`;
}

/** Null when the key is not on the ring, or it is and the value does not open with it (wrong key, damaged or moved file). */
function decrypt(keys: Keyring, name: string, stored: string): string | null {
  const [id, nonce, body] = stored.trim().slice(PREFIX.length).split(':');
  const key = [keys.current, ...keys.old].find((k) => k?.id === id);
  if (!key || !nonce || !body) return null;
  const bytes = Buffer.from(body, 'base64url');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key.key, Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(bytes.subarray(-16));
    return decipher.update(bytes.subarray(0, -16), undefined, 'utf8') + decipher.final('utf8');
  } catch {
    return null;
  }
}

/** A secret as stored: encrypted for `name` when there is a key, plain otherwise. */
export function sealSecret(name: string, text: string, keys: Keyring): string {
  return keys.current ? encrypt(keys.current, name, text) : text;
}

/**
 * A stored secret, decrypted. Throws, naming `name`, if its key is not on the ring or it was stored for
 * another name. Plain text is accepted only while there is no key: once there is, every value was sealed
 * at start, so a plain one is a credential someone else put in this person's place.
 */
export function openSecret(name: string, stored: string, keys: Keyring): string {
  if (keyIdOf(stored) === null && keys.current)
    throw new Error(`${name} is stored unencrypted though SIFT_KEY is set, so it is not used. Sign in again to replace it.`);
  return openToRekey(name, stored, keys);
}

/** As `openSecret`, but plain text is returned as it is: only for sealing what was stored before there was a key. */
export function openToRekey(name: string, stored: string, keys: Keyring): string {
  if (keyIdOf(stored) === null) return stored;
  const text = decrypt(keys, name, stored);
  if (text === null) throw lost([name]);
  return text;
}

const hashKeys = new Map<string, Buffer>();

/**
 * A keyed hash of `value` for one person, for finding equal values without storing them: HMAC-SHA256
 * under a key derived from the current key for that person (HKDF), so the same address hashes
 * differently for each person and a list of guessed addresses cannot be matched against it. Without a
 * key, where everything is stored plain, it is the value itself.
 */
export function keyedHash(keys: Keyring, person: number, value: string): string {
  if (!keys.current) return value;
  const cached = `${keys.current.id} ${person}`;
  let key = hashKeys.get(cached);
  if (!key) {
    key = Buffer.from(hkdfSync('sha256', keys.current.key, 'sift-hash:v1', `person ${person}`, 32));
    hashKeys.set(cached, key);
  }
  return createHmac('sha256', key).update(value).digest('base64url');
}

const searchKeys = new Map<string, Buffer>();
/** Stands in for the key where there is none, as everything is then stored plain: the index says no more than the text beside it. */
const NO_KEY = Buffer.alloc(32);

/**
 * A keyed hash of a word in one person's mail, for the bits it sets in that message's search index: HMAC-SHA256 under a
 * key derived for this alone (HKDF, `sift-search:v1`) from the current key and the person, so it shares nothing with
 * `keyedHash` and a new key moves every bit. 32 bytes.
 */
export function searchHash(keys: Keyring, person: number, term: string): Buffer {
  const cached = `${keys.current?.id ?? ''} ${person}`;
  let key = searchKeys.get(cached);
  if (!key) {
    key = keys.current ? Buffer.from(hkdfSync('sha256', keys.current.key, 'sift-search:v1', `person ${person}`, 32)) : NO_KEY;
    searchKeys.set(cached, key);
  }
  return createHmac('sha256', key).update(term).digest();
}

/** How every value under the current key starts, for finding the ones that are not in a query. Null without a key. */
export const currentPrefix = (keys: Keyring): string | null => (keys.current ? `${PREFIX}${keys.current.id}:` : null);

/** Whether a stored secret is not yet under the current key: plain, or encrypted with an old one. */
export const staleSecret = (stored: string, keys: Keyring): boolean => keys.current !== null && keyIdOf(stored) !== keys.current.id;

/** A stored secret, decrypted if it was encrypted. Null if there is no such file. Throws if its key is not on the ring. */
export function readSecret(path: string, keys: Keyring): string | null {
  if (!existsSync(path)) return null;
  const stored = readFileSync(path, 'utf8');
  if (keyIdOf(stored) === null) return stored;
  const text = decrypt(keys, basename(path), stored);
  if (text === null) throw lost([path]);
  return text;
}

/** Store a secret owner-only, encrypted when there is a key. The file is replaced whole, never left half-written. */
export function writeSecret(path: string, text: string, keys: Keyring): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, sealSecret(basename(path), text, keys), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/**
 * Bring every stored secret under the current key: encrypt the plain ones and re-encrypt those under an
 * old key, so that key can be retired. Without a current key nothing is changed. Throws, naming every
 * file, if any cannot be opened with the keys given; nothing is rewritten in that case. `write: false`
 * only checks.
 */
export function rekeySecrets(paths: string[], keys: Keyring, write = true): { encrypted: string[]; rotated: string[] } {
  const unreadable: string[] = [];
  const pending: { path: string; text: string; from: string | null }[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const stored = readFileSync(path, 'utf8');
    const from = keyIdOf(stored);
    const text = from === null ? stored : decrypt(keys, basename(path), stored);
    if (text === null) unreadable.push(path);
    else if (keys.current && from !== keys.current.id) pending.push({ path, text, from });
  }
  if (unreadable.length > 0) throw lost(unreadable);
  if (write) for (const { path, text } of pending) writeSecret(path, text, keys);
  return {
    encrypted: pending.filter((p) => p.from === null).map((p) => p.path),
    rotated: pending.filter((p) => p.from !== null).map((p) => p.path),
  };
}
