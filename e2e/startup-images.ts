#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Draws public/startup: the page's opening (its name where the masthead has it, under the status bar) at each iPhone's
 * size, which iOS shows while the installed app starts. Run again after changing what the page first draws:
 *
 *   pnpm build:web && pnpm startup-images
 */
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { STARTUP_SCREENS, startupImage } from '../web/src/lib/startup.ts';
import { serveSeed } from './seeded.ts';

const ROOT = join(import.meta.dirname, '..');
const sift = await serveSeed(ROOT);
const browser = await chromium.launch();
try {
  for (const screen of STARTUP_SCREENS) {
    const page = await browser.newPage({
      viewport: { width: screen.width, height: screen.height },
      deviceScaleFactor: screen.scale,
      isMobile: true,
      hasTouch: true,
    });
    // Never answered, so the page stays on its opening, as it is while the app starts.
    await page.route('**/api/session*', () => {});
    await page.goto(`${sift.url}/sender`);
    await page.addStyleTag({ content: `:root { --safe-top: ${screen.top}px !important; } .loading-bar { visibility: hidden; }` });
    await page.getByRole('link', { name: 'Sift' }).waitFor();
    await page.evaluate('document.fonts.ready');
    await page.screenshot({ path: join(ROOT, 'public', startupImage(screen)) });
    await page.close();
  }
} finally {
  await browser.close();
  await sift.stop();
}
