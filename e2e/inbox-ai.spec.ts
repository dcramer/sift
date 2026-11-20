import { expect, inboxRow, inboxRows, inboxSearch, param, test } from './sift.ts';

test.describe('Inbox, with the model', () => {
  test.use({ variant: 'inbox' });

  test('Ask turns words into filters the reader can see and clear, and says what it cannot narrow by', async ({ page }) => {
    await page.goto('/inbox');
    await expect(inboxRows(page)).toHaveCount(19);
    const search = inboxSearch(page);

    await search.fill('unanswered');
    await page.getByRole('button', { name: 'Ask', exact: true }).click();
    await expect(page.getByText('Sift cannot tell which mail you have answered.')).toBeVisible();
    await search.fill('');
    await expect(inboxRows(page)).toHaveCount(19);

    await search.fill('utility');
    await search.press('Enter');
    await param(page, 'from').toBe('billing@utility.example.net');
    await expect(search).toHaveValue('');
    const chip = page.getByRole('button', { name: 'Clear From: billing@utility.example.net' });
    await expect(chip).toBeVisible();
    await expect(inboxRows(page)).toHaveCount(1);
    await expect(inboxRow(page, 'Your March bill')).toBeVisible();

    await chip.click();
    await param(page, 'from').toBe(null);
    await expect(inboxRows(page)).toHaveCount(19);
  });

  test('Ask turns what mail says into words for the search, beside the sender it found', async ({ page }) => {
    await page.goto('/inbox');
    await expect(inboxRows(page)).toHaveCount(19);
    const search = inboxSearch(page);
    await search.fill('utility about ready');
    await search.press('Enter');
    await param(page, 'from').toBe('billing@utility.example.net');
    await expect(search).toHaveValue('ready');
    await param(page, 'q').toBe('ready');
    await expect(inboxRows(page)).toHaveCount(1);
    await expect(inboxRow(page, 'Your March bill')).toBeVisible();

    await search.fill('ready nowhere');
    await expect(page.getByText('No mail matches.')).toBeVisible();
  });
});
