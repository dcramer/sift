'use client';
import { type Confidential, type MailThread, api } from '@/lib/api.ts';
import { useAction } from '@/lib/action.ts';
import { outcomeName, sureness } from '@/lib/format.ts';
import { threadKey } from '@/lib/params.ts';
import { reveal } from '@/lib/reveal.ts';
import { Meter, useToast } from '@/system';

/** A conversation as a press on it needs it. */
export type Pressed = Pick<MailThread, 'accountId' | 'threadId' | 'messageIds' | 'subject'>;
type Press = 'archive' | 'read' | 'unread';

// Changes go to Gmail one after another, in the order pressed: opening a conversation marks it read, and Mark unread
// pressed straight after must not land first and be undone by it.
let pressing: Promise<unknown> = Promise.resolve();

/**
 * The reader's own presses on conversations in their inbox, Sift on or off. Archive takes them off the list at once and
 * offers Undo; read and unread are on every message of each, but unread only on its newest, as Gmail marks it.
 */
export function useMailPress(): { press: (threads: readonly Pressed[], what: Press, then?: () => void) => void; error: string | null } {
  const { hide, run, error } = useAction();
  const undo = useAction();
  const toast = useToast();
  const send = (threads: readonly Pressed[], what: Press) => {
    const sent = pressing.then(async () => {
      const replies = await Promise.all(
        [...Map.groupBy(threads, (t) => t.accountId)].map(([accountId, mine]) =>
          api.changeMail({ accountId, messageIds: mine.flatMap((t) => (what === 'unread' ? t.messageIds.slice(-1) : t.messageIds)), change: what }),
        ),
      );
      return { actions: replies.flatMap((reply) => reply.actions), missed: replies.some((reply) => reply.missed > 0) };
    });
    pressing = sent.catch(() => undefined);
    return sent;
  };
  /** What Gmail did not take, said as a failure once what it did take can be undone. Counted in messages, so said without a number. */
  const unless = (missed: boolean, threads: readonly Pressed[]) => {
    if (missed) throw new Error(`Gmail did not take ${threads.length === 1 ? 'it' : 'all of them'}. Try again.`);
  };
  return {
    error,
    press: (threads, what, then) => {
      if (threads.length === 0) return;
      if (what !== 'archive') {
        run(async () => {
          const { missed } = await send(threads, what);
          unless(missed, threads);
        }, then);
        return;
      }
      hide(threads.map(threadKey), threads.length === 1 ? 'Could not archive it' : 'Could not archive them', async () => {
        const { actions, missed } = await send(threads, what);
        if (actions.length > 0)
          toast(threads.length === 1 ? reveal(threads[0].subject) || '(no subject)' : `${threads.length} conversations`, {
            kind: 'Archived',
            undo: () => undo.hide([], 'Could not undo it', () => Promise.all(actions.map((id) => api.undo(id)))),
          });
        unless(missed, threads);
      });
      then?.();
    },
  };
}

/** Who wrote in a conversation, as a mail app lists them: one name whole, several by first name. */
export function whoWrote(who: readonly Confidential[]): string {
  const names = who.map((w) => reveal(w));
  if (names.length === 1) return names[0];
  return names.map((name) => (name.includes('@') ? name.split('@')[0] : name.split(/\s+/)[0])).join(', ');
}

/** What Sift thinks a message is: how sure, then the label; mail it could not place says so; mail it never decided, nothing. */
export function Thinks({ thinks }: { thinks: MailThread['thinks'] }) {
  if (!thinks) return null;
  return (
    <span className="inline-flex items-baseline gap-2">
      <Meter level={thinks.labelId === null ? null : sureness(thinks)} />
      {thinks.labelId === null ? outcomeName('review') : (thinks.labelName ?? outcomeName(thinks.disposition))}
    </span>
  );
}
