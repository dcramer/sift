import type { Page } from '@playwright/test';
import { STARTUP_SCREENS, startupImage } from '../web/src/lib/startup.ts';
import { back, boxOf, composer, messageQuery, expect, PHONE, patchJson, path, query, senderPage, settings, test } from './sift.ts';

// The installed app: what the phone's own edges, its Back and its network do to the page.

const SENDER = senderPage('notifications@code.example.com');
const menu = (page: Page) => page.getByRole('dialog', { name: 'Menu' });

test("the page is drawn to the screen's edges, under a status bar in its own colour, with a picture of its opening for each iPhone", async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent');
  const pictures = page.locator('link[rel="apple-touch-startup-image"]');
  await expect(pictures).toHaveCount(STARTUP_SCREENS.length);
  for (const screen of STARTUP_SCREENS) {
    const reply = await page.request.get(startupImage(screen));
    expect(reply.headers()['content-type'], startupImage(screen)).toBe('image/png');
  }
  // Pulling down from the top does not reload the page on Android.
  expect(await page.evaluate<string>('getComputedStyle(document.documentElement).overscrollBehaviorY')).toBe('none');

  const manifest = (await (await page.request.get('/manifest.webmanifest')).json()) as { start_url: string; shortcuts: { name: string; url: string }[] };
  expect(manifest.start_url).toBe('/?start=1');
  expect(manifest.shortcuts.map((s) => s.name)).toEqual(['For review', 'Inbox', 'New message', 'Activity']);
});

test.describe('On a phone with a notch', () => {
  test.use({ viewport: PHONE });

  /** The status bar and the home indicator, as an iPhone's installed app has them. */
  const notched = (page: Page) => page.addStyleTag({ content: ':root { --safe-top: 47px !important; --safe-bottom: 34px !important; }' });

  test('the top bar, the menu, a panel, a dialog and the reader start below the status bar', async ({ page }) => {
    await page.goto('/rules');
    await notched(page);
    const below = async (what: Parameters<typeof boxOf>[0]) => expect((await boxOf(what)).y).toBeGreaterThanOrEqual(47);
    await below(page.getByRole('button', { name: 'Menu' }));

    await page.getByRole('button', { name: 'Menu' }).click();
    await below(menu(page).getByRole('button', { name: 'Close menu' }));
    await menu(page).getByRole('button', { name: 'Settings' }).click();
    await below(settings(page).getByRole('heading', { name: 'Settings' }));
    await below(settings(page).getByRole('button', { name: 'Close' }));
    await settings(page).getByRole('button', { name: 'Close' }).click();
    await expect(settings(page)).toHaveCount(0);

    await page.getByRole('button', { name: 'Add a rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add a rule' });
    await below(dialog.getByRole('button', { name: 'Close' }));

    await page.goto(`/?${messageQuery('m6')}`);
    await notched(page);
    await expect(back(page)).toBeVisible();
    await page.evaluate('scrollTo(0, 0)');
    await below(back(page));
  });
});

test.describe("The phone's Back", () => {
  test.use({ viewport: PHONE });

  test("closes the menu, and a section pressed in it takes the menu's place in history", async ({ page }) => {
    await page.goto('/');
    await page.goto('/activity');
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(menu(page)).toBeVisible();
    await page.goBack();
    await expect(menu(page)).toHaveCount(0);
    await path(page).toBe('/activity');

    await page.getByRole('button', { name: 'Menu' }).click();
    await menu(page).getByRole('link', { name: 'Rules' }).click();
    await expect(page.getByRole('heading', { name: 'Rules', level: 1 })).toBeVisible();
    await page.goBack();
    await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
    await expect(menu(page)).toHaveCount(0);
    await page.goBack();
    await path(page).toBe('/');
  });

  test('closes a dialog, and closing one leaves nothing behind for Back', async ({ page }) => {
    await page.goto('/');
    await page.goto('/rules');
    const dialog = page.getByRole('dialog', { name: 'Add a rule' });
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await expect(dialog).toBeVisible();
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await path(page).toBe('/rules');

    // Its next step is another dialog in the same place: one entry for both.
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toBeVisible();
    await page.goBack();
    await expect(dialog).toHaveCount(0);
    await path(page).toBe('/rules');

    await page.getByRole('button', { name: 'Add a rule' }).click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await page.goBack();
    await path(page).toBe('/');
  });
});

test.describe('When drawing the page fails', () => {
  test.use({ serviceWorkers: 'block', allow: ["reading 'expired'"] });

  test('it says so, and Reload loads it again', async ({ page }) => {
    await patchJson(page, '**/api/manage*', (manage) => ({ ...manage, activity: null }));
    await page.goto(SENDER);
    await expect(page.getByRole('heading', { name: 'Something went wrong.' })).toBeVisible();
    await page.unrouteAll();
    await page.getByRole('button', { name: 'Reload' }).click();
    await expect(page.getByRole('heading', { name: 'notifications@code.example.com' })).toBeVisible();
  });
});

test.describe('After Sift is updated under an open page', () => {
  test.use({ serviceWorkers: 'block' });

  test('the next screen gone to is loaded whole, from the new build', async ({ page }) => {
    await patchJson(page, '**/api/session*', (session) => ({ ...session, build: 'a-newer-build' }));
    await page.goto(SENDER);
    await expect(page.getByRole('heading', { name: 'notifications@code.example.com' })).toBeVisible();
    await page.evaluate('window.stayed = true');
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Rules' }).click();
    await expect(page.getByRole('heading', { name: 'Rules', level: 1 })).toBeVisible();
    expect(await page.evaluate<boolean>("'stayed' in window")).toBe(false);
  });

  test('not while it is the same build: going between screens loads nothing', async ({ page }) => {
    await page.goto(SENDER);
    await expect(page.getByRole('heading', { name: 'notifications@code.example.com' })).toBeVisible();
    await page.evaluate('window.stayed = true');
    await page.getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Rules' }).click();
    await expect(page.getByRole('heading', { name: 'Rules', level: 1 })).toBeVisible();
    expect(await page.evaluate<boolean>("'stayed' in window")).toBe(true);
  });
});

test.describe('Started without a network', () => {
  // What the page asked for while there was none: from the network, or through the worker, for a file it had not kept yet.
  test.use({ allow: ['ERR_INTERNET_DISCONNECTED', 'net::ERR_FAILED'] });

  /** The worker in charge, with the page it stands in with kept. */
  async function installed(page: Page) {
    await page.goto('/sender');
    await expect.poll(() => page.evaluate<boolean>('navigator.serviceWorker.controller !== null')).toBe(true);
  }

  test('says it is offline, keeps no mail, and opens the page asked for once the network is back', async ({ page, context }) => {
    await installed(page);
    await context.setOffline(true);
    await page.goto('/rules');
    await expect(page.getByRole('heading', { name: "You're offline." })).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByRole('heading', { name: 'Rules', level: 1 })).toBeVisible();
    await path(page).toBe('/rules');
  });

  test('a page that does not come stands in with the one kept, and loads once Sift answers', async ({ page, context }) => {
    test.slow();
    await installed(page);
    let held = true;
    await context.route('**/labels', async (route) => {
      // Never answered, the first time: a network that connects and says nothing.
      if (held) {
        held = false;
        return;
      }
      await route.continue();
    });
    await page.goto('/labels');
    await expect(page.getByRole('heading', { name: 'Labels', level: 1 })).toBeVisible({ timeout: 20_000 });
    expect(held).toBe(false);
  });
});

test.describe('The installed app', () => {
  test.describe('with Inbox on', () => {
    test.use({ variant: 'inbox' });

    test('opens on Inbox, the first time and after', async ({ page }) => {
      await page.goto('/?start=1');
      await path(page).toBe('/inbox');
      await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
      await page.goto('/?start=1');
      await path(page).toBe('/inbox');
    });

    test("keeps each person's drafts apart, and forgets them on sign-out", async ({ page }) => {
      await page.goto('/');
      await page.evaluate(() =>
        localStorage.setItem(
          'sift:draft:someone@example.net:new',
          JSON.stringify({ from: '', to: '', cc: '', showCc: false, subject: '', text: 'Not mine', id: null }),
        ),
      );
      await page.getByRole('button', { name: /Compose/ }).click();
      const writing = composer(page, 'New message');
      await expect(writing.getByRole('textbox', { name: 'Message' })).toHaveValue('');
      await writing.getByRole('textbox', { name: 'Message' }).fill('Mine');
      await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('sift:draft:')).length)).toBe(2);
      await writing.getByRole('button', { name: 'Close' }).click();
      await expect(writing).toHaveCount(0);

      await page.getByRole('button', { name: /^Account, / }).click();
      await page.getByRole('menuitem', { name: 'Sign out' }).click();
      await expect(page.getByRole('button', { name: /^Account, / })).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => /^sift:(draft:|mailbox|start)/.test(key)))).toEqual([]);
    });
  });

  test('opens on For review while Inbox is off', async ({ page }) => {
    await page.goto('/?start=1');
    await expect(page.getByRole('heading', { name: 'For review', level: 1 })).toBeVisible();
    await query(page).toBe('');
    await page.goto('/?start=1');
    await path(page).toBe('/');
    await query(page).toBe('');
  });
});

test.describe('A reload', () => {
  test.use({ viewport: PHONE, serviceWorkers: 'block' });

  test('comes back to where the list was', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('row').nth(8)).toBeVisible();
    await page.evaluate('scrollTo(0, 600)');
    await page.reload();
    // The list is fetched after the page loads: the browser's own restoring finds the page too short.
    await expect.poll(() => page.evaluate<number>('Math.round(scrollY)')).toBe(600);
    await expect(page.getByRole('row').nth(8)).toBeVisible();
  });
});
