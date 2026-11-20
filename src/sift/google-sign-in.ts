import type { Config } from '../config.ts';
import type { SignIn } from '../dashboard/controls.ts';
import type { Ephemeral } from '../ephemeral/ephemeral.ts';
import { browserSignInUrl, completeBrowserSignIn, hasClientSecrets, loadClientSecrets } from '../gmail/auth.ts';
import { connectAccount, setCanSend, signedIn, userOf } from '../store/accounts.ts';
import { Refusal } from '../refusal.ts';
import { credentials } from '../store/credentials.ts';
import type { Store } from '../store/store.ts';
import { reportError } from '../telemetry.ts';
import { forgetPassStatus } from '../work/status.ts';

/** Google sign-in from the dashboard: the same step connects the Gmail account and signs the viewer in. */
export function buildSignIn(config: Config, store: Store, live: { ephemeral: Ephemeral; kick: (person: number) => Promise<void> }): SignIn {
  return {
    hasClient: () => hasClientSecrets(config),
    url: (redirectUri, state, challenge, send) => browserSignInUrl(loadClientSecrets(config), { redirectUri, state, challenge, send }),
    complete: async (redirectUri, code, verifier, addTo, send) => {
      const { email, historyId, refreshToken, canSend } = await completeBrowserSignIn(loadClientSecrets(config), { redirectUri, code, verifier });
      // Chosen in Google's account picker, which the hint only suggests.
      if (send !== null && email !== send) throw new Refusal(`Google signed in ${email}, not ${send}. Choose ${send} there.`);
      const known = await userOf(store.central, email);
      const person = addTo === null ? null : await userOf(store.central, addTo);
      // A new account starts from now; a known one keeps its place.
      const owner = known ? known.id : await connectAccount(store, email, historyId, Date.now(), person?.id);
      const db = await store.user(owner);
      // Its token goes in its person's own database, which is the only place it is read from.
      await (await credentials(db, 'gmail')).write(email, refreshToken);
      await setCanSend(db, email, canSend);
      await signedIn(db, email, Date.now());
      // An expired sign-in's status would hold the notice up, and the look back, until the next pass: a mailbox with none is passed now.
      await forgetPassStatus(live.ephemeral, email);
      await live.kick(owner).catch(reportError);
      return email;
    },
  };
}
