import { expect, it, vi } from 'vitest';
import { buildSignIn } from '../src/sift/google-sign-in.ts';
import { loadConfig } from '../src/config.ts';
import { TESTING_SIGN_IN_MS, canSend, signInEnded, signInEnds, userOf } from '../src/store/accounts.ts';
import { credentials } from '../src/store/credentials.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { passStatus, recordPassStatus } from '../src/work/status.ts';
import { installClient } from '../src/gmail/auth.ts';
import { fakeGoogle, freshStore } from './fixtures.ts';
import { SECRETS } from './google.ts';
import { tempDir } from './helpers.ts';

const fake = fakeGoogle();

function configured() {
  const config = loadConfig({ SIFT_HOME: tempDir() });
  installClient(config, JSON.stringify({ web: { client_id: SECRETS.clientId, client_secret: SECRETS.clientSecret } }));
  return config;
}

/** The code Google's consent screen hands back for `address`, with `gmail.send` granted when `send`. */
const consent = (address: string, send = false) => fake.google.consent(address, { send });

it('lets in every account Google does: arriving alone, a person of its own; added, another mailbox of whoever added it', async () => {
  const store = await freshStore();
  const signIn = buildSignIn(configured(), store, { ephemeral: memoryEphemeral(), kick: async () => {} });
  await signIn.complete('', consent('me@example.org'), '', null, null);
  await signIn.complete('', consent('work@example.com'), '', 'me@example.org', null);
  await signIn.complete('', consent('friend@example.net'), '', null, null);
  // An account never changes hands, whoever is signed in when it comes back.
  await signIn.complete('', consent('work@example.com'), '', 'friend@example.net', null);

  expect(await userOf(store.central, 'me@example.org')).toEqual({ id: 1, owner: true });
  expect(await userOf(store.central, 'work@example.com')).toEqual({ id: 1, owner: true });
  expect(await userOf(store.central, 'friend@example.net')).toEqual({ id: 2, owner: false });
});

it('records whether Google let a mailbox send, from the sign-in it holds now, and grants it only for the mailbox asked', async () => {
  const store = await freshStore();
  const signIn = buildSignIn(configured(), store, { ephemeral: memoryEphemeral(), kick: async () => {} });
  await signIn.complete('', consent('me@example.org'), '', null, null);
  const db = await store.user(1);
  const held = async () => await (await credentials(db, 'gmail')).read('me@example.org');
  const first = await held();
  expect(await canSend(db, 'me@example.org')).toBe(false);

  await expect(signIn.complete('', consent('other@example.com', true), '', null, 'me@example.org')).rejects.toThrow('Choose me@example.org');
  expect(await userOf(store.central, 'other@example.com')).toBeNull();

  await signIn.complete('', consent('me@example.org', true), '', null, 'me@example.org');
  expect(await canSend(db, 'me@example.org')).toBe(true);
  const sending = await held();
  expect(sending).not.toBe(first);
  expect(fake.google.honours(sending!)).toBe(true);
  // A sign-in whose grant leaves sending out replaces the one that had it.
  await signIn.complete('', consent('me@example.org'), '', null, null);
  expect(await canSend(db, 'me@example.org')).toBe(false);
});

it('signing in again takes down an expired sign-in at once, passes the mailbox now, and the week Google gives starts over', async () => {
  const store = await freshStore();
  const ephemeral = memoryEphemeral();
  const kicked: number[] = [];
  const signIn = buildSignIn(configured(), store, { ephemeral, kick: async (person) => void kicked.push(person) });
  const given = 50 * TESTING_SIGN_IN_MS;
  vi.spyOn(Date, 'now').mockReturnValue(given);
  await signIn.complete('', consent('me@example.org'), '', null, null);
  const db = await store.user(1);
  await signInEnded(db, 'me@example.org', given + TESTING_SIGN_IN_MS);
  await recordPassStatus(ephemeral, 'me@example.org', { at: given + TESTING_SIGN_IN_MS, error: 'invalid_grant', expired: true });

  const again = given + TESTING_SIGN_IN_MS + 3_600_000;
  vi.spyOn(Date, 'now').mockReturnValue(again);
  await signIn.complete('', consent('me@example.org'), '', null, null);
  expect(await passStatus(ephemeral, ['me@example.org'])).toMatchObject({ expired: [] });
  expect(kicked).toEqual([1, 1]);
  expect(await signInEnds(db)).toEqual(new Map([['me@example.org', again + TESTING_SIGN_IN_MS]]));
});
