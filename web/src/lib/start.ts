/**
 * Where the installed app opens: Inbox while it is on, For review otherwise. Its manifest starts it at `/?start=1`; the
 * page goes on from there before anything is drawn, to where the dashboard last found it should (`BEFORE_PAINT`),
 * or, the first time in this browser, once it knows (`Frame`). Kept in this browser until sign-out.
 */
export const START = 'sift:start';

export function keepStart(inbox: boolean): void {
  try {
    window.localStorage.setItem(START, inbox ? '/inbox' : '/');
  } catch {
    // The app opens on For review and goes on once it knows.
  }
}
