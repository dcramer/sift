/** Someone mail is from or to. */
export interface Party {
  address: string;
  name?: string;
}

/** What `buildMessage` (src/actions/send.ts) will send to: plain ASCII, a dot-atom and a domain of labels. The server checks again. */
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

/** Split on commas outside quotes and angle brackets, as a To header is. */
function entries(typed: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (const char of typed) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '<') angle = true;
    else if (!quoted && char === '>') angle = false;
    if (char === ',' && !quoted && !angle) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
}

/** One entry: `ada@example.com`, or `Ada Lovelace <ada@example.com>`; null when it is not an address. */
function party(entry: string): Party | null {
  const bracketed = /^(.*)<([^<>]+)>$/.exec(entry);
  const address = (bracketed?.[2] ?? entry).trim();
  if (!ADDRESS.test(address)) return null;
  const name = bracketed?.[1]?.trim().replace(/^"(.*)"$/, '$1');
  return name ? { address, name } : { address };
}

/**
 * Addresses typed as text, separated by commas. `typing`: the reader is still in the field, so the last entry, which they
 * may not have finished, is not wrong yet. `wrong` is each entry that is not an address, as typed.
 */
export function readAddresses(typed: string, typing = false): { parties: Party[]; wrong: string[] } {
  const all = entries(typed);
  const parties: Party[] = [];
  const wrong: string[] = [];
  all.forEach((entry, index) => {
    if (entry === '') return;
    const read = party(entry);
    if (read) parties.push(read);
    else if (!(typing && index === all.length - 1)) wrong.push(entry);
  });
  return { parties, wrong };
}

/** What is wrong with addresses typed, in a sentence, or null. */
export function wrongAddresses(wrong: readonly string[]): string | null {
  if (wrong.length === 0) return null;
  const quoted = wrong.map((entry) => `“${entry}”`);
  return wrong.length === 1 ? `${quoted[0]} is not an address.` : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)} are not addresses.`;
}

/** A party as it is typed back into a field. */
export const typed = ({ address, name }: Party) => (name ? `${name.includes(',') ? `"${name}"` : name} <${address}>` : address);
