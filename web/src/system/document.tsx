import type { ReactNode } from 'react';
import { Anchor } from './anchor.tsx';
import { Wordmark } from './type.tsx';

/**
 * A page that is read from top to bottom, such as the terms: the name linking home, the title, when it
 * was last changed, then its clauses. Set at the reading size in a column narrow enough to read.
 */
export function Document({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <article className="mx-auto flex w-full max-w-[42rem] flex-col gap-10 px-4 pt-[calc(2rem+var(--safe-top))] pb-[calc(2rem+var(--safe-bottom))] md:px-6 md:pt-[calc(3rem+var(--safe-top))] md:pb-12">
      <Anchor href="/" className="self-start">
        <Wordmark />
      </Anchor>
      <header className="flex flex-col gap-2">
        <h1 className="statement">{title}</h1>
        <p className="text-muted-foreground">Last changed {updated}</p>
      </header>
      <div className="flex flex-col gap-8 text-reading">{children}</div>
    </article>
  );
}

/** One part of a `Document` under its own heading. Paragraphs and lists inside it are spaced and marked here. */
export function Clause({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 [&_li]:pl-1 [&_ul]:flex [&_ul]:list-disc [&_ul]:flex-col [&_ul]:gap-2 [&_ul]:pl-5">
      <h2 className="heading">{title}</h2>
      {children}
    </section>
  );
}
