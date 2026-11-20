import { expect, it, vi } from 'vitest';
import { buildSignIn } from '../src/sift/google-sign-in.ts';
import { loadConfig } from '../src/config.ts';
import { TESTING_SIGN_IN_MS, canSend, signInEnded, signInEnds, userOf } from '../src/store/accounts.ts';
import { credentials } from '../src/store/credentials.ts';
import { memoryEphemeral } from '../src/ephemeral/ephemeral.ts';
import { passStatus, recordPassStatus } from '../src/work/status.ts';
import { freshStore } from './fixtures.ts';
import { tempDir } from './helpers.ts';

// The code stands in for the Google account that came back, and `+send` for Google granting it `gmail.send`.
vi.mock('../src/gmail/auth.ts', () => ({
  hasClientSecrets: () => true,
  loadClientSecrets: () => ({}),
  browserSignInUrl: () => '',
  completeBrowserSignIn: async (_secrets: unknown, { code }: { code: string }) => {
    const [email, granted] = code.split('+');
    return { email, historyId: '1', refreshToken: `token-${code}`, canSend: granted === 'send' };
  },
}));

it('lets in every account Google does: arriving alone, a person of its own; added, another mailbox of whoever added it', async () => {
  const store = await freshStore();
  const signIn = buildSignIn(loadConfig({ SIFT_HOME: tempDir() }), store, { ephemeral: memoryEphemeral(), kick: async () => {} });
  await signIn.complete('', 'me@example.org', '', null, null);
  await signIn.complete('', 'work@example.com', '', 'me@example.org', null);
  await signIn.complete('', 'friend@example.net', '', null, null);
  // An account never changes hands, whoever is signed in when it comes back.
  await signIn.complete('', 'work@example.com', '', 'friend@example.net', null);

  expect(await userOf(store.central, 'me@example.org')).toEqual({ id: 1, owner: true });
  expect(await userOf(store.central, 'work@example.com')).toEqual({ id: 1, owner: true });
  expect(await userOf(store.central, 'friend@example.net')).toEqual({ id: 2, owner: false });
});

it('records whether Google let a mailbox send, from the sign-in it holds now, and grants it only for the mailbox asked', async () => {
  const store = await freshStore();
  const signIn = buildSignIn(loadConfig({ SIFT_HOME: tempDir() }), store, { ephemeral: memoryEphemeral(), kick: async () => {} });
  await signIn.complete('', 'me@example.org', '', null, null);
  const db = await store.user(1);
  expect(await canSend(db, 'me@example.org')).toBe(false);

  await expect(signIn.complete('', 'other@example.com+send', '', null, 'me@example.org')).rejects.toThrow('Choose me@example.org');
  expect(await userOf(store.central, 'other@example.com')).toBeNull();

  await signIn.complete('', 'me@example.org+send', '', null, 'me@example.org');
  expect(await canSend(db, 'me@example.org')).toBe(true);
  expect(await (await credentials(db, 'gmail')).read('me@example.org')).toBe('token-me@example.org+send');
  // A sign-in whose grant leaves sending out replaces the one that had it.
  await signIn.complete('', 'me@example.org', '', null, null);
  expect(await canSend(db, 'me@example.org')).toBe(false);
});

it('signing in again takes down an expired sign-in at once, passes the mailbox now, and the week Google gives starts over', async () => {
  const store = await freshStore();
  const ephemeral = memoryEphemeral();
  const kicked: number[] = [];
  const signIn = buildSignIn(loadConfig({ SIFT_HOME: tempDir() }), store, { ephemeral, kick: async (person) => void kicked.push(person) });
  const given = 50 * TESTING_SIGN_IN_MS;
  vi.spyOn(Date, 'now').mockReturnValue(given);
  await signIn.complete('', 'me@example.org', '', null, null);
  const db = await store.user(1);
  await signInEnded(db, 'me@example.org', given + TESTING_SIGN_IN_MS);
  await recordPassStatus(ephemeral, 'me@example.org', { at: given + TESTING_SIGN_IN_MS, error: 'invalid_grant', expired: true });

  const again = given + TESTING_SIGN_IN_MS + 3_600_000;
  vi.spyOn(Date, 'now').mockReturnValue(again);
  await signIn.complete('', 'me@example.org', '', null, null);
  expect(await passStatus(ephemeral, ['me@example.org'])).toMatchObject({ expired: [] });
  expect(kicked).toEqual([1, 1]);
  expect(await signInEnds(db)).toEqual(new Map([['me@example.org', again + TESTING_SIGN_IN_MS]]));
});
