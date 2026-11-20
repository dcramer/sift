'use client';
import { type InboxEstimate, type ManageState, api, useLoaded } from '@/lib/api.ts';
import { useAction } from '@/lib/action.ts';
import { count, money, plural } from '@/lib/format.ts';
import { Ago, Blank, Button, Dialog, Failure, Figure, Figures, SettingRow, Share } from '@/system';
import { costOfMessages, priceNote, subscription } from '@/lib/prices.ts';
import { useNow } from '@/components/status.tsx';

type Reach = 'inbox' | 'recent';

/** What going through the newest of the inbox would take. Read from Gmail, so it is not asked for again for a while. */
export function useInboxEstimate(reach: Reach) {
  return useLoaded(`inbox-${reach}`, (signal) => api.inboxEstimate(reach, signal), 300_000);
}

/** How many messages, how many need the model, and about what that costs on the model in use. */
export function InboxFigures({ estimate, model }: { estimate: InboxEstimate | null; model: ManageState['model'] }) {
  if (!estimate)
    return (
      <Figures>
        <Figure label="In your inbox" value="–" />
        <Figure label="Need the model" value="–" />
      </Figures>
    );
  return (
    <Figures>
      <Figure label="In your inbox" value={count(estimate.messages)} />
      <Figure label="Need the model" value={count(estimate.model)} />
      {estimate.cost === null ? null : <Figure label="About" value={money(estimate.cost)} tone="look" note={priceNote(model.chosen, subscription(model))} />}
    </Figures>
  );
}

/** Asked when Sift is turned on, and from Settings: go through what is already in the inbox, as if it had just arrived. */
export function GoThroughInbox({ model, onClose, onStarted }: { model: ManageState['model']; onClose: () => void; onStarted: () => void }) {
  const estimate = useInboxEstimate('inbox');
  const { busy, error, run } = useAction();
  const messages = estimate.data?.messages ?? null;
  return (
    <Dialog
      open
      onClose={onClose}
      title="Go through your inbox?"
      footer={
        <>
          <Button
            variant="ink"
            busy={busy}
            disabled={!messages}
            onClick={() =>
              run(
                () => api.startInbox('inbox'),
                () => {
                  onStarted();
                  onClose();
                },
              )
            }
          >
            {messages === null ? 'Go through' : `Go through ${count(messages)}`}
          </Button>
          <Button variant="quiet" onClick={onClose}>
            Not now
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <InboxFigures estimate={estimate.data} model={model} />
        <Failure>{error ?? estimate.error}</Failure>
      </div>
    </Dialog>
  );
}

/** Roughly how long the rest will take, from how fast it has gone so far. */
export function timeLeft(going: { done: number; total: number; startedAt: number }, now: number): string | null {
  const elapsed = now - going.startedAt;
  if (going.done === 0 || elapsed <= 0) return null;
  const minutes = Math.round(((going.total - going.done) * (elapsed / going.done)) / 60_000);
  if (minutes < 1) return 'less than a minute left';
  if (minutes < 90) return `about ${plural(minutes, 'minute')} left`;
  return `about ${plural(Math.round(minutes / 60), 'hour')} left`;
}

/** The inbox in Settings: what going through it would cost, where it has got, or when it last did. */
export function InboxRow({ state, reload, onGoThrough }: { state: ManageState; reload: () => void; onGoThrough: () => void }) {
  const { going, last } = state.inbox;
  const { busy, error, run } = useAction();
  const estimate = useInboxEstimate('inbox');
  const now = useNow(10_000);
  if (going)
    return (
      <SettingRow
        title="Going through your inbox"
        note={
          <div className="flex flex-col gap-2 pt-1">
            <Share part={going.done} whole={going.listed ? going.total : 0} />
            <span className="tabular-nums">
              {going.listed
                ? [`${count(going.done)} of ${count(going.total)}`, `${money(going.spent)} so far`, now === null ? null : timeLeft(going, now)]
                    .filter(Boolean)
                    .join(' · ')
                : `Reading your inbox · ${count(going.total)} found`}
            </span>
            <Failure>{error}</Failure>
          </div>
        }
      >
        <Button busy={busy} onClick={() => run(() => api.stopInbox(), reload)}>
          Stop
        </Button>
      </SettingRow>
    );
  const said = estimate.data;
  const costs = !said || said.cost === null ? null : costOfMessages(said.cost, subscription(state.model));
  return (
    <SettingRow
      title="Your inbox"
      note={
        last ? (
          <>
            {last.stopped ? 'Stopped after' : 'Went through'} {plural(last.total, 'message')} <Ago at={last.finishedAt} /> · {money(last.spent)}
          </>
        ) : said ? (
          [`${plural(said.messages, 'message')}.`, costs].filter(Boolean).join(' ')
        ) : (
          <Blank />
        )
      }
    >
      <Button onClick={onGoThrough}>{last ? 'Go through again…' : 'Go through…'}</Button>
    </SettingRow>
  );
}
