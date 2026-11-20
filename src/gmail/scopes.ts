/**
 * What every Google sign-in asks for. `gmail.modify` covers reading, labels and history; `gmail.settings.basic` covers
 * filters. `https://mail.google.com/` (permanent delete) is never asked for.
 */
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.settings.basic'] as const;

/** Asked for only when the person lets Sift send from a mailbox, on top of what it holds; only `src/actions/send.ts` uses it. */
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
