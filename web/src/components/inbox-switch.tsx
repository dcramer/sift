'use client';
import { useState } from 'react';
import { type ManageState, type MailReach, api, useLoaded } from '@/lib/api.ts';
import { useAction } from '@/lib/action.ts';
import { duration, roughly, size } from '@/lib/format.ts';
import { Button, ChoiceGroup, DeleteButton, Dialog, Failure } from '@/system';

type Window = ManageState['mailWindow'];

const WINDOWS = [
  ['year', 'The last year'],
  ['three_years', 'The last three years'],
  ['all', 'All of it'],
] as const satisfies readonly (readonly [Window, string])[];

export const windowName = (window: Window) => WINDOWS.find(([key]) => key === window)![1];

/** What copying a window takes: about how many messages, what they take to keep, and how long reading them from Gmail takes. */
const reachNote = (reach: MailReach[Window]) =>
  `About ${roughly(reach.messages)} messages · ${size(reach.bytes)} · ${reach.minutes < 1 ? 'a minute' : duration(reach.minutes * 60)} to copy`;

/**
 * How far back Inbox keeps the person's mail, with what each choice takes beside it, read from Gmail's counts. Turning Inbox
 * on asks it; while on, choosing wider copies the rest, and narrower deletes what falls outside.
 */
export function MailWindowDialog({ current, onClose, onDone }: { current: Window | null; onClose: () => void; onDone?: () => void }) {
  const reach = useLoaded('mail-reach', (signal) => api.mailReach(signal), 300_000);
  const [chosen, setChosen] = useState<Window>(current ?? 'year');
  const { busy, error, run } = useAction();
  const narrower = current !== null && WINDOWS.findIndex(([key]) => key === chosen) < WINDOWS.findIndex(([key]) => key === current);
  const notes = reach.data ? Object.fromEntries(WINDOWS.map(([key]) => [key, reachNote(reach.data![key])])) : undefined;
  return (
    <Dialog
      open
      onClose={onClose}
      title={current === null ? 'Keep how much of your mail?' : 'Keep how much?'}
      subtitle="And whatever is in your inbox, however old."
      footer={
        <>
          {narrower ? (
            <DeleteButton
              question={`Delete what Sift copied from before ${windowName(chosen).toLowerCase()}?`}
              what="Mail in your inbox stays, however old."
              action="Delete"
              onDelete={async () => {
                await api.setMail(true, chosen);
                onDone?.();
                onClose();
              }}
            >
              Keep less
            </DeleteButton>
          ) : (
            <Button
              variant="ink"
              busy={busy}
              disabled={chosen === current}
              onClick={() =>
                run(
                  () => api.setMail(true, chosen),
                  () => {
                    onDone?.();
                    onClose();
                  },
                )
              }
            >
              {current === null ? 'Turn on' : 'Keep'}
            </Button>
          )}
          <Button variant="quiet" onClick={onClose}>
            {current === null ? 'Not now' : 'Cancel'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <ChoiceGroup label="How far back" value={chosen} options={WINDOWS} onChange={(value) => value && setChosen(value)} {...(notes ? { notes } : {})} />
        <p className="text-muted-foreground">Sift copies it from Gmail newest first, as fast as Gmail allows. Turning Inbox off deletes the copy.</p>
        <Failure>{error ?? reach.error}</Failure>
      </div>
    </Dialog>
  );
}

/** Turning Inbox on, from Settings or from the Inbox screen while it is off: it asks first how far back to keep the mail. */
export function TurnInboxOn({ label }: { label: string }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <Button onClick={() => setAsking(true)}>{label}</Button>
      {asking ? <MailWindowDialog current={null} onClose={() => setAsking(false)} /> : null}
    </>
  );
}
