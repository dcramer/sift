import type { Page } from '@playwright/test';
import {
  addALabelDialog,
  addLabelsDialog,
  choose,
  closeSettings,
  expect,
  messageQuery,
  openMessage,
  back,
  reader,
  param,
  path,
  PHONE,
  query,
  refused,
  row,
  toasts,
  section,
  settingsActive,
  settled,
  suggestLabels,
  test,
  toast,
  writeLabel,
} from './sift.ts';

/** The label's panel on the Labels screen. Not the toast saying it was removed, a dialog named by the label too, which is never modal. */
const labelPanel = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true }).and(page.locator(':not([aria-modal="false"])'));

/** "12 of 30" beside `Add labels`: how many labels there are, of how many there may be. */
const labelCount = (page: Page) => page.getByText(/^\d+ of \d+$/);

/** In the open Add labels, asks the model for labels for `words`. */
async function askForLabels(page: Page, words: string) {
  const dialog = addLabelsDialog(page);
  await dialog.getByRole('textbox', { name: 'What mail, and what should happen to it?' }).fill(words);
  await dialog.getByRole('button', { name: 'Suggest labels' }).click();
  return dialog;
}

async function openLabel(page: Page, name: string) {
  await page.getByText(name, { exact: true }).click();
  const opened = labelPanel(page, name);
  await expect(opened.getByRole('heading', { name, level: 2 })).toBeVisible();
  return opened;
}

test.describe('Labels', () => {
  test('heads its figures once, over the first group, and on a phone not at all', async ({ page }) => {
    await page.goto('/labels');
    // Heads kept for screen readers are in a row a pixel wide; one a phone drops has no width.
    const shown = async (name: string) =>
      Number(
        await page.evaluate(
          `[...document.querySelectorAll('main th')].filter((th) => th.textContent === ${JSON.stringify(name)} && th.getBoundingClientRect().width > 0 && th.closest('thead').getBoundingClientRect().width > 1).length`,
        ),
      );
    await expect(page.getByRole('main').getByRole('columnheader', { name: 'Messages', exact: true })).toHaveCount(3);
    await expect.poll(() => shown('Messages')).toBe(1);
    await expect.poll(() => shown('Right')).toBe(1);
    await page.setViewportSize(PHONE);
    await expect.poll(() => shown('Messages')).toBe(0);
  });

  test('changing what Sift does with a label moves it, and stays changed', async ({ page }) => {
    await page.goto('/labels');
    await expect(section(page, 'Archived').getByText('Newsletters', { exact: true })).toBeVisible();

    const opened = await openLabel(page, 'Newsletters');
    await path(page).toBe('/labels/newsletter');
    await expect(opened.getByRole('textbox', { name: 'Name' })).toHaveValue('Newsletters');
    await expect(opened.getByRole('combobox', { name: 'What Sift does with it' })).toHaveText(/Archive/);
    await expect(opened.getByRole('checkbox', { name: 'Unsubscribe, when the sender offers a safe way' })).not.toBeChecked();
    await expect(opened.getByRole('button', { name: 'Save' })).toBeDisabled();

    await opened.getByRole('combobox', { name: 'What Sift does with it' }).click();
    await expect(page.getByRole('option')).toHaveText([/Keep/, /Archive/, /Digest/, /Spam/, /Block/]);
    await page.getByRole('option', { name: 'Keep' }).click();
    await opened.getByRole('button', { name: 'Save' }).click();

    // Saving leaves the panel open on what was saved.
    await expect(opened.getByRole('button', { name: 'Save' })).toBeDisabled();
    await expect(opened.getByRole('button', { name: 'Undo changes' })).toHaveCount(0);
    await path(page).toBe('/labels/newsletter');

    await opened.getByRole('button', { name: 'Close' }).click();
    await expect(opened).toHaveCount(0);
    await param(page, 'label').toBeNull();
    await expect(section(page, 'Kept in your inbox').getByText('Newsletters', { exact: true })).toBeVisible();

    await page.reload();
    await expect(section(page, 'Kept in your inbox').getByText('Newsletters', { exact: true })).toBeVisible();
    await expect(labelPanel(page, 'Newsletters')).toHaveCount(0);
  });

  test('a label set to Digest is listed under its own heading, and Settings sets the hour its digest comes', async ({ page }) => {
    await page.goto('/labels?settings=1');
    await expect(settingsActive(page).getByText(/^(On|Off)$/)).toBeVisible();
    await expect(settingsActive(page).getByText('Daily digest')).toHaveCount(0);
    await closeSettings(page);

    const opened = await openLabel(page, 'Newsletters');
    await opened.getByRole('combobox', { name: 'What Sift does with it' }).click();
    await page.getByRole('option', { name: 'Digest' }).click();
    await expect(opened.getByText('once a day one email lists it', { exact: false })).toBeVisible();
    await expect(opened.getByRole('checkbox', { name: 'Mark it read' })).toBeVisible();
    await opened.getByRole('button', { name: 'Save' }).click();
    await expect(opened.getByRole('button', { name: 'Save' })).toBeDisabled();
    await opened.getByRole('button', { name: 'Close' }).click();
    await expect(section(page, 'In a daily digest').getByText('Newsletters', { exact: true })).toBeVisible();

    // The label told Sift this browser's time zone, which the digest's hour is read in.
    const zone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    await page.goto('/labels?settings=1');
    await expect(settingsActive(page).getByText(`One email each for Newsletters, in me@example.org, on ${zone.split('/').at(-1)} time.`)).toBeVisible();
    const hour = settingsActive(page).getByRole('combobox', { name: 'Digest time' });
    await expect(hour).toHaveText(/^7:00 AM/);
    await hour.click();
    await page.getByRole('option', { name: '6:00 AM', exact: true }).click();
    await expect(hour).toHaveText(/^6:00 AM/);
    await page.reload();
    await expect(settingsActive(page).getByRole('combobox', { name: 'Digest time' })).toHaveText(/^6:00 AM/);
  });

  test('Spam has no Mark it read, and Undo changes puts the form back', async ({ page }) => {
    await page.goto('/labels/marketing');
    const opened = labelPanel(page, 'Marketing');
    const markRead = opened.getByRole('checkbox', { name: 'Mark it read' });
    await markRead.check();
    await expect(opened.getByRole('button', { name: 'Undo changes' })).toBeVisible();

    await opened.getByRole('combobox', { name: 'What Sift does with it' }).click();
    await page.getByRole('option', { name: 'Spam' }).click();
    await expect(markRead).toHaveCount(0);

    await opened.getByRole('button', { name: 'Undo changes' }).click();
    await expect(opened.getByRole('combobox', { name: 'What Sift does with it' })).toHaveText(/Archive/);
    await expect(markRead).not.toBeChecked();

    await opened.getByRole('combobox', { name: 'What Sift does with it' }).click();
    await page.getByRole('option', { name: 'Spam' }).click();
    await opened.getByRole('button', { name: 'Save' }).click();
    await expect(opened.getByRole('button', { name: 'Save' })).toBeDisabled();
    await opened.getByRole('button', { name: 'Close' }).click();
    await expect(section(page, 'Marked spam').getByText('Marketing', { exact: true })).toBeVisible();
  });

  test('a renamed label keeps its place in the list and its panel', async ({ page }) => {
    await page.goto('/labels');
    const opened = await openLabel(page, 'Newsletters');
    await opened.getByRole('textbox', { name: 'Name' }).fill('Digests');
    await opened.getByRole('textbox', { name: 'What it is' }).fill('Weekly roundups I read on Sundays.');
    await opened.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('dialog', { name: 'Digests' })).toBeVisible();
    await path(page).toBe('/labels/newsletter');
    await page.getByRole('dialog', { name: 'Digests' }).getByRole('button', { name: 'Close' }).click();
    const listed = section(page, 'Archived').getByRole('row', { name: /^Digests / });
    await expect(listed).toContainText('Weekly roundups I read on Sundays.');
    await expect(section(page, 'Archived').getByText('Newsletters', { exact: true })).toHaveCount(0);
  });

  test('a label cannot be saved without a name', async ({ page }) => {
    await page.goto('/labels/newsletter');
    const opened = labelPanel(page, 'Newsletters');
    await opened.getByRole('textbox', { name: 'Name' }).fill('  ');
    await expect(opened.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  test('suggested labels: one kept, with a note for what the labels already cover', async ({ page }) => {
    await page.goto('/labels');
    await expect(labelCount(page)).toHaveText(/^10 of /);

    await page.getByRole('button', { name: 'Add labels' }).click();
    const dialog = await askForLabels(page, 'Archive sales pitches and my receipts');

    await expect(dialog.getByText('Not in these labels')).toBeVisible();
    await expect(dialog.getByText('Your Receipts and transactions label covers receipts already.')).toBeVisible();
    await expect(dialog.getByRole('checkbox', { name: 'Use Sales pitches' })).toBeChecked();
    await dialog.getByRole('button', { name: 'Add this label' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(section(page, 'Archived').getByText('Sales pitches', { exact: true })).toBeVisible();
    // Made in both mailboxes, so no "Only in".
    await expect(section(page, 'Archived').getByRole('row').filter({ hasText: 'Sales pitches' })).not.toContainText('Only in');
    await expect(labelCount(page)).toHaveText(/^11 of /);
  });

  test('a suggested Digest label is made as one, under its own heading', async ({ page }) => {
    await page.goto('/labels');
    await page.getByRole('button', { name: 'Add labels' }).click();
    const dialog = await askForLabels(page, 'Only show me builds when one fails');
    await expect(dialog.getByRole('row').filter({ hasText: 'Build results' })).toContainText('Digest');
    await dialog.getByRole('button', { name: 'Add this label' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(section(page, 'In a daily digest').getByText('Build results', { exact: true })).toBeVisible();
  });

  test('a suggestion left unticked is not added', async ({ page }) => {
    await page.goto('/labels');
    await page.getByRole('button', { name: 'Add labels' }).click();
    const dialog = await askForLabels(page, 'No more sales pitches');
    await dialog.getByRole('checkbox', { name: 'Use Sales pitches' }).uncheck();
    await expect(dialog.getByRole('button', { name: 'Add these labels' })).toBeDisabled();
  });

  test('words the labels already cover get the note alone, and Back keeps the words', async ({ page }) => {
    await page.goto('/labels');
    await page.getByRole('button', { name: 'Add labels' }).click();
    const dialog = await askForLabels(page, 'Keep my receipts');

    await expect(dialog.getByText('Your Receipts and transactions label covers receipts already.')).toBeVisible();
    await expect(dialog.getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /^(Add|Save)/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Back' }).click();
    await expect(dialog.getByRole('textbox', { name: 'What mail, and what should happen to it?' })).toHaveValue('Keep my receipts');
  });

  refused('words the model makes nothing of say so, and the dialog stays', async ({ page }) => {
    await page.goto('/labels');
    await page.getByRole('button', { name: 'Add labels' }).click();
    const dialog = await askForLabels(page, 'Something about the weather');
    await expect(dialog.getByText('The model could not suggest labels (the model did not suggest any usable labels). Try again.')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Suggest labels' })).toBeEnabled();
  });

  test('a label written by hand', async ({ page }) => {
    await page.goto('/labels');
    await expect(labelCount(page)).toHaveText(/^10 of /);
    await page.getByRole('button', { name: 'Add labels' }).click();
    await addLabelsDialog(page).getByRole('button', { name: 'Write one yourself' }).click();

    const manual = addALabelDialog(page);
    const add = manual.getByRole('button', { name: 'Add label', exact: true });
    await expect(add).toBeDisabled();
    await manual.getByRole('textbox', { name: 'Name' }).fill('Field trips');
    await manual.getByRole('textbox', { name: 'What it is' }).fill('Permission slips and trip plans from school.');
    await manual.getByRole('combobox', { name: 'What Sift does with it' }).click();
    await page.getByRole('option', { name: 'Keep' }).click();
    await add.click();

    await expect(manual).toHaveCount(0);
    await expect(section(page, 'Kept in your inbox').getByRole('row').filter({ hasText: 'Field trips' })).toContainText(
      'Permission slips and trip plans from school.',
    );
    await expect(labelCount(page)).toHaveText(/^11 of /);
    await query(page).toBe('');
  });

  test('closing Add labels adds nothing and opens no panel', async ({ page }) => {
    await page.goto('/labels');
    await page.getByRole('button', { name: 'Add labels' }).click();
    await addLabelsDialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(addLabelsDialog(page)).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await query(page).toBe('');
  });

  test('removing a label asks what goes, then closes its panel with a toast', async ({ page }) => {
    await page.goto('/labels');
    await expect(labelCount(page)).toHaveText(/^10 of /);
    const opened = await openLabel(page, 'Newsletters');

    await opened.getByRole('button', { name: 'Remove…' }).click();
    const ask = page.getByRole('dialog', { name: 'Remove Newsletters and its 1 rule?' });
    await expect(ask).toContainText('stops being shown to the model as examples');
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await settled(page);
    await expect(opened).toBeVisible();

    await opened.getByRole('button', { name: 'Remove…' }).click();
    await ask.getByRole('button', { name: 'Remove', exact: true }).click();

    await expect(opened).toHaveCount(0);
    await expect(toast(page, 'Newsletters')).toContainText('Label removed');
    await param(page, 'label').toBeNull();
    await expect(page.getByRole('main').getByText('Newsletters', { exact: true })).toHaveCount(0);
    await expect(labelCount(page)).toHaveText(/^9 of /);

    await page.goto('/rules');
    await expect(page.getByRole('heading', { name: 'Rules' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'news.example.com' })).toHaveCount(0);
  });

  test('Escape puts back the question to remove, and leaves the panel open', async ({ page }) => {
    await page.goto('/labels/newsletter');
    const opened = labelPanel(page, 'Newsletters');
    await opened.getByRole('button', { name: 'Remove…' }).click();
    const ask = page.getByRole('dialog', { name: 'Remove Newsletters and its 1 rule?' });
    await expect(ask.getByRole('button', { name: 'Remove', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await settled(page);
    await expect(ask).toHaveCount(0);
    await expect(opened.getByRole('button', { name: 'Remove…' })).toBeVisible();
    await path(page).toBe('/labels/newsletter');
  });

  test('Escape in the outcome list closes only the list', async ({ page }) => {
    await page.goto('/labels/newsletter');
    const opened = labelPanel(page, 'Newsletters');
    await opened.getByRole('combobox', { name: 'What Sift does with it' }).click();
    await expect(page.getByRole('option', { name: 'Keep' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('option')).toHaveCount(0);
    await settled(page);
    await expect(opened).toBeVisible();
    await path(page).toBe('/labels/newsletter');
  });

  test('a label’s rule count leads to those rules alone', async ({ page }) => {
    await page.goto('/labels/newsletter');
    await labelPanel(page, 'Newsletters').getByRole('link', { name: '1', exact: true }).click();
    await expect(page).toHaveURL(/\/rules\?label=newsletter$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'anyone at news.example.com' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'anyone at ci.example.org' })).toHaveCount(0);
  });

  test('Leave in inbox is Sift’s own: nothing in it to change or remove', async ({ page }) => {
    await page.goto('/labels');
    const opened = await openLabel(page, 'Leave in inbox');
    await expect(opened.getByText('Mail none of your labels fit stays in your inbox.')).toBeVisible();
    await expect(opened.getByRole('textbox')).toHaveCount(0);
    await expect(opened.getByRole('combobox')).toHaveCount(0);
    await expect(opened.getByRole('button', { name: /^Remove/ })).toHaveCount(0);
  });

  test('Previous and Next step through the labels in the order they are listed', async ({ page }) => {
    await page.goto('/labels');
    const first = await openLabel(page, 'Leave in inbox');
    await expect(first.getByText('1 of 11')).toBeVisible();
    await expect(first.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await first.getByRole('button', { name: 'Next' }).click();
    const second = labelPanel(page, 'Account alerts');
    await expect(second.getByRole('heading', { name: 'Account alerts', level: 2 })).toBeVisible();
    await path(page).toBe('/labels/security');
    await second.getByRole('button', { name: 'Previous' }).click();
    await expect(labelPanel(page, 'Leave in inbox')).toBeVisible();
  });
});

test.describe('Adding a label from an open message', () => {
  const AT = `/?${messageQuery('m6')}`;
  const open = async (page: Page) => {
    await page.goto('/');
    await openMessage(page, 'Lunch on Thursday?');
    await expect(page).toHaveURL(AT);
  };

  test('the new label is a choice in the same panel, and picking it answers the message', async ({ page }) => {
    await open(page);
    await choose(reader(page), 'Add a label…');
    await expect(addLabelsDialog(page)).toBeVisible();
    await writeLabel(page, 'Field trips');

    await settled(page);
    await expect(reader(page)).toBeVisible();
    await expect(page).toHaveURL(AT);
    await choose(reader(page), 'Field trips');
    await expect(toasts(page)).toContainText('as Field trips');
  });

  test('a suggested label is a choice in the same panel', async ({ page }) => {
    await open(page);
    await choose(reader(page), 'Add a label…');
    const dialog = await askForLabels(page, 'No more sales pitches');
    await dialog.getByRole('button', { name: 'Add this label' }).click();

    await expect(dialog).toHaveCount(0);
    await settled(page);
    await expect(page).toHaveURL(AT);
    await reader(page).getByRole('combobox', { name: 'What this message is' }).click();
    await expect(page.getByRole('option', { name: 'Sales pitches', exact: true })).toBeVisible();
  });

  test('closing the dialog leaves the panel as it was', async ({ page }) => {
    await open(page);
    await choose(reader(page), 'Add a label…');
    const dialog = addLabelsDialog(page);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await settled(page);
    await expect(reader(page)).toBeVisible();
    await expect(page).toHaveURL(AT);
  });

  test('Escape closes only the dialog', async ({ page }) => {
    await open(page);
    await choose(reader(page), 'Add a label…');
    const dialog = addLabelsDialog(page);
    await expect(dialog.getByRole('textbox', { name: 'What mail, and what should happen to it?' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await settled(page);
    await expect(reader(page)).toBeVisible();
    await expect(page).toHaveURL(AT);
  });

  test('closing the panel after adding a label keeps it closed', async ({ page }) => {
    await open(page);
    await choose(reader(page), 'Add a label…');
    await writeLabel(page, 'Field trips');

    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
    await settled(page);
    await expect(row(page, 'Lunch on Thursday?')).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
  });
});

refused.describe('A mailbox with one label', () => {
  refused.use({ variant: 'bare' });

  refused('removing it is refused, and says why', async ({ page }) => {
    await page.goto('/');
    await suggestLabels(page, 'No more sales pitches');
    await page.getByRole('button', { name: 'Use this label' }).click();
    await page.getByRole('button', { name: 'New mail only' }).click();
    await page.goto('/labels');
    await page.getByText('Sales pitches', { exact: true }).click();
    const opened = page.getByRole('dialog', { name: 'Sales pitches', exact: true });
    await opened.getByRole('button', { name: 'Remove…' }).click();
    // The refusal stays in the question, which is still open over the panel.
    const ask = page.getByRole('dialog', { name: 'Remove Sales pitches?' });
    await ask.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(ask.getByText('Sales pitches is the last of your labels, and Sift reads no mail without one. Add another first.')).toBeVisible();
    await expect(page.getByText('Label removed')).toHaveCount(0);
  });
});
