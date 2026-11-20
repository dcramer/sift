import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import '@/index.css';
import { display, mono, text, wordmark } from '@/fonts.ts';
import { BEFORE_PAINT } from '@/lib/before-paint.ts';
import { STARTUP_SCREENS, startupImage, startupMedia } from '@/lib/startup.ts';
import { Providers } from '@/providers.tsx';

export const metadata: Metadata = {
  title: { default: 'Sift', template: '%s · Sift' },
  icons: { icon: { url: '/icons/icon.svg', type: 'image/svg+xml' }, apple: '/icons/apple-touch-icon.png' },
  // Installed on an iPhone: the page is drawn under the status bar, in its own colour (`--safe-top`, web/src/index.css).
  appleWebApp: {
    capable: true,
    title: 'Sift',
    statusBarStyle: 'black-translucent',
    startupImage: STARTUP_SCREENS.map((screen) => ({ url: startupImage(screen), media: startupMedia(screen) })),
  },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, viewportFit: 'cover', colorScheme: 'dark', themeColor: '#111110' };

/** Every page, the same for everyone who opens it: what is theirs the page fetches from /api/. */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`dark ${wordmark.variable} ${display.variable} ${text.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script>{BEFORE_PAINT}</script>
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
