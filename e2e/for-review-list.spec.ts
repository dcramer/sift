import {
  addLabelsDialog,
  boxOf,
  choose,
  expect,
  messageQuery,
  openMessage,
  back,
  reader,
  readerHeading,
  param,
  query,
  reviewRows,
  reviewSearch,
  row,
  test,
} from './sift.ts';

test.describe('For review, narrowed', () => {
  test('search matches senders’ names, addresses and subjects', async ({ page }) => {
    await page.goto('/');
    await expect(reviewRows(page)).toHaveCount(9);
    const search = reviewSearch(page);

    await search.fill('Ada');
    await expect(reviewRows(page)).toHaveCount(2);
    await param(page, 'q').toBe('Ada');
    await search.fill('db-');
    await expect(reviewRows(page)).toHaveCount(2);
    await expect(row(page, 'Replica lag on db-3')).toBeVisible();
    await search.fill('promo.example.com');
    await expect(reviewRows(page)).toHaveCount(1);
    await expect(row(page, '48 hours only: 30% off')).toBeVisible();
    await search.fill('nothing like this');
    await expect(page.getByText('Nothing waiting matches.')).toBeVisible();

    await search.fill('');
    await expect(reviewRows(page)).toHaveCount(9);
  });

  test('filters narrow the list, and each one on can be cleared', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Filters' }).click();
    const filters = page.getByRole('complementary', { name: 'Filters' });
    await filters.getByRole('group', { name: 'Label' }).getByRole('radio', { name: 'Unlabelled' }).click();
    await expect(reviewRows(page)).toHaveCount(6);
    await filters.getByRole('group', { name: 'Label' }).getByRole('radio', { name: 'Notifications' }).click();
    await expect(reviewRows(page)).toHaveCount(2);
    await filters.getByRole('group', { name: 'Label' }).getByRole('radio', { name: 'Any' }).click();
    await filters.getByRole('group', { name: 'Then' }).getByRole('radio', { name: 'Archive' }).click();
    await expect(reviewRows(page)).toHaveCount(3);
    await expect(row(page, 'Winter sale starts now')).toBeVisible();

    await page.getByRole('button', { name: 'Filters, 1 on' }).click();
    await expect(filters).toHaveCount(0);
    await page.getByRole('list', { name: 'Filters that are on' }).getByRole('button', { name: 'Clear Then: Archive' }).click();
    await expect(reviewRows(page)).toHaveCount(9);
    await param(page, 'does').toBeNull();
  });

  test('a narrowed list stays narrowed through a reload', async ({ page }) => {
    await page.goto('/?q=Ada');
    await expect(reviewRows(page)).toHaveCount(2);
    await expect(reviewSearch(page)).toHaveValue('Ada');
  });
});

test.describe('Working through For review', () => {
  test('J and K move through the rows, Enter opens one, / goes to the search', async ({ page }) => {
    await page.goto('/');
    await expect(reviewRows(page)).toHaveCount(9);
    await page.keyboard.press('j');
    await expect(row(page, '48 hours only: 30% off')).toBeFocused();
    await page.keyboard.press('j');
    await expect(row(page, 'Lunch on Thursday?')).toBeFocused();
    await page.keyboard.press('k');
    await expect(row(page, '48 hours only: 30% off')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(readerHeading(page, '48 hours only: 30% off')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);

    await page.keyboard.press('/');
    await expect(reviewSearch(page)).toBeFocused();
    await page.keyboard.type('Grace');
    await expect(reviewRows(page)).toHaveCount(1);
  });

  test('the arrows move through the rows, and step the panel left and right', async ({ page }) => {
    await page.goto('/');
    await expect(reviewRows(page)).toHaveCount(9);
    await page.keyboard.press('ArrowDown');
    await expect(row(page, '48 hours only: 30% off')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Lunch on Thursday?')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(row(page, '48 hours only: 30% off')).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(readerHeading(page, '48 hours only: 30% off')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    // Up and down are the message's, to scroll it.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowUp');
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(readerHeading(page, '48 hours only: 30% off')).toBeVisible();

    await page.keyboard.press('?');
    const keys = page.getByRole('dialog', { name: 'Keys' });
    await expect(keys.getByRole('listitem').filter({ hasText: 'Next' })).toHaveText('J→Next');
  });

  test('the panel steps through the list, by its buttons and by J and K', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, '48 hours only: 30% off');
    await expect(open.getByText('1 of 12')).toBeVisible();
    await expect(open.getByRole('button', { name: 'Previous' })).toBeDisabled();

    await open.getByRole('button', { name: 'Next' }).click();
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await expect(open.getByText('2 of 12')).toBeVisible();
    await page.keyboard.press('j');
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();
    await page.keyboard.press('k');
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await open.getByRole('button', { name: 'Previous' }).click();
    await expect(readerHeading(page, '48 hours only: 30% off')).toBeVisible();
    await param(page, 'message').toBe('m4');
  });

  test('Escape after stepping closes the panel and leaves no message in the address', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, '48 hours only: 30% off');
    await open.getByRole('button', { name: 'Next' }).click();
    await open.getByRole('button', { name: 'Next' }).click();
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(open).toHaveCount(0);
    await query(page).toBe('');
    // The keys are the list's again, and no panel comes back.
    await page.keyboard.press('j');
    await expect(reviewRows(page).and(page.locator(':focus'))).toHaveCount(1);
    await expect(reader(page)).toHaveCount(0);
  });

  test('closing the panel leaves the list on the message it was showing', async ({ page }) => {
    await page.goto('/');
    await expect(reviewRows(page)).toHaveCount(9);
    await page.keyboard.press('j');
    await page.keyboard.press('Enter');
    await expect(readerHeading(page, '48 hours only: 30% off')).toBeVisible();
    await page.keyboard.press('j');
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(row(page, 'Lunch on Thursday?')).toBeFocused();
    await page.keyboard.press('j');
    await expect(row(page, 'Notes from the review')).toBeFocused();
    await page.keyboard.press('k');
    await page.keyboard.press('Enter');
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
  });

  test('closing the panel on a folded row’s later message leaves the list on that row', async ({ page }) => {
    await page.goto('/');
    await (await openMessage(page, 'Run failed: CI on main')).getByRole('button', { name: 'Previous' }).click();
    await expect(readerHeading(page, 'Bump zod from 4.0.0 to 4.0.2')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(row(page, 'Bump lodash from 4.17.20 to 4.17.21')).toBeFocused();
  });

  test('a row pressed while the panel is still sliding away opens', async ({ page }) => {
    await page.goto('/');
    const lunch = await boxOf(page.getByRole('cell', { name: 'Lunch on Thursday?' }));
    await page.getByRole('cell', { name: '48 hours only: 30% off' }).click();
    await expect(readerHeading(page, '48 hours only: 30% off')).toBeVisible();
    await page.keyboard.press('Escape');
    // At once, where the row is: a locator's click would wait for the panel to be gone.
    await page.mouse.click(lunch.x + 10, lunch.y + lunch.height / 2);
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    // Closing it goes back to the list, not to the message closed before.
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
  });

  test('the panel steps through a folded row’s messages together, as the list shows them', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Bump lodash from 4.17.20 to 4.17.21');
    await open.getByRole('button', { name: 'Next' }).click();
    await expect(readerHeading(page, 'Bump vite from 6.0.1 to 6.0.3')).toBeVisible();
    await open.getByRole('button', { name: 'Next' }).click();
    await expect(readerHeading(page, 'Bump zod from 4.0.0 to 4.0.2')).toBeVisible();
    await open.getByRole('button', { name: 'Next' }).click();
    await expect(readerHeading(page, 'Run failed: CI on main')).toBeVisible();
  });

  test('closing the panel keeps the search, and nothing else, in the address', async ({ page }) => {
    await page.goto('/?q=Ada');
    await page.getByRole('cell', { name: 'Lunch on Thursday?' }).click();
    await expect(reader(page).getByText('1 of 2')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('?q=Ada');

    await page.goto(`/?q=Ada&${messageQuery('m6')}`);
    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('?q=Ada');
    await expect(reviewRows(page)).toHaveCount(2);
  });

  test('the close button closes the panel, and Back does not bring it back', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Notes from the review');
    await back(page).click();
    await expect(open).toHaveCount(0);
    await query(page).toBe('');

    await page.goBack();
    await expect(reader(page)).toHaveCount(0);
    await param(page, 'message').toBeNull();
  });

  test('Back closes the panel', async ({ page }) => {
    await page.goto('/');
    await openMessage(page, 'Notes from the review');
    await page.goBack();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
    await expect(row(page, 'Notes from the review')).toBeVisible();
  });

  test('Escape in the panel’s dropdown closes only the dropdown', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Notes from the review');
    await open.getByRole('combobox', { name: 'What this message is' }).click();
    await expect(page.getByRole('option', { name: 'Marketing', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();
  });

  test('the panel’s add-label dialog closes back to the panel', async ({ page }) => {
    await page.goto('/');
    await choose(await openMessage(page, 'Notes from the review'), 'Add a label…');
    const dialog = addLabelsDialog(page);
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();
    await param(page, 'message').toBe('m7');
  });
});

test('a sender’s link in a row goes to their page within the app, and opens no message', async ({ page }) => {
  await page.goto('/');
  const link = row(page, 'Replica lag on db-3').getByRole('link').first();
  await expect(link).toBeVisible();
  // A full load would drop what the page set on itself.
  await page.evaluate(() => Object.assign(globalThis, { stillHere: true }));
  await link.click();
  await expect(page).toHaveURL(/\/sender\//);
  expect(await page.evaluate(() => (globalThis as { stillHere?: boolean }).stillHere)).toBe(true);
  await param(page, 'message').toBe(null);
});
