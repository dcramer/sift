'use client';
import { type ReactNode, useContext } from 'react';
import { Sheet } from './sheet.tsx';
import { Cloud, FinePrint } from './fine-print.tsx';
import { Wordmark } from './type.tsx';

/**
 * The one sheet someone sees in place of the dashboard when sign-in cannot start here. The name sits
 * across its top edge, like a label stuck to it; under it the terms, privacy policy and security page, on a service (`Cloud`).
 */
export function Entry({ children }: { children: ReactNode }) {
  const cloud = useContext(Cloud);
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-[36rem] flex-col justify-center px-5 pt-[calc(3rem+var(--safe-top))] pb-[calc(3rem+var(--safe-bottom))]">
      <div className="relative">
        <h1 className="absolute -top-5 left-6 z-10">
          <Wordmark size="lg" />
        </h1>
        <Sheet className="entry gap-5 px-6 pt-12 pb-6">{children}</Sheet>
      </div>
      {cloud ? (
        <p className="mt-6 flex flex-wrap items-baseline gap-x-4 gap-y-1 px-6 text-sm text-muted-foreground">
          <FinePrint />
        </p>
      ) : null}
    </main>
  );
}
