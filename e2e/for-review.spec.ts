import {
  PHONE,
  addLabelsDialog,
  boxOf,
  choose,
  expect,
  reader,
  patchJson,
  query,
  reviewRows,
  reviewSearch,
  row,
  toasts,
  settings,
  sideScroll,
  test,
  writeLabel,
} from './sift.ts';
import { addRule, writeRule } from './rule.ts';

test.describe('For review', () => {
  test('adding a label from a row opens only the dialog, and leaves the page as it was', async ({ page }) => {
    await page.goto('/');
    await choose(row(page, 'Notes from the review'), 'Add a label…');
    await expect(addLabelsDialog(page)).toBeVisible();
    await expect(reader(page)).toHaveCount(0);

    await writeLabel(page, 'Field trips');
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');

    // The new label is a choice at once.
    await choose(row(page, 'Notes from the review'), 'Field trips');
    await expect(toasts(page)).toContainText('as Field trips');
    await expect(row(page, 'Notes from the review')).toHaveCount(0);
  });

  test('while Sift is off, says what it would have kept out of the inbox', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/^On, it would have kept \d+ emails out of your inbox in the last 30 days: about \d+ (s|min)\.$/)).toBeVisible();
  });

  test('closing the add-label dialog leaves the page as it was', async ({ page }) => {
    await page.goto('/');
    await choose(row(page, 'Notes from the review'), 'Add a label…');
    const dialog = addLabelsDialog(page);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
  });

  test.describe('On a phone', () => {
    test.use({ viewport: PHONE });

    // The seed's mail came 4 to 21 hours before a run at midday: today's, then yesterday's.
    test('each row says when its mail came, as a mail app does, newest first under its day', async ({ page }) => {
      await page.goto('/');
      const today = page.getByRole('columnheader', { name: 'Today', exact: true });
      const yesterday = page.getByRole('columnheader', { name: 'Yesterday', exact: true });
      await expect(today).toBeVisible();
      await expect(yesterday).toBeVisible();
      expect((await boxOf(today)).y).toBeLessThan((await boxOf(yesterday)).y);

      const newest = row(page, '48 hours only: 30% off');
      expect((await boxOf(today)).y).toBeLessThan((await boxOf(newest)).y);
      expect((await boxOf(newest)).y).toBeLessThan((await boxOf(row(page, 'Winter sale starts now'))).y);
      await expect(newest.locator('time').filter({ visible: true })).toHaveText(/^\d{1,2}:\d{2}\s[AP]M$/);
      await expect(newest.getByText('Unlabelled').filter({ visible: true })).toHaveCount(1);
      await sideScroll(page).toBe(0);
    });
  });
});

test.describe('For review, with Sift on', () => {
  test.use({ variant: 'on' });

  test('a rule made for mail Sift asked about settles it, and it leaves For review', async ({ page }) => {
    await page.goto('/');
    await expect(row(page, 'Quick question')).toBeVisible();
    await page.goto('/rules');
    const dialog = await writeRule(page);
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('lin@example.com');
    await addRule(dialog);

    await page.goto('/');
    await expect(reviewRows(page).first()).toBeVisible();
    await expect(row(page, 'Quick question')).toHaveCount(0);
  });
});

test.describe('For review, with nothing waiting', () => {
  // The seed leaves mail waiting; the server says there is none.
  test.beforeEach(async ({ page }) => {
    await patchJson(page, '**/api/suggestions*', (suggestions) => ({ ...suggestions, items: [], proposals: [] }));
  });

  test('is the rope over the words, with nothing to search, and says Sift is off with the press that turns it on', async ({ page }) => {
    await page.goto('/');
    const words = page.getByText('Nothing is waiting on you.');
    const drawing = words.locator('xpath=..').locator('svg');
    await expect(drawing).toBeVisible();
    const box = await boxOf(drawing);
    expect(box.y + box.height).toBeLessThanOrEqual((await boxOf(words)).y);
    expect(box.width).toBeGreaterThan(200);
    await expect(reviewSearch(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Filters' })).toHaveCount(0);

    // The callout's key explains rows, and there are none: what is left of it is under the words.
    await expect(page.getByText('Sift is off. Nothing it suggests is done in Gmail until you turn it on.')).toBeVisible();
    await expect(page.getByText('Sift is off', { exact: true })).toHaveCount(0);
    await page.getByRole('link', { name: 'Turn Sift on…' }).click();
    await expect(settings(page)).toBeVisible();
  });

  test.describe('On a phone', () => {
    test.use({ viewport: PHONE });

    test('the rope fits the screen', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByText('Nothing is waiting on you.').locator('xpath=..').locator('svg')).toBeVisible();
      await sideScroll(page).toBe(0);
    });
  });
});

test('a search that matches nothing says so in words alone', async ({ page }) => {
  await page.goto('/');
  await reviewSearch(page).fill('nothing sent this');
  await expect(page.getByText('Nothing waiting matches.')).toBeVisible();
  await expect(page.getByText('Nothing waiting matches.').locator('xpath=..').locator('svg')).toHaveCount(0);
});

test.describe('For review, with Sift on', () => {
  // A service worker's page is out of reach of page.route, which holds the list back here.
  test.use({ variant: 'on', serviceWorkers: 'block' });

  test('with nothing waiting, says nothing about turning Sift on', async ({ page }) => {
    await patchJson(page, '**/api/suggestions*', (suggestions) => ({ ...suggestions, items: [], proposals: [] }));
    // Whether Sift is on comes with the page, so it is known before the list arrives.
    await page.goto('/');
    await expect(page.getByText('Nothing is waiting on you.')).toBeVisible();
    await expect(page.getByText('Sift kept 1 out of your inbox this week: about 10 s you didn’t spend on them.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Turn Sift on…' })).toHaveCount(0);
  });

  test('once seen on, holds no room for "Sift is off" while the list loads, so the list does not move when it arrives', async ({ page }) => {
    await page.goto('/');
    await expect(reviewRows(page).first()).toBeVisible();
    const loaded = await boxOf(reviewSearch(page));

    let release = () => {};
    const held = new Promise<void>((done) => (release = done));
    await page.route(
      (url) => url.pathname === '/api/suggestions',
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await page.reload();
    await expect(page.getByLabel('Loading').first()).toBeVisible();
    expect((await boxOf(reviewSearch(page))).y).toBe(loaded.y);
    release();
    await expect(reviewRows(page).first()).toBeVisible();
    expect((await boxOf(reviewSearch(page))).y).toBe(loaded.y);
  });
});
