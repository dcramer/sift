import type { Page } from '@playwright/test';
import { addRule, makeRule, ruleDialog, rulePanel, writeRule } from './rule.ts';
import {
  addLabelsDialog,
  boxOf,
  choose,
  expect,
  forReviewLink,
  messageQuery,
  openMessage,
  back,
  reader,
  readerHeading,
  toasts,
  param,
  path,
  PHONE,
  query,
  reviewRows,
  row,
  senderPage,
  sideScroll,
  test,
  writeLabel,
} from './sift.ts';

const DEALS = `/?${messageQuery('m4')}`;

/**
 * Every request beyond `origin` the browser did not refuse under the content security policy. A refused one is
 * reported as a request and then as failed, and never leaves the browser.
 */
function remote(page: Page, origin: string) {
  const sent = new Set<string>();
  page.on('request', (request) => void (new URL(request.url()).origin !== origin && sent.add(request.url())));
  page.on('requestfailed', (request) => void (request.failure()?.errorText === 'csp' && sent.delete(request.url())));
  return sent;
}

const mailFrame = (page: Page, subject: string) => page.frameLocator(`iframe[title="${subject}"]`);

test.describe('A message as its HTML', () => {
  test('shows by default, and loads nothing from elsewhere', async ({ page, sift }) => {
    const sent = remote(page, sift.url);
    await page.goto(DEALS);
    const open = reader(page);
    await expect(open.getByRole('radio', { name: 'HTML' })).toBeChecked();
    await expect(open.getByText('Remote images are blocked')).toBeVisible();
    const frame = mailFrame(page, '48 hours only: 30% off');
    await expect(frame.getByRole('heading', { name: '30% off everything' })).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Shop the sale' })).toBeVisible();
    await expect(frame.getByText('Preferences')).toBeVisible();
    await expect(frame.getByRole('link', { name: 'Preferences' })).toHaveCount(0);
    // Everything the frame asks for is asked for by the time the network goes quiet; one the policy refused is
    // reported as failed a moment later, so the list is asked again until it has gone.
    await page.waitForLoadState('networkidle');
    await expect.poll(() => [...sent]).toEqual([]);
  });

  test('a link in it opens in a new tab, and the panel stays', async ({ page, context }) => {
    await context.route('https://shop.example.com/**', (route) => route.fulfill({ body: 'elsewhere', contentType: 'text/plain' }));
    await page.goto(DEALS);
    const opened = context.waitForEvent('page');
    await mailFrame(page, '48 hours only: 30% off').getByRole('link', { name: 'Shop the sale' }).click();
    const tab = await opened;
    await expect.poll(() => tab.url()).toBe('https://shop.example.com/sale');
    await tab.close();
    await expect(readerHeading(page, '48 hours only: 30% off')).toBeVisible();
    await param(page, 'message').toBe('m4');
  });

  test('Text, once chosen, is kept in the browser', async ({ page }) => {
    await page.goto(DEALS);
    const open = reader(page);
    await open.getByRole('radio', { name: 'Text' }).click();
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(open.getByText('Remote images are blocked')).toHaveCount(0);
    await expect(open.getByText('Everything must go.')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('sift:message-view'))).toBe('text');

    await page.reload();
    await expect(reader(page).getByRole('radio', { name: 'Text' })).toBeChecked();
    await expect(page.locator('iframe')).toHaveCount(0);

    await reader(page).getByRole('radio', { name: 'HTML' }).click();
    await expect(mailFrame(page, '48 hours only: 30% off').getByRole('heading', { name: '30% off everything' })).toBeVisible();
  });

  test('mail held as text alone, or not held, has nothing to choose', async ({ page }) => {
    await page.goto(`/?${messageQuery('m6')}`);
    await expect(reader(page).getByText('Are you free for lunch on Thursday?')).toBeVisible();
    await expect(reader(page).getByRole('radiogroup', { name: 'Read it as' })).toHaveCount(0);

    await page.goto(`/activity?show=all&${messageQuery('m1')}`);
    await expect(reader(page).getByText('Sift does not hold this message’s text.')).toBeVisible();
    await expect(reader(page).getByRole('radiogroup', { name: 'Read it as' })).toHaveCount(0);
  });

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto(DEALS);
    const frame = mailFrame(page, '48 hours only: 30% off');
    await expect(frame.getByRole('heading', { name: '30% off everything' })).toBeVisible();
    const paper = await boxOf(page.locator('iframe'));
    expect(paper.width).toBeLessThanOrEqual(390);
    // The card is written to shrink to its frame (max-width: 100%), and does: its right edge is not cut off.
    const card = await boxOf(frame.locator('table table'));
    expect(card.x + card.width).toBeLessThanOrEqual(paper.x + paper.width);
    await sideScroll(page).toBe(0);
  });
});

test.describe('Who a message went to', () => {
  test('a long list folds, so the message fits under it on a phone, opens where it stands, and folds again', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    const open = await openMessage(page, 'Notes from the review');
    await expect(open.getByText(/cc reviewer1@example\.net, reviewer2@example\.net, reviewer3@example\.net and 9 more$/)).toBeVisible();
    await expect(open.getByText(/reviewer12@example\.net/)).toHaveCount(0);
    await expect(open.getByText('Attached are my notes.')).toBeInViewport();

    await open.getByRole('button', { name: '9 more' }).click();
    const fewer = open.getByRole('button', { name: 'Fewer' });
    await expect(fewer).toHaveAttribute('aria-expanded', 'true');
    await expect(open.getByText(/reviewer12@example\.net Fewer$/)).toBeVisible();

    // The page scrolls as one, so however long the list is, what is under it can be read.
    const last = open.getByText(/^History · /);
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await expect(readerHeading(page, 'Notes from the review')).not.toBeInViewport();
    await sideScroll(page).toBe(0);
    await fewer.scrollIntoViewIfNeeded();

    await fewer.click();
    await expect(open.getByRole('button', { name: '9 more' })).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('What Sift saw', () => {
  const seen = (page: Page) =>
    reader(page)
      .getByRole('table')
      .filter({ has: page.getByRole('button', { name: /^Make a rule for mail that/ }) })
      .getByRole('rowgroup')
      .last()
      .getByRole('row');

  test('lists what each message showed, and nothing it did not', async ({ page }) => {
    await page.goto(DEALS);
    await expect(seen(page)).toHaveCount(6);
    for (const words of [
      'Came through a mailing list promo.example.com',
      'Has a one-click unsubscribe Sift can use it',
      'Was sent through a bulk mail service Mailchimp',
      'Has replies going elsewhere',
      'Is in Promotions',
      'Has a tracking pixel And its links are tracked',
    ])
      await expect(seen(page).filter({ has: page.getByRole('cell', { name: words }) })).toHaveCount(1);

    await page.goto(`/?${messageQuery('m7')}`);
    await expect(seen(page)).toHaveCount(1);
    await expect(seen(page)).toContainText('Has attachments');

    await page.goto(`/?${messageQuery('m6')}`);
    await expect(seen(page)).toHaveCount(1);
    await expect(seen(page)).toContainText('Is a reply');
  });

  test('a rule from a fact opens over the panel, and closing it leaves the panel open', async ({ page }) => {
    await page.goto(DEALS);
    await reader(page).getByRole('button', { name: 'Make a rule for mail that has a one-click unsubscribe' }).click();
    const dialog = ruleDialog(page);
    await expect(dialog.getByRole('textbox')).toHaveValue('Mail from deals@promo.example.com that has a one-click unsubscribe: ');
    await expect(page).toHaveURL(DEALS);

    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toHaveValue('deals@promo.example.com');
    await expect(dialog.getByRole('combobox', { name: 'Condition 2' })).toHaveText(/has a one-click unsubscribe/);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(readerHeading(page, '48 hours only: 30% off')).toBeVisible();
    await expect(page).toHaveURL(DEALS);

    await makeRule(reader(page));
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
    await param(page, 'message').toBe('m4');
  });

  test('a rule added from the panel opens at its own address, and Back returns to the message', async ({ page }) => {
    await page.goto('/');
    const dialog = await makeRule(await openMessage(page, 'Winter sale starts now'));
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await addRule(dialog);
    const sheet = rulePanel(page, 'sale@store.example.com');
    await expect(sheet).toContainText('Marketing');
    await path(page).toMatch(/^\/rules\/r-/);

    await page.goBack();
    await expect(readerHeading(page, 'Winter sale starts now')).toBeVisible();
    await path(page).toBe('/');
    await param(page, 'message').toBe('m8');

    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
    await expect(page.getByRole('cell', { name: 'Winter sale starts now' })).toHaveCount(0);
  });

  test('a label added from the panel leaves the panel open on the message', async ({ page }) => {
    await page.goto(`/?${messageQuery('m7')}`);
    await choose(reader(page), 'Add a label…');
    await expect(addLabelsDialog(page)).toBeVisible();
    await writeLabel(page, 'Field trips');
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();
    await param(page, 'message').toBe('m7');

    await choose(reader(page), 'Field trips');
    await expect(toasts(page)).toContainText('as Field trips');
  });

  test('a rule on a fact alone is for mail from anyone, and re-decides what is waiting', async ({ page }) => {
    await page.goto('/rules');
    const dialog = await writeRule(page);
    await dialog.getByRole('combobox', { name: 'Condition 1' }).click();
    await page.getByRole('option', { name: 'is in Promotions' }).click();
    await expect(dialog.getByText('From anyone.')).toBeVisible();
    await addRule(dialog);
    await expect(dialog).toHaveCount(0);
    const sheet = rulePanel(page, 'mail that is in Promotions');
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).toHaveCount(0);

    await expect(row(page, 'mail that is in Promotions')).toContainText('Archive');
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 10');
  });

  test('For review narrowed to replies shows only Ada’s, with a chip that clears it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('radio', { name: 'Is a reply' }).click();
    await param(page, 'fact').toBe('reply');
    await expect(reviewRows(page)).toHaveCount(1);
    await expect(row(page, 'Lunch on Thursday?')).toBeVisible();

    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('button', { name: 'Clear Mail that is a reply' }).click();
    await param(page, 'fact').toBeNull();
    await expect(reviewRows(page)).toHaveCount(9);
  });
});

test.describe('A message opened by its address', () => {
  test('opens over For review, and Close leaves For review with nothing in the address', async ({ page }) => {
    await page.goto(`/?${messageQuery('m6')}`);
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await path(page).toBe('/');
    await query(page).toBe('');
    await expect(row(page, 'Lunch on Thursday?')).toBeVisible();
  });

  test('Escape closes it, and opening a row afterwards opens that row', async ({ page }) => {
    await page.goto(`/?${messageQuery('m6')}`);
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');

    await openMessage(page, 'Notes from the review');
    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
  });
});

test.describe('A message opened from a list', () => {
  test('a row of For review opens it, Back closes it, and Forward opens it again', async ({ page }) => {
    await page.goto('/');
    await openMessage(page, 'Notes from the review');
    await param(page, 'message').toBe('m7');
    await page.goBack();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');

    await page.goForward();
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();
    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
  });

  test('the sender link in the panel’s header goes to the sender, closing the panel', async ({ page }) => {
    await page.goto('/');
    await (await openMessage(page, 'Notes from the review')).getByRole('link', { name: 'Grace Hopper' }).click();
    await expect(page.getByRole('heading', { name: 'Grace Hopper', level: 1 })).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
    await path(page).toBe(senderPage('grace@example.net'));
    await param(page, 'message').toBeNull();
  });
});
