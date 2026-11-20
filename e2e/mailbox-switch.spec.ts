import { PHONE, WORK, expect, mailboxSwitch, mailboxesAsked, reviewRows, switchMailbox, test } from './sift.ts';

const NOTHING_WAITING = 'Nothing is waiting on you.';

test('one mailbox chosen in the rail narrows For review to it, names it beside the title, and outlasts a reload', async ({ page }) => {
  const asked = mailboxesAsked(page, '/api/suggestions');
  await page.goto('/');
  await expect(reviewRows(page).first()).toBeVisible();
  await expect(mailboxSwitch(page)).toHaveAccessibleName('Mailbox, All mailboxes');

  await switchMailbox(page, WORK);
  await expect(page.getByText(NOTHING_WAITING)).toBeVisible();
  await expect(reviewRows(page)).toHaveCount(0);
  await expect(page.getByRole('main').getByText(WORK, { exact: true })).toBeVisible();
  expect(asked.at(-1)).toBe(WORK);

  await page.reload();
  await expect(page.getByText(NOTHING_WAITING)).toBeVisible();
  await expect(page.getByRole('main').getByText(WORK, { exact: true })).toBeVisible();
  await expect(mailboxSwitch(page)).toHaveAccessibleName(`Mailbox, ${WORK}`);

  await switchMailbox(page, 'All mailboxes');
  await expect(reviewRows(page).first()).toBeVisible();
  await expect(page.getByRole('main').getByText(WORK, { exact: true })).toHaveCount(0);
  expect(asked.at(-1)).toBeNull();
});

test('a mailbox kept in the browser that is no longer theirs shows all of them, and is never asked for', async ({ page }) => {
  await page.addInitScript("localStorage.setItem('sift:mailbox', 'gone@example.org')");
  const asked = mailboxesAsked(page, '/api/suggestions');
  await page.goto('/');
  await expect(reviewRows(page).first()).toBeVisible();
  await expect(mailboxSwitch(page)).toHaveAccessibleName('Mailbox, All mailboxes');
  expect(asked).not.toContain('gone@example.org');
});

test('on a phone the switch is in the menu, under the account, and choosing closes the menu on the narrowed list', async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  // A phone's row has no answer of its own: the panel it opens does.
  await expect(page.getByRole('cell', { name: /Lunch on Thursday\?/ })).toBeVisible();
  await page.getByRole('button', { name: 'Menu' }).click();
  const menu = page.getByRole('dialog', { name: 'Menu' });
  await expect(menu.getByRole('combobox', { name: 'Mailbox, All mailboxes' })).toBeVisible();

  await switchMailbox(page, WORK);
  await expect(menu).toHaveCount(0);
  await expect(page.getByText(NOTHING_WAITING)).toBeVisible();
  await expect(page.getByRole('main').getByText(WORK, { exact: true })).toBeVisible();
});
