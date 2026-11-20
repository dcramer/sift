import type { Page } from '@playwright/test';
import { standing } from './rule.ts';
import { PHONE, boxOf, composer, domainPage, expect, reader, param, path, row, section, senderPage, sideScroll, test, toast } from './sift.ts';

/** The directory's rows, not its column heads. */
const contacts = (page: Page) =>
  page
    .getByRole('main')
    .getByRole('row')
    .filter({ has: page.getByRole('cell') });
const contact = (page: Page, name: string) => contacts(page).filter({ has: page.getByRole('link', { name, exact: true }) });
const sections = (page: Page) => page.getByRole('navigation', { name: 'Sections' }).first();
const filter = async (page: Page, choice: string) => {
  await page.getByRole('button', { name: /^Filters/ }).click();
  await page.getByRole('radio', { name: choice, exact: true }).click();
};

test.describe('Contacts', () => {
  test('lists everyone who writes, newest first, with what Sift does with their next mail, the reader’s answers counted', async ({ page }) => {
    await page.goto('/contacts');
    await expect(page.getByRole('heading', { name: 'Contacts', level: 1 })).toBeVisible();
    await expect(sections(page).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page');
    await expect(contacts(page)).toHaveCount(10);
    await expect(contacts(page).first()).toContainText('Weekly Digest');
    await expect(contact(page, 'Weekly Digest')).toContainText('Archive as Newsletters');
    await expect(contact(page, 'Weekly Digest')).toContainText('1 rule');
    // Answered as Receipts and kept: that, and not Sift's own Unlabelled.
    await expect(contact(page, 'Utility')).toContainText('Keep as Receipts');
    await expect(contact(page, 'Dependabot')).toContainText('Usually Archive as Notifications');
    // Mail the person wrote is theirs, not a contact's.
    await expect(contacts(page).filter({ hasText: 'me@example.org' })).toHaveCount(0);
  });

  test('search narrows by name or address, and is kept in the address', async ({ page }) => {
    await page.goto('/contacts');
    const search = page.getByRole('searchbox', { name: 'Search contacts' });
    await search.fill('lovelace');
    await expect(contacts(page)).toHaveCount(1);
    await expect(contact(page, 'Ada Lovelace')).toBeVisible();
    await param(page, 'q').toBe('lovelace');

    await search.fill('example.net');
    await expect(contacts(page)).toHaveCount(2);
    await expect(contact(page, 'Grace Hopper')).toBeVisible();
    await expect(contact(page, 'Utility')).toBeVisible();

    await search.fill('nobody like this');
    await expect(page.getByText('Nothing matches.')).toBeVisible();
    await page.reload();
    await expect(search).toHaveValue('nobody like this');
  });

  test('filters by how they know each other and by standing, each a chip that clears it', async ({ page }) => {
    await page.goto('/contacts');
    await filter(page, 'You write to them');
    await expect(contacts(page)).toHaveCount(1);
    await expect(contact(page, 'Ada Lovelace')).toBeVisible();
    await param(page, 'know').toBe('mutual');
    await page.getByRole('radio', { name: 'Never written back', exact: true }).click();
    await expect(contact(page, 'Dependabot')).toBeVisible();
    await expect(contacts(page)).toHaveCount(1);

    await page.getByRole('radio', { name: 'Anyone', exact: true }).click();
    await page.getByRole('radio', { name: 'Blocked', exact: true }).click();
    await expect(page.getByText('Nothing matches.')).toBeVisible();
    await param(page, 'standing').toBe('blocked');
    await page.getByRole('button', { name: /^Filters/ }).click();
    await page.getByRole('button', { name: 'Clear Blocked' }).click();
    await expect(contacts(page)).toHaveCount(10);
    await param(page, 'standing').toBeNull();
  });

  test('a row opens their page, under Contacts, which leads back to the list; a standing given there shows in it', async ({ page }) => {
    await page.goto('/contacts');
    await contact(page, 'Ada Lovelace').getByRole('cell').nth(1).click();
    await path(page).toBe(senderPage('ada@example.org'));
    await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
    await expect(sections(page).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page');
    // How they know each other is said once, under their name.
    await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 }).locator('xpath=ancestor::header[1]')).toContainText('You have written to them');
    await expect(page.getByRole('main').getByRole('term').filter({ hasText: 'You wrote' })).toHaveCount(0);

    await standing(page, 'Ada Lovelace', 'Block').click();
    await expect(toast(page, 'Mail from ada@example.org: send it to spam')).toContainText('Rule added');
    await page.getByRole('main').getByRole('link', { name: 'Contacts' }).click();
    await path(page).toBe('/contacts');
    await expect(contact(page, 'Ada Lovelace')).toContainText('Blocked');
    await expect(contact(page, 'Ada Lovelace')).toContainText('Spam');
    await filter(page, 'Blocked');
    await expect(contacts(page)).toHaveCount(1);
  });

  test("a domain's page lists the people there, each opening their own", async ({ page }) => {
    await page.goto(domainPage('code.example.com'));
    await expect(sections(page).getByRole('link', { name: 'Contacts' })).toHaveAttribute('aria-current', 'page');
    const people = section(page, 'People here');
    await expect(people.getByRole('row').filter({ has: page.getByRole('cell') })).toHaveCount(1);
    await people.getByRole('row').filter({ hasText: 'Dependabot' }).getByRole('cell').nth(1).click();
    await path(page).toBe(senderPage('notifications@code.example.com'));
  });

  test('Answer N waiting steps through their mail waiting on the reader; Write to them is only for Inbox', async ({ page }) => {
    await page.goto(senderPage('ada@example.org'));
    await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Write to them' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Answer 1 waiting' }).click();
    await expect(reader(page)).toContainText('Lunch on Thursday?');
  });

  test.describe('with Inbox on', () => {
    test.use({ variant: 'inbox' });

    test('Write to them opens a new message to them, and Back closes it', async ({ page }) => {
      await page.goto(senderPage('ada@example.org'));
      await page.getByRole('button', { name: 'Write to them' }).click();
      const writing = composer(page, 'New message');
      await expect(writing.getByRole('textbox', { name: 'To' })).toHaveValue('ada@example.org');
      await expect(writing.getByRole('textbox', { name: 'Message' })).toBeFocused();
      await param(page, 'to').toBe('ada@example.org');
      await page.goBack();
      await expect(writing).toHaveCount(0);
      await path(page).toBe(senderPage('ada@example.org'));
    });
  });

  test.describe('On a phone', () => {
    test.use({ viewport: PHONE });

    test('a contact is their name, address and what Sift does, and the list fits the screen', async ({ page }) => {
      await page.goto('/contacts');
      const ada = contact(page, 'Ada Lovelace');
      await expect(ada).toContainText('ada@example.org');
      await expect(ada).toContainText('Unlabelled');
      await expect(page.getByRole('columnheader', { name: 'Standing' })).toBeHidden();
      await sideScroll(page).toBe(0);
      const name = await boxOf(ada.getByRole('link', { name: 'Ada Lovelace' }));
      const address = await boxOf(ada.getByText('ada@example.org').filter({ visible: true }));
      expect(address.y).toBeGreaterThan(name.y);

      await ada.getByText('ada@example.org').filter({ visible: true }).click();
      await path(page).toBe(senderPage('ada@example.org'));
    });

    test("a contact's page is one column: what Sift does with their mail, then their mail", async ({ page }) => {
      await page.goto(senderPage('ada@example.org'));
      const next = await boxOf(page.getByText('Their next mail', { exact: true }));
      const mail = await boxOf(page.getByRole('heading', { name: 'Their mail' }));
      expect(mail.y).toBeGreaterThan(next.y);
      expect(Math.abs(mail.x - next.x)).toBeLessThan(2);
      await sideScroll(page).toBe(0);
      await expect(row(page, 'Lunch on Thursday?')).toBeVisible();
    });
  });
});
