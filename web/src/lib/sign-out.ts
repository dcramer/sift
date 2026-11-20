import { api } from './api.ts';
import { forgetDrafts } from './compose.ts';
import { chooseMailbox } from './mailbox.ts';
import { START } from './start.ts';

/** Sign out, and leave nothing of theirs in this browser for whoever uses it next: unsent drafts, the mailbox chosen, where the app opens. */
export async function signOut(): Promise<void> {
  await api.signOut();
  forgetDrafts();
  chooseMailbox('');
  try {
    window.localStorage.removeItem(START);
  } catch {
    // Nothing was kept.
  }
  window.location.assign('/');
}
