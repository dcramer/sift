import { addRule, fact, makeRule, proposal, ruleDialog, rulePanel, seededRulesOnly, standing } from './rule.ts';
import { domainPage, expect, messageQuery, reader, param, path, query, row, senderPage, test, toast } from './sift.ts';

/** The store's Winter sale starts now, open. */
const STORE = `?${messageQuery('m8')}`;

test.describe('Rules from a shortcut', () => {
  test('a proposal opens the dialog on its sender, its label and what the user has been doing', async ({ page }) => {
    await page.goto('/');
    await expect(proposal(page)).toContainText('You kept the last 3, but the label archives them.');
    const dialog = await makeRule(proposal(page));
    await expect(dialog.getByRole('textbox', { name: 'What should it do?' })).toHaveValue(
      'Mail from billing@utility.example.net, once it is Receipts: leave it in the inbox.',
    );
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Condition 1' })).toContainText('from');
    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toHaveValue('billing@utility.example.net');
    await expect(dialog.getByRole('combobox', { name: 'Only when it is this label' })).toContainText('Receipts');
    await expect(dialog.getByRole('combobox', { name: 'What happens to it' })).toContainText('Keep');
    await expect(dialog.getByText('A model reads each message it matches to tell.')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(proposal(page)).toBeVisible();
    await query(page).toBe('');
  });

  test('adding the rule from a proposal, changed, resolves the proposal', async ({ page }) => {
    await page.goto('/');
    const dialog = await makeRule(proposal(page));
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await dialog.getByRole('textbox', { name: 'Value 1' }).fill('utility.example.net');
    await expect(dialog.getByText('Mail from anyone at utility.example.net.')).toBeVisible();
    await addRule(dialog);
    await expect(toast(page, 'Mail from utility.example.net, once it is Receipts: leave it in the inbox')).toContainText('Rule added');

    const opened = rulePanel(page, 'anyone at utility.example.net');
    await expect(fact(opened, 'Then')).toHaveText('Leave in inbox');
    await path(page).toMatch(/^\/rules\/r-/);
    await opened.getByRole('button', { name: 'Close' }).click();
    await expect(opened).toHaveCount(0);
    await path(page).toBe('/rules');
    await query(page).toBe('');
    await expect(row(page, 'anyone at utility.example.net as Receipts')).toContainText('Leave in inbox');

    await page.goBack();
    await path(page).toBe('/');
    await expect(proposal(page)).toHaveCount(0);
  });

  test('Dismiss takes the proposal away in one press and makes no rule', async ({ page }) => {
    await page.goto('/');
    await proposal(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(proposal(page)).toHaveCount(0);
    await expect(ruleDialog(page)).toHaveCount(0);

    await page.reload();
    await expect(row(page, 'Notes from the review')).toBeVisible();
    await expect(proposal(page)).toHaveCount(0);
    await seededRulesOnly(page);
  });

  test("a message's Make a rule… and Keep as… open over its panel, which closing the dialog leaves", async ({ page }) => {
    await page.goto(`/${STORE}`);
    const message = reader(page);
    const dialog = await makeRule(message);
    await expect(dialog.getByRole('textbox', { name: 'What should it do?' })).toHaveValue('Mail from sale@store.example.com is Marketing.');
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toHaveValue('sale@store.example.com');
    await expect(dialog.getByRole('combobox', { name: 'Label it as' })).toContainText('Marketing');
    await param(page, 'message').toBe('m8');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(message).toBeVisible();

    await message.getByRole('button', { name: 'Keep as Marketing…' }).click();
    await expect(dialog.getByRole('textbox', { name: 'What should it do?' })).toHaveValue(
      'Mail from sale@store.example.com, once it is Marketing: leave it in the inbox.',
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(message).toBeVisible();
    await query(page).toBe(STORE);
  });

  test('a rule added from a message opens at its own address, and Back returns to the message', async ({ page }) => {
    await page.goto(`/${STORE}`);
    const message = reader(page);
    const dialog = await makeRule(message);
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await addRule(dialog);

    const opened = rulePanel(page, 'sale@store.example.com');
    await expect(fact(opened, 'Then')).toContainText('as Marketing');
    await path(page).toMatch(/^\/rules\/r-/);

    await page.goBack();
    await expect(opened).toHaveCount(0);
    await expect(message.getByText('Rule: from sale@store.example.com is Marketing').first()).toBeVisible();
    await query(page).toBe(STORE);
  });

  test('a fact in a message starts the rule on it', async ({ page }) => {
    await page.goto(`/${STORE}`);
    await reader(page).getByRole('button', { name: 'Make a rule for mail that came through a mailing list' }).click();
    const dialog = ruleDialog(page);
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Condition 1' })).toContainText('on the list');
    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toHaveValue('store.example.com');
    await expect(dialog.getByRole('combobox', { name: 'What happens to it' })).toContainText('Archive');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(reader(page)).toBeVisible();
  });

  test("a sender's standing is a rule given in one press: another replaces it, Undo gives the last back, and pressing it again takes it back", async ({
    page,
  }) => {
    await page.goto(senderPage('ada@example.org'));
    const pressed = async (on: string | null) => {
      for (const name of ['Trust', 'Unwanted', 'Block'])
        await expect(standing(page, 'Ada Lovelace', name)).toHaveAttribute('aria-pressed', String(name === on));
    };

    await standing(page, 'Ada Lovelace', 'Trust').click();
    const kept = toast(page, 'Mail from ada@example.org: leave it in the inbox');
    await expect(kept).toContainText('Rule added');
    // Keeping mail moves nothing, so there is nothing in the inbox to apply it to.
    await expect(kept.getByRole('button', { name: 'Apply to inbox…' })).toHaveCount(0);
    await expect(ruleDialog(page)).toHaveCount(0);
    await pressed('Trust');
    await expect(page.getByRole('main').getByRole('link', { name: 'Mail from ada@example.org: Leave in inbox' })).toBeVisible();

    await standing(page, 'Ada Lovelace', 'Block').click();
    const blocked = toast(page, 'Mail from ada@example.org: send it to spam');
    await expect(blocked).toContainText('Rule replaced');
    await expect(blocked.getByRole('button', { name: 'Apply to inbox…' })).toBeVisible();
    await pressed('Block');
    await blocked.getByRole('button', { name: 'Undo' }).click();
    await pressed('Trust');

    await standing(page, 'Ada Lovelace', 'Trust').click();
    await pressed(null);
    await seededRulesOnly(page);
    await expect(row(page, 'ada@example.org')).toHaveCount(0);
  });

  test('Undo takes back a standing that replaced none', async ({ page }) => {
    await page.goto(senderPage('ada@example.org'));
    await standing(page, 'Ada Lovelace', 'Unwanted').click();
    await expect(standing(page, 'Ada Lovelace', 'Unwanted')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('z');
    await expect(standing(page, 'Ada Lovelace', 'Unwanted')).toHaveAttribute('aria-pressed', 'false');
    await page.goto('/rules');
    await expect(row(page, 'ada@example.org')).toHaveCount(0);
  });

  test('a standing for a sender whose own rule says more opens the dialog, which says what it replaces', async ({ page }) => {
    await page.goto(senderPage('orders@shop.example.com'));
    await standing(page, 'Shop', 'Block').click();
    const dialog = ruleDialog(page);
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await expect(dialog.getByRole('group', { name: 'Replaces' })).toContainText('Receipts');
    await expect(dialog.getByRole('combobox', { name: 'What happens to it' })).toContainText('Spam');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(standing(page, 'Shop', 'Block')).toHaveAttribute('aria-pressed', 'false');
  });

  test("a sender's page starts a rule on the sender, and one per name it writes under", async ({ page }) => {
    await page.goto(senderPage('notifications@code.example.com'));
    const dialog = ruleDialog(page);
    const words = dialog.getByRole('textbox', { name: 'What should it do?' });
    const main = page.getByRole('main');
    await expect(main.getByRole('button', { name: 'Make a rule…' })).toHaveCount(5);

    await main.getByRole('button', { name: 'Make a rule…' }).first().click();
    await expect(words).toHaveValue('Mail from notifications@code.example.com is Notifications.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    await makeRule(row(page, 'Dependabot'));
    await expect(words).toHaveValue('Mail from notifications@code.example.com named “Dependabot” is Notifications.');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await query(page).toBe('');
    await expect(reader(page)).toHaveCount(0);
  });

  test("a domain's standing that is already a rule shows as pressed, and another replaces it in one press", async ({ page }) => {
    await page.goto(domainPage('promo.example.com'));
    await expect(standing(page, 'promo.example.com', 'Block')).toHaveAttribute('aria-pressed', 'true');

    await standing(page, 'promo.example.com', 'Unwanted').click();
    await expect(toast(page, 'Mail from promo.example.com: archive it')).toContainText('Rule replaced');
    await expect(standing(page, 'promo.example.com', 'Unwanted')).toHaveAttribute('aria-pressed', 'true');
    await expect(standing(page, 'promo.example.com', 'Block')).toHaveAttribute('aria-pressed', 'false');
    await expect(ruleDialog(page)).toHaveCount(0);
  });
});
