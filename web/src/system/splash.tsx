import type { ReactNode } from 'react';
import { FinePrint } from './fine-print.tsx';
import { Wordmark } from './type.tsx';

/**
 * The first page of someone not signed in: the name, one line set as large as anything gets, then a
 * sentence and the one action. No sheet: it is the whole page. The terms, privacy, security and source at its foot.
 * On a phone all but the name sits at the bottom, so the action is under the thumb. `art` is a doodle over the line (docs/brand.md).
 */
export function Splash({ title, art, children }: { title: ReactNode; art?: ReactNode; children: ReactNode }) {
  return (
    <div className="entry mx-auto flex min-h-svh w-full max-w-[64rem] flex-col px-5 md:px-10">
      <header className="pt-[calc(2rem+var(--safe-top))] md:pt-[calc(2.5rem+var(--safe-top))]">
        <Wordmark size="lg" />
      </header>
      <main className="flex flex-1 flex-col justify-end gap-6 pt-16 pb-10 md:justify-center md:gap-12 md:py-16">
        {art ? <div className="w-full max-w-[34rem]">{art}</div> : null}
        <h1 className="display">{title}</h1>
        {children}
      </main>
      <footer className="flex gap-4 pb-[calc(2rem+var(--safe-bottom))] text-sm text-muted-foreground">
        <FinePrint source />
      </footer>
    </div>
  );
}
