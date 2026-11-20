'use client';
import { RefreshCwIcon } from 'lucide-react';
import { useCallback, useSyncExternalStore } from 'react';
import { type ManageState, type Usage, api, useLoaded } from '@/lib/api.ts';
import { approx, atApiPrices, subscription } from '@/lib/prices.ts';
import { dateTime, duration, money } from '@/lib/format.ts';
import { Ago, Figure, Figures, HoverCard, Spark, Tooltip } from '@/system';

type Accounts = ManageState['accounts'];
/** The way in to the model when it is a subscription, whose plan pays for the calls: the sums are API prices. */
type Plan = ManageState['model']['choices'][number] | null;

/**
 * The time, moved on every `ms`, so what is drawn from it ("1 min ago", the time left) keeps up with nothing loaded.
 * Null until the page runs in the browser, as with `Ago`: the server's clock and time zone are not the reader's.
 */
export function useNow(ms: number): number | null {
  const every = useCallback(
    (tick: () => void) => {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    },
    [ms],
  );
  return useSyncExternalStore(every, () => Math.floor(Date.now() / ms) * ms, onServer);
}
const onServer = () => null;

/**
 * What Sift saved the reader over each window, with its shape over the 30 days, then what the model cost: the hover
 * card, and on a phone the menu. Until Sift has taken anything out of the inbox, only the cost, with its shape.
 */
export function UsageDetail({ usage, plan }: { usage: Usage; plan: Plan }) {
  const now = useNow(60_000);
  const first = now === null ? '' : new Date(now - (usage.daily.length - 1) * 86_400_000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const { saved } = usage;
  const savedAny = saved.month.messages > 0;
  return (
    <div className="flex flex-col gap-5">
      {savedAny ? (
        <div className="flex flex-col gap-2">
          <p className="slug text-muted-foreground">Saved</p>
          <Figures compact>
            <Figure compact label="24H" value={duration(saved.day.seconds)} />
            <Figure compact label="7D" value={duration(saved.week.seconds)} />
            <Figure compact label="30D" value={duration(saved.month.seconds)} />
          </Figures>
          <Spark values={saved.daily} from={first} to="Today" />
        </div>
      ) : null}
      <div className="flex flex-col gap-2">
        {savedAny ? <p className="slug text-muted-foreground">Model</p> : null}
        <Figures compact>
          <Figure compact label="24H" value={money(usage.day)} />
          <Figure compact label="7D" value={money(usage.week)} />
          <Figure compact label="30D" value={money(usage.month)} />
        </Figures>
        {savedAny ? null : <Spark values={usage.daily} from={first} to="Today" />}
      </div>
      {plan ? <p className="text-sm text-muted-foreground">{atApiPrices(plan)}</p> : null}
    </div>
  );
}

/**
 * Sift's line: how long since the mailbox that synced longest ago last did (each one's time when pointed at), then
 * what the model cost over 30 days, which previews the rest and links to Activity. `stacked` for the rail, too narrow
 * for a line.
 */
export function SiftStatus({ accounts, usage, plan, stacked = false }: { accounts: Accounts; usage: Usage | null; plan: Plan; stacked?: boolean }) {
  // `ago` reads the clock itself.
  useNow(30_000);
  const synced = accounts.flatMap((a) => (a.lastSyncedAt === null ? [] : [{ email: a.email, at: a.lastSyncedAt }]));
  return (
    <span className={stacked ? 'flex flex-col items-center gap-3 text-center tabular-nums' : 'flex items-center gap-2 whitespace-nowrap tabular-nums'}>
      {accounts.length === 0 ? (
        'No account connected'
      ) : (
        <Tooltip
          says={synced.map((a) => `${a.email}: ${dateTime(a.at)}`).join('\n')}
          className={stacked ? 'flex flex-col items-center gap-1' : 'flex items-center gap-1.5'}
        >
          <RefreshCwIcon aria-hidden className="size-3.5" />
          <span className="sr-only">Synced</span>
          {synced.length > 0 ? <Ago at={Math.min(...synced.map((a) => a.at))} /> : 'Not synced yet'}
        </Tooltip>
      )}
      {usage ? (
        <>
          {stacked ? null : <span aria-hidden>·</span>}
          <HoverCard href="/activity" card={<UsageDetail usage={usage} plan={plan} />} className={stacked ? 'flex flex-col items-center' : undefined}>
            {/* Through a plan, only about what the API would have charged: the card says so. */}
            <span className={stacked ? 'text-sm text-foreground' : 'text-foreground'}>{approx(usage.month, plan)}</span> <span className="text-label">30D</span>
          </HoverCard>
        </>
      ) : null}
    </span>
  );
}

/** Sift's line on Activity, where what it counts is, on a phone, whose bar has no room for it. Its room is held while it loads. */
export function PhoneSiftStatus() {
  const manage = useLoaded('manage', (signal) => api.manage(signal), 60_000);
  const usage = useLoaded('usage', (signal) => api.usage(signal), 60_000);
  return (
    <p className="mb-4 flex h-5 items-center text-sm text-muted-foreground md:hidden">
      {manage.data ? <SiftStatus accounts={manage.data.accounts} usage={usage.data} plan={subscription(manage.data.model)} /> : null}
    </p>
  );
}
