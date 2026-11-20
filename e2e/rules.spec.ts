import { addRule, fact, openRule, removeQuestion, removeRule, ruleDialog, ruleId, rulePanel, ruleRows, writeRule } from './rule.ts';
import { back, expect, forReviewLink, reader, readerHeading, param, path, pointAt, query, row, test, throughChatGPT, toast, tooltip } from './sift.ts';

test.describe('Rules', () => {
  test('a rule written by hand opens on its panel, and takes the mail it covers off For review', async ({ page }) => {
    await page.goto('/rules');
    await page.getByRole('button', { name: 'Add a rule' }).click();
    const dialog = ruleDialog(page);
    await expect(dialog.getByRole('textbox', { name: 'What should it do?' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Fill in the rule' })).toBeDisabled();

    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    const add = dialog.getByRole('button', { name: 'Add rule', exact: true });
    await expect(add).toBeDisabled();
    await expect(dialog.getByRole('combobox', { name: 'Condition 1' })).toContainText('from');
    await expect(dialog.getByRole('combobox', { name: 'Label it as' })).toContainText('No label, just act');
    await expect(dialog.getByRole('combobox', { name: 'What happens to it' })).toContainText('Archive');
    // Said before anything is typed there: the cost is why to leave it empty.
    await expect(dialog.getByText('A model checks this, one call per message the rule matches.')).toBeVisible();
    // What is typed is set as what is chosen beside it.
    await expect(dialog.getByRole('combobox', { name: 'Condition 1' })).toHaveCSS('font-size', '14px');
    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toHaveCSS('font-size', '14px');

    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('deals@promo.example.com');
    await expect(dialog.getByText('Only this address.')).toBeVisible();
    await expect(add).toBeEnabled();
    await addRule(dialog);

    await expect(dialog).toHaveCount(0);
    const opened = rulePanel(page, 'deals@promo.example.com');
    await expect(fact(opened, 'Then')).toHaveText('Archive');
    await expect(fact(opened, 'Matched, 30 days')).toHaveText('1');
    await expect(fact(opened, 'All time')).toHaveText('1');
    await expect(opened.getByRole('cell', { name: '48 hours only: 30% off' })).toBeVisible();
    await path(page).toMatch(/^\/rules\/r-/);

    await opened.getByRole('button', { name: 'Close' }).click();
    await expect(opened).toHaveCount(0);
    await path(page).toBe('/rules');
    await query(page).toBe('');
    // Sorted by use, the new rule has caught Deals and the Spam rule below it has not.
    await expect(ruleRows(page)).toHaveCount(5);
    const rules = await ruleRows(page).allTextContents();
    const first = (text: string) => rules.findIndex((rule) => rule.startsWith(text));
    expect(first('deals@promo.example.com')).toBeLessThan(first('anyone at promo.example.com'));

    await forReviewLink(page).click();
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 11');
    await expect(row(page, 'Notes from the review')).toBeVisible();
    await expect(row(page, '48 hours only: 30% off')).toHaveCount(0);
  });

  test('heads its figures, says the exact time when pointed at, and costs a rule a model checks', async ({ page }) => {
    await page.goto('/rules');
    const head = (name: string) => page.getByRole('main').getByRole('columnheader', { name, exact: true });
    await expect(head('Decisions')).toBeVisible();
    await expect(head('Decisions')).toHaveCSS('text-transform', 'uppercase');
    await expect(head('Last used')).toBeVisible();
    // No rule has a condition for a model to check, so nothing here costs anything.
    await expect(head('Cost 30D')).toHaveCount(0);

    const news = ruleRows(page).filter({ hasText: 'anyone at news.example.com' });
    await pointAt(news.getByText(/^(just now|\d+ min ago)$/));
    await expect(tooltip(page)).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/);

    const dialog = await writeRule(page);
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('deals@promo.example.com');
    await dialog.getByRole('combobox', { name: 'Label it as' }).click();
    await page.getByRole('option', { name: 'Marketing' }).click();
    await dialog.getByRole('textbox', { name: 'Only when it is, in your words' }).fill('a sale that ends today');
    await addRule(dialog);
    const opened = rulePanel(page, 'deals@promo.example.com');
    await expect(fact(opened, 'Cost, 30 days')).toHaveText('$0');
    await expect(opened.getByText('0 messages checked', { exact: true })).toBeVisible();
    await opened.getByRole('button', { name: 'Close' }).click();

    await expect(head('Cost 30D')).toBeVisible();
    const deals = ruleRows(page).filter({ hasText: 'deals@promo.example.com' });
    await pointAt(deals.getByText('$0', { exact: true }));
    await expect(tooltip(page)).toHaveText('0 messages checked');
    // The rules no model checks leave the column empty.
    await expect(news.getByText(/\$/)).toHaveCount(0);
  });

  test.describe(() => {
    test.use({ variant: 'chatgpt' });

    test('through a ChatGPT plan, what the model cost is marked as API prices', async ({ page }) => {
      await throughChatGPT(page);
      await page.goto('/rules');
      const dialog = await writeRule(page);
      await dialog.getByRole('textbox', { name: 'Value 1' }).fill('deals@promo.example.com');
      await dialog.getByRole('combobox', { name: 'Label it as' }).click();
      await page.getByRole('option', { name: 'Marketing' }).click();
      await dialog.getByRole('textbox', { name: 'Only when it is, in your words' }).fill('a sale that ends today');
      await addRule(dialog);
      const opened = rulePanel(page, 'deals@promo.example.com');
      await expect(fact(opened, 'Cost, 30 days')).toHaveText('≈$0');
      await expect(opened.getByText('0 messages checked, at API prices', { exact: true })).toBeVisible();
      await opened.getByRole('button', { name: 'Close' }).click();

      const deals = ruleRows(page).filter({ hasText: 'deals@promo.example.com' });
      await expect(deals.getByText('≈$0', { exact: true })).toBeVisible();
      await pointAt(page.getByRole('main').getByRole('columnheader', { name: 'Cost 30D', exact: true }));
      await expect(tooltip(page)).toHaveText(/At API prices, which your ChatGPT plan covers\.$/);

      await page.goto('/activity');
      await expect(page.getByRole('listitem', { name: /model cost at api prices$/ }).first()).toBeAttached();
    });
  });

  test('Fill in the rule drafts the form from the words, and says what it left out', async ({ page }) => {
    await page.goto('/rules');
    await page.getByRole('button', { name: 'Add a rule' }).click();
    const dialog = ruleDialog(page);
    const words = dialog.getByRole('textbox', { name: 'What should it do?' });
    await words.fill('Archive the deals from promo');
    await dialog.getByRole('button', { name: 'Fill in the rule' }).click();

    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toHaveValue('deals@promo.example.com');
    await expect(dialog.getByRole('combobox', { name: 'Condition 1' })).toContainText('from');
    await expect(dialog.getByText('Not in this rule')).toBeVisible();
    await expect(dialog.getByText('Add another rule for grace@example.net.')).toBeVisible();
    await expect(dialog.getByRole('combobox', { name: 'Label it as' })).toContainText('No label, just act');
    await expect(dialog.getByRole('combobox', { name: 'What happens to it' })).toContainText('Archive');
    await expect(dialog.getByRole('checkbox', { name: 'Mark it read' })).toBeChecked();

    await dialog.getByRole('button', { name: 'Describe it instead' }).click();
    await expect(words).toHaveValue('Archive the deals from promo');
    await dialog.getByRole('button', { name: 'Fill in the rule' }).click();
    await addRule(dialog);

    await expect(fact(rulePanel(page, 'deals@promo.example.com'), 'Then')).toHaveText('Archive, marked read');
  });

  test('several values read back as one rule, and the list says its name', async ({ page }) => {
    await page.goto('/rules');
    const dialog = await writeRule(page);
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('example.com');
    await expect(dialog.getByText('Mail from anyone at example.com.')).toBeVisible();
    await dialog.getByRole('button', { name: 'Add a condition' }).click();
    await dialog.getByRole('textbox', { name: 'Value 2' }).fill('shop@example.net');
    await dialog.getByRole('button', { name: 'Add a condition' }).click();
    await dialog.getByRole('combobox', { name: 'Condition 3' }).click();
    await page.getByRole('option', { name: 'subject contains', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Value 3' }).fill('receipt');
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Shop receipts');
    await expect(dialog.getByText('Mail from shop@example.net or from anyone at example.com, with a subject containing “receipt”.')).toBeVisible();
    await addRule(dialog);

    const opened = rulePanel(page, 'Shop receipts');
    await expect(fact(opened, 'Mail')).toHaveText(/shop@example\.net.*example\.com.*receipt/);
    await opened.getByRole('button', { name: 'Close' }).click();
    await expect(row(page, 'Shop receipts')).toContainText('Archive');
  });

  test('a rule with the conditions of one already there replaces it', async ({ page }) => {
    await page.goto('/rules');
    await expect(row(page, 'anyone at promo.example.com')).toContainText('Spam');
    const dialog = await writeRule(page);
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('promo.example.com');
    await expect(dialog.getByText('Mail from anyone at promo.example.com.')).toBeVisible();
    await expect(dialog.getByRole('group', { name: 'Replaces' })).toHaveText(/Spam$/);
    await addRule(dialog);

    await rulePanel(page, 'anyone at promo.example.com').getByRole('button', { name: 'Close' }).click();
    await expect(ruleRows(page)).toHaveCount(4);
    await expect(row(page, 'anyone at promo.example.com')).toContainText('Archive');
  });

  test('closing the dialog adds nothing and leaves the address as it was', async ({ page }) => {
    await page.goto('/rules');
    const dialog = ruleDialog(page);
    await page.getByRole('button', { name: 'Add a rule' }).click();
    await dialog.getByRole('textbox', { name: 'What should it do?' }).fill('Archive the deals from promo');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByRole('button', { name: 'Add a rule' }).click();
    // Each opening starts on the question, empty.
    await expect(dialog.getByRole('textbox', { name: 'What should it do?' })).toHaveValue('');
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('deals@promo.example.com');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await expect(ruleRows(page)).toHaveCount(4);
    await query(page).toBe('');
  });

  test('a select opened from the keyboard shows focus by its fill, with no outline around its list', async ({ page }) => {
    await page.goto('/rules');
    const dialog = await writeRule(page);
    const label = dialog.getByRole('combobox', { name: 'Label it as' });
    // Reached by Tab, so the browser shows the focus.
    await label.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(label).toBeFocused();
    await expect(label).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('ArrowDown');
    const list = page.getByRole('listbox');
    await expect(list).toBeVisible();
    await expect(list).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('ArrowDown');
    for (const option of await list.getByRole('option').all()) await expect(option).toHaveCSS('outline-style', 'none');
  });

  test('a rule whose label leaves mail in the inbox offers nothing to apply there, and opens on its panel alone', async ({ page }) => {
    await page.goto('/rules');
    const dialog = await writeRule(page);
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('friend@example.org');
    await dialog.getByRole('combobox', { name: 'Label it as' }).click();
    await page.getByRole('option', { name: 'Personal' }).click();
    await expect(dialog.getByRole('checkbox', { name: 'Apply to mail already there' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Add rule', exact: true }).click();

    const opened = rulePanel(page, 'friend@example.org');
    await expect(opened).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Apply to your inbox' })).toHaveCount(0);
    await path(page).toBe(`/rules/${await ruleId(page)}`);
    await query(page).toBe('');
  });

  test("a rule's panel steps through the list, is its own address, and closes to the list", async ({ page }) => {
    const news = await openRule(page, 'anyone at news.example.com');
    await expect(news.getByText('1 of 4')).toBeVisible();
    await expect(news.getByRole('button', { name: 'Previous' })).toBeDisabled();
    await expect(fact(news, 'Then')).toHaveText('Archive as Newsletters');
    await expect(fact(news, 'Matched, 30 days')).toHaveText('2');
    // Today's column: decided while Sift was off, so not changed in Gmail. No model read them, so no cost.
    await expect(news.getByRole('listitem', { name: /: 0 changed in gmail, 2 left alone$/ })).toHaveCount(1);
    await expect(news.getByText('Model cost, 30 days')).toHaveCount(0);
    await expect(news.getByRole('cell', { name: 'This week in widgets' })).toBeVisible();
    const first = await ruleId(page);

    await news.getByRole('button', { name: 'Next' }).click();
    await expect(rulePanel(page, 'orders@shop.example.com').getByText('2 of 4')).toBeVisible();
    await path(page).not.toBe(`/rules/${first}`);

    await page.goto(`/rules/${first}`);
    await expect(news).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(news).toHaveCount(0);
    await path(page).toBe('/rules');
    await query(page).toBe('');
    await expect(ruleRows(page)).toHaveCount(4);
  });

  test("a message the rule decided opens over the rule's panel, and closing it returns there", async ({ page }) => {
    await page.goto('/rules');
    const dialog = await writeRule(page);
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('sale@store.example.com');
    await addRule(dialog);
    const opened = rulePanel(page, 'sale@store.example.com');
    const rule = await ruleId(page);

    await opened.getByRole('cell', { name: 'Winter sale starts now' }).click();
    const message = reader(page);
    await expect(readerHeading(page, 'Winter sale starts now')).toBeVisible();
    await param(page, 'message').toBe('m8');

    await back(page).click();
    await expect(message).toHaveCount(0);
    await expect(opened).toBeVisible();
    await path(page).toBe(`/rules/${rule}`);
    await query(page).toBe('');
  });

  test.describe('while Gmail is still listing the inbox', () => {
    test.use({ listing: true });

    test('Apply to your inbox says about how many and shows the newest, then applies in the background until stopped', async ({ page }) => {
      await page.goto('/rules');
      const dialog = await writeRule(page);
      await dialog.getByRole('textbox', { name: 'Value 1' }).fill('sale@store.example.com');
      await expect(dialog.getByRole('checkbox', { name: 'Apply to mail already there' })).toBeChecked();
      await dialog.getByRole('button', { name: 'Add rule', exact: true }).click();

      const apply = page.getByRole('dialog', { name: 'Apply to your inbox' });
      await expect(apply.getByText('About 1,200')).toBeVisible();
      await expect(apply.getByRole('rowgroup').last().getByRole('row')).toHaveCount(6);
      await expect(apply.getByRole('cell', { name: 'Found in Gmail 1' })).toBeVisible();
      await apply.getByRole('button', { name: 'Archive all' }).click();
      await expect(apply).toHaveCount(0);

      const opened = rulePanel(page, 'sale@store.example.com');
      await expect(opened.getByText('Finding them in Gmail · 0 so far')).toBeVisible();
      await opened.getByRole('button', { name: 'Stop' }).click();
      await expect(opened.getByText('Finding them in Gmail', { exact: false })).toHaveCount(0);
      await expect(opened.getByRole('button', { name: 'Apply to inbox…' })).toBeVisible();
    });
  });

  test('removing a rule from its panel asks what goes, and Cancel keeps it', async ({ page }) => {
    const opened = await openRule(page, 'anyone at promo.example.com');
    const ask = removeQuestion(page);

    await opened.getByRole('button', { name: 'Remove…' }).click();
    await expect(ask).toContainText('anyone at promo.example.com');
    await expect(ask.getByRole('button', { name: 'Remove', exact: true })).toBeFocused();
    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await expect(opened).toBeVisible();

    await removeRule(opened);
    await expect(toast(page, 'Mail from anyone at promo.example.com')).toBeVisible();
    await expect(opened).toHaveCount(0);
    await query(page).toBe('');
    await expect(ruleRows(page)).toHaveCount(3);
    await expect(row(page, 'anyone at promo.example.com')).toHaveCount(0);
  });

  test('removing a rule from its row asks the same, and opens no panel', async ({ page }) => {
    await page.goto('/rules');
    const promo = row(page, 'anyone at promo.example.com');
    await promo.getByRole('button', { name: 'Remove this rule' }).click();
    const ask = removeQuestion(page);
    await expect(ask).toContainText('anyone at promo.example.com');
    await expect(rulePanel(page, 'anyone at promo.example.com')).toHaveCount(0);

    await ask.getByRole('button', { name: 'Cancel' }).click();
    await expect(ask).toHaveCount(0);
    await promo.getByRole('button', { name: 'Remove this rule' }).click();
    await expect(ask).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(ask).toHaveCount(0);

    await removeRule(promo);
    await expect(promo).toHaveCount(0);
    await expect(ruleRows(page)).toHaveCount(3);
    await expect(rulePanel(page, 'anyone at promo.example.com')).toHaveCount(0);
    await query(page).toBe('');
  });

  test('Escape on Remove this rule? in a panel takes back the question and leaves the panel open', async ({ page }) => {
    const opened = await openRule(page, 'anyone at promo.example.com');
    await opened.getByRole('button', { name: 'Remove…' }).click();
    await expect(removeQuestion(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(removeQuestion(page)).toHaveCount(0);
    await expect(opened).toBeVisible();
    await opened.getByRole('button', { name: 'Previous' }).click({ timeout: 2000 });
    await expect(rulePanel(page, 'anyone at ci.example.org')).toBeVisible();
  });

  test('a rule is changed from its panel in place, never into a twin of another, and Undo puts it back', async ({ page }) => {
    const opened = await openRule(page, 'anyone at promo.example.com');
    const id = await ruleId(page);
    await expect(fact(opened, 'Then')).toHaveText('Spam');
    await opened.getByRole('button', { name: 'Change…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Change this rule' });
    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toHaveValue('promo.example.com');
    await expect(dialog.getByRole('combobox', { name: 'What happens to it' })).toContainText('Spam');

    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('news.example.com');
    await expect(dialog.getByText('Another rule has exactly these conditions. Change that one, or remove it first.')).toBeVisible();
    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    await expect(save).toBeDisabled();

    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('deals.example.com');
    await dialog.getByRole('combobox', { name: 'What happens to it' }).click();
    await page.getByRole('option', { name: 'Archive', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Name' }).fill('Deals');
    await save.click();
    await expect(toast(page, 'Deals: archive it')).toContainText('Rule changed');
    const changed = rulePanel(page, 'Deals');
    await expect(fact(changed, 'Mail')).toHaveText('anyone at deals.example.com');
    await expect(fact(changed, 'Then')).toHaveText('Archive');
    await path(page).toBe(`/rules/${id}`);

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Rule put back')).toBeVisible();
    await expect(fact(rulePanel(page, 'anyone at promo.example.com'), 'Then')).toHaveText('Spam');
  });

  test('Undo takes the rule back, and its panel goes from the page and the address', async ({ page }) => {
    await page.goto('/rules');
    const dialog = await writeRule(page);
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('someone@example.com');
    await addRule(dialog);
    await expect(rulePanel(page, 'someone@example.com')).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Rule taken back')).toBeVisible();
    await expect(rulePanel(page, 'someone@example.com')).toHaveCount(0);
    await expect(ruleRows(page)).toHaveCount(4);
    await query(page).toBe('');
  });
});

test.describe('Apply to your inbox, with what is due begun', () => {
  test('the press begins the rule’s run as a Workflow run, which finishes when the search finds nothing', async ({ page }) => {
    await page.goto('/rules');
    const dialog = await writeRule(page);
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('sale@store.example.com');
    await dialog.getByRole('button', { name: 'Add rule', exact: true }).click();
    const apply = page.getByRole('dialog', { name: 'Apply to your inbox' });
    await apply.getByRole('button', { name: 'Archive all' }).click();
    await expect(apply).toHaveCount(0);

    const opened = rulePanel(page, 'sale@store.example.com');
    await expect(async () => {
      await page.reload();
      // Its mail still waiting, read with how far applying it has got.
      await expect(opened.getByRole('cell', { name: 'Winter sale starts now' })).toBeVisible({ timeout: 1000 });
      await expect(opened.getByRole('button', { name: 'Apply to inbox…' })).toBeVisible({ timeout: 1000 });
    }).toPass();
    await expect(opened.getByText('Finding them in Gmail', { exact: false })).toHaveCount(0);
  });
});
