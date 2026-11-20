import type { Page } from '@playwright/test';
import { closeSettings, expect, param, path, query, settings, settingsFromMenu, test } from './sift.ts';

/** Confirms a removal in the open dialog `title` by typing `address`. */
async function confirmRemoval(page: Page, title: string, address: string, action: string) {
  const confirm = page.getByRole('dialog', { name: title });
  await confirm.getByRole('textbox', { name: `Type ${address} to confirm` }).fill(address);
  await confirm.getByRole('button', { name: action }).click();
}

test.describe('Removing a mailbox', () => {
  test('asks for its address, then it is gone and the last one cannot go', async ({ page }) => {
    await page.goto('/?settings=1');
    await settings(page).getByRole('button', { name: 'Remove me@work.example.org' }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove me@work.example.org' });
    await expect(confirm).toContainText('Your labels and rules stay, for your other mailboxes.');
    await expect(confirm).toContainText('The filters Sift made in Gmail stay there, as do its labels on your mail');
    const remove = confirm.getByRole('button', { name: 'Remove mailbox' });
    await expect(remove).toBeDisabled();
    const typed = confirm.getByRole('textbox', { name: 'Type me@work.example.org to confirm' });
    await typed.fill('me@example.org');
    await expect(remove).toBeDisabled();
    await typed.fill('me@work.example.org');
    await remove.click();

    await expect(confirm).toHaveCount(0);
    await expect(settings(page).getByText('me@work.example.org')).toHaveCount(0);
    const only = settings(page).getByRole('button', { name: 'Remove me@example.org' });
    await expect(only).toBeDisabled();
    await expect(only).toHaveAccessibleDescription('You cannot delete your only remaining mailbox.');
    await param(page, 'settings').toBe('1');

    await page.goto('/rules');
    await expect(page.getByRole('row', { name: /news\.example\.com/ })).toBeVisible();
  });

  test('Cancel, or Escape, closes only the confirm, and the mailbox stays', async ({ page }) => {
    await page.goto('/?settings=1');
    const confirm = page.getByRole('dialog', { name: 'Remove me@work.example.org' });

    await settings(page).getByRole('button', { name: 'Remove me@work.example.org' }).click();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(settings(page)).toBeVisible();

    await settings(page).getByRole('button', { name: 'Remove me@work.example.org' }).click();
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(settings(page).getByRole('button', { name: 'Remove me@work.example.org' })).toBeEnabled();
    await param(page, 'settings').toBe('1');
  });

  test('removing the one signed in as signs out', async ({ page }) => {
    await page.goto('/?settings=1');
    await settings(page).getByRole('button', { name: 'Remove me@example.org' }).click();
    await expect(page.getByRole('dialog', { name: 'Remove me@example.org' })).toContainText('You are signed in as it, so you will be signed out.');
    await confirmRemoval(page, 'Remove me@example.org', 'me@example.org', 'Remove mailbox');
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    expect((await page.request.get('/api/manage', { headers: { 'x-sift': '1' } })).status()).toBe(401);
  });
});

test.describe('Connecting another mailbox', () => {
  test('that Google did not complete says why in Settings, until Settings closes', async ({ page }) => {
    // Where Google's return sends someone still signed in when it did not work out.
    await page.goto(`/?settings=1&signin=${encodeURIComponent('bravo@example.net is already connected to Sift by someone else.')}`);
    await expect(settings(page).getByText('bravo@example.net is already connected to Sift by someone else.')).toBeVisible();
    await closeSettings(page);
    await query(page).toBe('');
  });
});

test.describe('The primary mailbox', () => {
  test('is chosen in Settings, names the account at the top, and passes on when it is removed', async ({ page }) => {
    await page.goto('/?settings=1');
    const primary = settings(page).getByRole('combobox', { name: 'Primary mailbox' });
    await expect(primary).toContainText('me@example.org');
    await primary.click();
    await page.getByRole('option', { name: 'me@work.example.org', exact: true }).click();
    await expect(primary).toContainText('me@work.example.org');
    await closeSettings(page);
    await expect(page.getByRole('button', { name: 'Account, me@work.example.org' })).toBeVisible();

    await page.goto('/?settings=1');
    await expect(primary).toContainText('me@work.example.org');
    await settings(page).getByRole('button', { name: 'Remove me@work.example.org' }).click();
    await confirmRemoval(page, 'Remove me@work.example.org', 'me@work.example.org', 'Remove mailbox');
    // With one mailbox left there is nothing to choose.
    await expect(primary).toHaveCount(0);
    await closeSettings(page);
    await expect(page.getByRole('button', { name: 'Account, me@example.org' })).toBeVisible();
  });
});

test.describe('Settings', () => {
  test('closes to the page it opened over, with nothing left in the address', async ({ page }) => {
    await page.goto('/activity');
    await settingsFromMenu(page);
    await param(page, 'settings').toBe('1');
    await closeSettings(page);
    await path(page).toBe('/activity');
    await query(page).toBe('');
  });
});

test.describe('Deleting the account', () => {
  test('asks for an address, then signs out and the old session is refused', async ({ page }) => {
    await page.goto('/?settings=1');
    await settings(page).getByRole('button', { name: 'Delete account…' }).click();
    await expect(page.getByRole('dialog', { name: 'Delete your account' }).getByRole('button', { name: 'Delete everything' })).toBeDisabled();
    await confirmRemoval(page, 'Delete your account', 'me@example.org', 'Delete everything');

    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    expect((await page.request.get('/api/manage', { headers: { 'x-sift': '1' } })).status()).toBe(401);
  });

  test('once deleted, the page asks the API for nothing more on the old session', async ({ page }) => {
    await page.goto('/?settings=1');
    await settings(page).getByRole('button', { name: 'Delete account…' }).click();
    const asked: string[] = [];
    let deleted = false;
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (deleted && pathname.startsWith('/api/')) asked.push(pathname);
      if (pathname === '/api/account/delete') deleted = true;
    });
    page.on('framenavigated', (frame) => void (frame === page.mainFrame() && (deleted = false)));
    await confirmRemoval(page, 'Delete your account', 'me@example.org', 'Delete everything');
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    expect(asked).toEqual([]);
  });
});
