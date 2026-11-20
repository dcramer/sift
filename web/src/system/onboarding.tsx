'use client';
import { CheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Wordmark } from './type.tsx';

/**
 * The page in place of the dashboard while someone sets Sift up: connecting a model, saying what they want,
 * choosing their labels. One column, centred, with the name and who is signed in along its top; the steps
 * in order above the step's title, those done ticked and this one underlined in the highlighter (on a
 * phone, "Step 2 of 4" and its name). The page scrolls when a step is long. `steps` is left out when there
 * is only the one thing to do, such as a model that was signed out.
 */
export function Onboarding({
  steps,
  current = 0,
  title,
  intro,
  account,
  children,
}: {
  steps?: readonly string[];
  current?: number;
  title: string;
  intro?: ReactNode;
  account: { name: string; onSettings: () => void; onSignOut: () => void } | undefined;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-[46rem] flex-col px-4 pb-20 md:px-0">
      <header className="flex items-center justify-between gap-4 pt-[calc(1.25rem+var(--safe-top))]">
        <Wordmark size="lg" />
        {account ? (
          <p className="flex flex-wrap items-baseline justify-end gap-x-4 gap-y-1 text-sm text-muted-foreground">
            <span className="min-w-0 truncate max-sm:hidden">{account.name}</span>
            <Press onPress={account.onSettings}>Settings</Press>
            <Press onPress={account.onSignOut}>Sign out</Press>
          </p>
        ) : null}
      </header>
      <main className="flex flex-col gap-8 pt-14 md:pt-20">
        {steps ? <Steps steps={steps} current={current} /> : null}
        <div className="flex flex-col gap-3">
          <h1 className="statement">{title}</h1>
          {intro ? <p className="max-w-[62ch] text-reading text-muted-foreground">{intro}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}

function Steps({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <>
      <ol className="flex flex-wrap gap-x-6 gap-y-2 text-sm max-sm:hidden">
        {steps.map((label, i) => (
          <li
            key={label}
            aria-current={i === current ? 'step' : undefined}
            className={cn(
              'relative flex items-center gap-1.5 py-1 font-semibold after:absolute after:inset-x-0 after:-bottom-0.5 after:h-[3px]',
              i === current ? 'text-foreground after:bg-highlight' : 'text-muted-foreground',
            )}
          >
            <span className="flex w-4 justify-center tabular-nums">{i < current ? <CheckIcon aria-label="Done" className="size-4" /> : i + 1}</span>
            {label}
          </li>
        ))}
      </ol>
      <p className="text-sm font-semibold text-muted-foreground sm:hidden">
        Step {current + 1} of {steps.length}: {steps[current]}
      </p>
    </>
  );
}

function Press({ onPress, children }: { onPress: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onPress} className="cursor-pointer underline decoration-foreground/35 underline-offset-[0.2em] hover:decoration-foreground">
      {children}
    </button>
  );
}
