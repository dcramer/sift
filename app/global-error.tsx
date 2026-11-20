'use client';
import '@/index.css';
import { display, mono, text, wordmark } from '@/fonts.ts';
import { Failed } from '@/views/failed.tsx';

/** In place of the root layout, when that is what failed: its own document, as Next.js requires. */
export default function GlobalError({ error }: { error: unknown }) {
  return (
    <html lang="en" className={`dark ${wordmark.variable} ${display.variable} ${text.variable} ${mono.variable}`}>
      <body>
        <title>Sift</title>
        <Failed error={error} />
      </body>
    </html>
  );
}
