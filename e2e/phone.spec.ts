import type { Locator, Page } from '@playwright/test';
import { PHONE, boxOf, expect, param, patchJson, reader, sideScroll, test, toast } from './sift.ts';

/** The phone's top bar. */
const bar = (page: Page) => page.getByRole('banner');
/** Inbox's conversations, by when each came: the only rows with a time in them. */
const conversations = (page: Page) => page.getByRole('row').filter({ hasText: /\d:\d\d [AP]M/ });

/** How many of `rows` are wholly on the first screen. */
async function onFirstScreen(rows: Locator) {
  let whole = 0;
  for (const row of await rows.all()) {
    const box = await boxOf(row);
    if (box.y >= 0 && box.y + box.height <= PHONE.height) whole += 1;
  }
  return whole;
}

test.describe('On a phone', () => {
  test.use({ variant: 'inbox', viewport: PHONE });

  test("Inbox's first screen holds seven conversations or more, under a bar that is its search", async ({ page }) => {
    await page.goto('/inbox');
    await expect(conversations(page).first()).toBeVisible();
    expect(await onFirstScreen(conversations(page))).toBeGreaterThanOrEqual(7);
    await sideScroll(page).toBe(0);

    const search = bar(page).getByRole('searchbox', { name: 'Search mail' });
    await expect(bar(page).getByRole('button', { name: 'Menu' })).toBeVisible();
    await search.fill('1042');
    await expect(conversations(page)).toHaveCount(1);
    await expect(conversations(page)).toContainText('Your order has shipped');
    await search.fill('');

    // The views are a menu on the list's name.
    await page.getByRole('button', { name: 'Show' }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Everything' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemradio', { name: 'Sorted' }).click();
    await param(page, 'view').toBe('sorted');
    await expect(page.getByRole('button', { name: 'Show' })).toContainText('InboxSorted');
  });

  test('the bar goes as the page scrolls down and comes back as it scrolls up, and the day stays under it', async ({ page }) => {
    await page.goto('/inbox');
    await expect(conversations(page).first()).toBeVisible();
    const today = page.getByRole('columnheader', { name: 'Today' });

    await page.mouse.wheel(0, 500);
    await expect
      .poll(async () => {
        const box = await boxOf(bar(page));
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(0);
    await expect.poll(async () => (await boxOf(today)).y).toBe(0);

    await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await boxOf(bar(page))).y).toBe(0);
    const height = (await boxOf(bar(page))).height;
    await expect.poll(async () => (await boxOf(today)).y).toBe(height);
  });

  test('a phone on its side keeps the layout of a phone', async ({ page }) => {
    await page.setViewportSize({ width: PHONE.height, height: PHONE.width });
    await page.goto('/inbox');
    await expect(bar(page).getByRole('searchbox', { name: 'Search mail' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Sections' })).toHaveCount(0);
    await sideScroll(page).toBe(0);
  });

  test('a conversation opens with no bar above it, its subject at reading size, its text on the first screen and the account as me', async ({ page }) => {
    // Sent to the account and someone else, so who it went to is said.
    await patchJson(page, '**/api/message?*', (detail) => ({
      ...detail,
      to: [
        { address: 'me@example.org', name: null },
        { address: 'grace@example.net', name: null },
      ],
    }));
    await page.goto('/inbox');
    await conversations(page).filter({ hasText: 'Your March bill' }).click();
    const open = reader(page);
    const subject = open.getByRole('heading', { name: 'Your March bill', level: 1 });
    await expect(subject).toHaveCSS('font-size', '17px');
    await expect(bar(page)).toHaveCount(0);
    // Each head says when, short: no year this year.
    await expect(open.locator('header time').first()).toHaveText(/^([A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d\d [AP]M$/);
    await expect(open.getByText('To me, grace@example.net').first()).toBeVisible();

    // Measured once the conversation is drawn: the text of its first message.
    const text = open.getByRole('article').first().getByText('Your bill is ready.');
    const box = await boxOf(text);
    expect(box.y + box.height).toBeLessThan(PHONE.height / 2);
  });

  test('archiving from the reader says so in one line', async ({ page }) => {
    await page.goto('/inbox');
    await conversations(page).filter({ hasText: 'Your March bill' }).click();
    await reader(page).getByRole('button', { name: 'Archive', exact: true }).click();
    const said = toast(page, 'Your March bill');
    await expect(said).toBeVisible();
    expect((await boxOf(said)).height).toBeLessThan(64);
    await expect(said.getByRole('button', { name: /^Undo/ })).toBeVisible();
  });

  test("Sift's line is in the menu and on Activity, and Sift is off is said in full", async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('Nothing here has been done in Gmail.', { exact: false })).toBeVisible();
    await expect(bar(page).getByRole('link', { name: /30D$/ })).toHaveCount(0);
    await bar(page).getByRole('button', { name: 'Menu' }).click();
    await expect(page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: /30D$/ })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.goto('/activity');
    await expect(page.getByRole('link', { name: /30D$/ }).filter({ visible: true })).toBeVisible();
  });
});
