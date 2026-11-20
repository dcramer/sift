import type { Page } from '@playwright/test';
import { closeSettings, expect, param, path, PHONE, query, refused, settings, sideScroll, suggestLabels, test, WANT } from './sift.ts';

const steps = (page: Page) => page.locator('ol > li');
const current = (page: Page) => page.locator('[aria-current="step"]');

test.describe('Setting up with no labels', () => {
  test.use({ variant: 'bare' });

  test('starts at what you want, with the model step done', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: WANT, level: 1 })).toBeVisible();
    await expect(steps(page)).toHaveText(['Connect a model', '2What you want', '3Your labels', '4Older mail']);
    await expect(steps(page).first().getByLabel('Done')).toBeVisible();
    await expect(current(page)).toHaveText('2What you want');
    await expect(page.getByRole('link', { name: 'For review' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Suggest labels' })).toBeDisabled();
  });

  test('an example goes into the box, and leaves the examples', async ({ page }) => {
    await page.goto('/');
    const examples = page.getByRole('list', { name: 'Examples' });
    await examples.getByRole('button', { name: 'Get sales pitches out of my inbox' }).click();
    await expect(page.getByRole('textbox', { name: WANT })).toHaveValue('Get sales pitches out of my inbox.');
    await expect(examples.getByRole('button', { name: 'Get sales pitches out of my inbox' })).toHaveCount(0);
    await expect(examples.getByRole('button')).toHaveCount(6);

    await examples.getByRole('button', { name: 'Never miss mail from a person' }).click();
    await expect(page.getByRole('textbox', { name: WANT })).toHaveValue('Get sales pitches out of my inbox. Never miss mail from a person.');
    await expect(page.getByRole('button', { name: 'Suggest labels' })).toBeEnabled();
  });

  test('from what you want to For review', async ({ page }) => {
    await page.goto('/');
    await suggestLabels(page, 'No more sales pitches');
    await expect(current(page)).toHaveText('3Your labels');
    await expect(page.getByText('“No more sales pitches”')).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Use Sales pitches' })).toBeChecked();
    await page.getByRole('button', { name: 'Use this label' }).click();

    await expect(page.getByRole('heading', { name: 'Older mail', level: 1 })).toBeVisible();
    await expect(current(page)).toHaveText('4Older mail');
    await expect(page.getByText('$0.06')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go through 21' })).toBeVisible();
    await page.getByRole('button', { name: 'New mail only' }).click();

    await expect(page.getByRole('heading', { name: 'For review', level: 1 })).toBeVisible();
    await path(page).toBe('/');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'For review', level: 1 })).toBeVisible();

    // The person's label, for every mailbox of theirs.
    await page.goto('/labels');
    await expect(page.getByRole('row', { name: /^Sales pitches / })).toBeVisible();
  });

  test('the newest of the inbox is gone through to suggest about, and Settings says how far it has got', async ({ page }) => {
    await page.goto('/');
    await suggestLabels(page, 'No more sales pitches');
    await page.getByRole('button', { name: 'Use this label' }).click();
    await page.getByRole('button', { name: 'Go through 21' }).click();
    await expect(page.getByRole('heading', { name: 'For review', level: 1 })).toBeVisible();
    await page.goto('/?settings=1');
    await expect(settings(page).getByText('Going through your inbox')).toBeVisible();
  });

  test('a suggestion edited before it is used is made as edited', async ({ page }) => {
    await page.goto('/');
    await suggestLabels(page, 'No more sales pitches');
    await page.getByRole('button', { name: 'Edit Sales pitches' }).click();
    const edit = page.getByRole('dialog', { name: 'Sales pitches' });
    await edit.getByRole('textbox', { name: 'Name' }).fill('Pitches');
    await edit.getByRole('button', { name: 'Done' }).click();
    await expect(edit).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Use Pitches' })).toBeChecked();

    // Cancel keeps what was there.
    await page.getByRole('button', { name: 'Edit Pitches' }).click();
    const again = page.getByRole('dialog', { name: 'Pitches' });
    await again.getByRole('textbox', { name: 'Name' }).fill('Something else');
    await again.getByRole('button', { name: 'Cancel' }).click();
    await expect(again).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: 'Use Pitches' })).toBeVisible();

    await page.getByRole('button', { name: 'Use this label' }).click();
    await page.getByRole('button', { name: 'New mail only' }).click();
    await page.goto('/labels');
    await expect(page.getByRole('row', { name: /^Pitches / })).toBeVisible();
  });

  test('every suggestion unticked leaves nothing to use', async ({ page }) => {
    await page.goto('/');
    await suggestLabels(page, 'No more sales pitches');
    await page.getByRole('checkbox', { name: 'Use Sales pitches' }).uncheck();
    await expect(page.getByRole('button', { name: 'Use these labels' })).toBeDisabled();
  });

  test('words the labels would not cover get the note and Start over alone, which keeps the words', async ({ page }) => {
    await page.goto('/');
    await suggestLabels(page, 'Just my receipts');
    await expect(page.getByText('Not in these labels')).toBeVisible();
    await expect(page.getByText('Your Receipts and transactions label covers receipts already.')).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Use / })).toHaveCount(0);

    // The latest suggestions decide the step, so a reload comes back to them.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Your labels', level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Start over' }).click();
    await expect(page.getByRole('heading', { name: WANT, level: 1 })).toBeVisible();
    await expect(page.getByRole('textbox', { name: WANT })).toHaveValue('Just my receipts');
  });

  refused('words the model makes nothing of say so, and stay', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('textbox', { name: WANT }).fill('Something about the weather');
    await page.getByRole('button', { name: 'Suggest labels' }).click();
    await expect(page.getByText('The model could not suggest labels (the model did not suggest any usable labels). Try again.')).toBeVisible();
    await expect(page.getByRole('heading', { name: WANT, level: 1 })).toBeVisible();
    await expect(page.getByRole('textbox', { name: WANT })).toHaveValue('Something about the weather');
  });

  test('Settings opens over a step, and closing it returns to the same step', async ({ page }) => {
    await page.goto('/');
    await suggestLabels(page, 'No more sales pitches');
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(settings(page)).toBeVisible();
    await param(page, 'settings').toBe('1');
    await closeSettings(page);
    await query(page).toBe('');
    await expect(page.getByRole('heading', { name: 'Your labels', level: 1 })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Use Sales pitches' })).toBeChecked();
  });

  test('fits a phone', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/');
    await expect(page.getByText('Step 2 of 4: What you want')).toBeVisible();
    await suggestLabels(page, 'No more sales pitches');
    await expect(page.getByText('Step 3 of 4: Your labels')).toBeVisible();
    // A string, as e2e is typed without the DOM.
    await sideScroll(page).toBe(0);
  });
});

test.describe('A model signed out after setting up', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() =>
      fetch('/api/model/signout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sift': '1' },
        body: JSON.stringify({ provider: 'anthropic' }),
      }),
    );
    await page.reload();
  });

  test('is the only thing to do, with no steps', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'No model connected', level: 1 })).toBeVisible();
    await expect(page.getByText('Anthropic is signed out, so nothing new is classified or suggested.', { exact: false })).toBeVisible();
    await expect(current(page)).toHaveCount(0);
    await expect(page.getByRole('cell', { name: /^Anthropic/ })).toBeVisible();
  });

  test('a provider’s step goes Back to the list', async ({ page }) => {
    await page.getByRole('cell', { name: /^OpenAI Billed per message/ }).click();
    await expect(page.getByRole('heading', { name: 'Paste your OpenAI key.', level: 1 })).toBeVisible();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByRole('heading', { name: 'No model connected', level: 1 })).toBeVisible();
  });

  test('Settings’ Connect a model closes Settings onto the step', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await settings(page).getByRole('button', { name: 'Connect a model' }).click();
    await expect(settings(page)).toHaveCount(0);
    await query(page).toBe('');
    await expect(page.getByRole('heading', { name: 'No model connected', level: 1 })).toBeVisible();
  });
});
