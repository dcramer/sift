import type { Locator, Page } from '@playwright/test';
import { fact, ruleDialog, rulePanel, standing } from './rule.ts';
import {
  boxOf,
  domainPage,
  expect,
  messageQuery,
  openMessage,
  back,
  reader,
  readerHeading,
  param,
  patchJson,
  path,
  PHONE,
  query,
  row,
  section,
  senderPage,
  sideScroll,
  test,
  toast,
} from './sift.ts';

const SENDER = senderPage('notifications@code.example.com');
const DOMAIN = domainPage('code.example.com');

/** The rows of the page's lists, or of one table, that hold mail: not the headers or the day headings between them. */
const rows = (page: Page, within: Page | Locator = page) => within.getByRole('row').filter({ has: page.getByRole('cell') });

test.describe('Activity, after a pass with Sift on', () => {
  test.use({ variant: 'on' });

  test('mail Sift could not place says it asked you, and an undone change is struck through', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.getByRole('radio', { name: 'Changed' })).toBeChecked();
    await expect(row(page, 'Quick question')).toContainText('Asked you');
    await expect(row(page, 'Quick question')).not.toContainText('Unlabelled');
    await expect(row(page, 'Last day of the sale').getByText('Archived', { exact: true }).filter({ visible: true })).toHaveCSS(
      'text-decoration-line',
      'line-through',
    );
  });

  test('says the time Sift saved and which labels it came from, each narrowing the list to its label', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.getByText('Time saved', { exact: true })).toBeVisible();
    await expect(page.getByText('1 kept out of your inbox', { exact: true })).toBeVisible();
    await expect(fact(page.getByRole('main'), 'Unsubscribed')).toHaveText('0');
    await page.getByRole('term').getByRole('link', { name: 'Newsletters' }).click();
    await param(page, 'label').toBe('newsletter');
    await expect(row(page, 'Widgets, part three')).toBeVisible();
    await expect(row(page, 'Quick question')).toHaveCount(0);
  });

  test('a sender’s page and a rule’s panel say what Sift kept out of the inbox', async ({ page }) => {
    await page.goto(senderPage('digest@news.example.com'));
    await expect(page.getByText('1 kept out of your inbox, about 10 s', { exact: true })).toBeVisible();
    await page.goto('/rules');
    await page.getByRole('cell', { name: 'anyone at news.example.com' }).click();
    await expect(fact(rulePanel(page, 'anyone at news.example.com'), 'Saved, 30 days')).toHaveText('10 s');
  });
});

test.describe('Activity', () => {
  test('lists nothing changed while Sift is off, and every decision under Everything', async ({ page }) => {
    await page.goto('/activity');
    await expect(page.getByRole('radio', { name: 'Changed' })).toBeChecked();
    await expect(page.getByText('Sift has changed nothing in Gmail in this period.')).toBeVisible();
    await expect(page.getByText('Time saved', { exact: true })).toHaveCount(0);

    await page.getByRole('radio', { name: 'Everything' }).click();
    await param(page, 'show').toBe('all');
    await expect(rows(page)).toHaveCount(21);
    await expect(page.getByRole('columnheader', { name: 'Today' })).toBeVisible();
    await expect(row(page, 'Winter sale starts now')).toContainText('Would archive');
    await expect(row(page, 'Winter sale starts now')).toContainText('Marketing');
    await expect(row(page, 'Lunch on Thursday?')).toContainText('Would ask you');
  });

  test('search narrows by subject and by sender, and is kept in the address', async ({ page }) => {
    await page.goto('/activity?show=all');
    await expect(rows(page)).toHaveCount(21);
    const search = page.getByRole('searchbox', { name: 'Search subject or sender' });
    await search.fill('widgets');
    await expect(rows(page)).toHaveCount(2);
    await param(page, 'q').toBe('widgets');

    await search.fill('ops.example.com');
    await expect(rows(page)).toHaveCount(2);
    await expect(row(page, 'Replica lag on db-3')).toBeVisible();

    await search.fill('nothing like this');
    await expect(page.getByText('Nothing matches.')).toBeVisible();

    await page.reload();
    await expect(search).toHaveValue('nothing like this');
    await expect(page.getByText('Nothing matches.')).toBeVisible();
  });

  test('the period is kept in the address', async ({ page }) => {
    await page.goto('/activity?show=all');
    await page.getByRole('combobox', { name: 'Period' }).click();
    await page.getByRole('option', { name: 'Last 30 days' }).click();
    await expect(page.getByRole('combobox', { name: 'Period' })).toContainText('Last 30 days');
    await param(page, 'days').toBe('30');
    await expect(rows(page)).toHaveCount(21);

    await page.getByRole('combobox', { name: 'Period' }).click();
    await page.getByRole('option', { name: 'Last 7 days' }).click();
    await param(page, 'days').toBeNull();
  });

  test('narrowed to mail with a one-click unsubscribe, only the three lists are left', async ({ page }) => {
    await page.goto('/activity?show=all');
    await page.getByRole('button', { name: 'Filters' }).click();
    await page.getByRole('radio', { name: 'Has a one-click unsubscribe' }).click();
    await expect(rows(page)).toHaveCount(4);
    for (const subject of ['This week in widgets', 'Widgets, part two', '48 hours only: 30% off', 'Winter sale starts now'])
      await expect(row(page, subject)).toBeVisible();
    await param(page, 'fact').toBe('one-click');
  });

  test('a row opens its message, Next steps down the list, and Close returns to the list as it was', async ({ page }) => {
    await page.goto('/activity?show=all');
    const open = await openMessage(page, 'Winter sale starts now');
    await param(page, 'message').toBe('m8');
    await param(page, 'show').toBe('all');
    await expect(open).toContainText('of 21');

    await open.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();
    await param(page, 'message').toBe('m7');

    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/activity\?show=all$/);
    await expect(rows(page)).toHaveCount(21);
  });

  test('Back closes a message opened from the list', async ({ page }) => {
    await page.goto('/activity?show=all');
    await openMessage(page, 'Lunch on Thursday?');
    await page.goBack();
    await expect(reader(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/activity\?show=all$/);
  });

  test('a message opened by its address on Activity closes to Activity alone', async ({ page }) => {
    await page.goto(`/activity?${messageQuery('m6')}`);
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await path(page).toBe('/activity');
    await query(page).toBe('');
    await expect(page.getByRole('heading', { name: 'Activity', level: 1 })).toBeVisible();
  });

  test('the page of a long list is in the address, and narrowing the list goes back to its first', async ({ page }) => {
    // The seed has 21 decisions, under one page; the server says there are more.
    await patchJson(page, '**/api/decisions?**', (decisions) => ({ ...decisions, total: 120 }));
    await page.goto('/activity?show=all');
    await expect(page.getByText('1–50 of 120')).toBeVisible();
    await page.getByRole('button', { name: 'Older' }).click();
    await expect(page.getByText('51–100 of 120')).toBeVisible();
    await param(page, 'page').toBe('2');

    await page.reload();
    await expect(page.getByText('51–100 of 120')).toBeVisible();

    await page.getByRole('radio', { name: 'Changed' }).click();
    await expect(page.getByText('1–50 of 120')).toBeVisible();
    await param(page, 'page').toBeNull();
  });
});

test.describe('A sender', () => {
  test('with several names lists each, with what its mail is, and no standing', async ({ page }) => {
    await page.goto(SENDER);
    await expect(page.getByRole('heading', { name: 'notifications@code.example.com', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Answer 8 waiting' })).toBeVisible();

    const names = section(page, 'Names');
    await expect(rows(page).filter({ has: page.getByRole('button', { name: 'Make a rule…' }) })).toHaveCount(4);
    await expect(names.getByRole('row', { name: /^Dependabot 3 · 38%/ })).toContainText('Notifications');
    await expect(names.getByRole('row', { name: /^Security alerts 2 · 25%/ })).toContainText('Account alerts');
    await expect(names.getByRole('row', { name: /^github-actions\[bot\] 2 · 25%/ })).toContainText('Notifications');
    await expect(names.getByRole('row', { name: /^Ada Lovelace 1 · 13%/ })).toContainText('Unlabelled');

    for (const name of ['Trust', 'Unwanted', 'Block'])
      await expect(standing(page, 'notifications@code.example.com', name)).toHaveAttribute('aria-pressed', 'false');
  });

  test('From narrows their mail to one name, and is kept in the address', async ({ page }) => {
    await page.goto(SENDER);
    const mail = rows(page, section(page, 'Their mail'));
    await expect(mail).toHaveCount(8);
    await page.getByRole('combobox', { name: 'From' }).click();
    await page.getByRole('option', { name: 'Dependabot' }).click();
    await expect(mail).toHaveCount(3);
    await param(page, 'name').toBe('Dependabot');
  });

  test('a toast is a slip in the bottom right corner: its words, then its presses under them', async ({ page }) => {
    await page.goto(SENDER);
    await standing(page, 'notifications@code.example.com', 'Block').click();
    const said = toast(page, 'Mail from notifications@code.example.com: send it to spam');
    // On the page before it is measured: it slides up as it comes, and a slow answer to the press leaves nothing moving yet to wait for.
    await expect(said).toBeVisible();
    const box = await boxOf(said);
    const words = await boxOf(said.getByText('Mail from notifications@code.example.com: send it to spam', { exact: true }));
    const undo = await boxOf(said.getByRole('button', { name: 'Undo' }));
    const { width, height } = page.viewportSize()!;
    expect(undo.y).toBeGreaterThanOrEqual(words.y + words.height);
    expect(box.x + box.width).toBeGreaterThan(width - 40);
    expect(height - (box.y + box.height)).toBeLessThanOrEqual(32);
  });

  test('Unwanted is on in one press, with the rule said in its toast and nothing opened over their page', async ({ page }) => {
    await page.goto(SENDER);
    await standing(page, 'notifications@code.example.com', 'Unwanted').click();
    await expect(toast(page, 'Mail from notifications@code.example.com: archive it')).toContainText('Rule added');
    await expect(standing(page, 'notifications@code.example.com', 'Unwanted')).toHaveAttribute('aria-pressed', 'true');
    await expect(standing(page, 'notifications@code.example.com', 'Trust')).toHaveAttribute('aria-pressed', 'false');
    await expect(ruleDialog(page)).toHaveCount(0);
    await query(page).toBe('');
  });

  test('a message opened from their mail closes back to their page', async ({ page }) => {
    await page.goto(SENDER);
    await openMessage(page, 'Bump zod from 4.0.0 to 4.0.2');
    await param(page, 'message').not.toBeNull();

    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await path(page).toBe(SENDER);
    await query(page).toBe('');
  });

  test('Answer 8 waiting steps through what waits on the reader', async ({ page }) => {
    await page.goto(SENDER);
    await page.getByRole('button', { name: 'Answer 8 waiting' }).click();
    await expect(reader(page)).toContainText('1 of 8');
    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
  });

  test('their domain is a link to the domain page', async ({ page }) => {
    await page.goto(SENDER);
    await page.getByRole('link', { name: 'code.example.com' }).click();
    await expect(page.getByRole('heading', { name: 'code.example.com', level: 1 })).toBeVisible();
    await path(page).toBe(DOMAIN);
  });

  test('All their mail, in a message opened from For review, goes to the sender, and Back returns to the message', async ({ page }) => {
    await page.goto('/');
    await (await openMessage(page, 'Lunch on Thursday?')).getByRole('link', { name: 'All their mail' }).click();
    await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
    await path(page).toBe(senderPage('ada@example.org'));
    await query(page).toBe('');

    await page.goBack();
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await path(page).toBe('/');
    await query(page).toBe('');
  });
});

test.describe('Who sent it is a link wherever it is named', () => {
  test("a name goes to the sender's mail under that name, and the address under it to all of it", async ({ page }) => {
    await page.goto('/');
    const sent = page.getByRole('row').filter({ hasText: 'Re: Fix the release script' });
    await sent.getByRole('link', { name: 'Ada Lovelace' }).click();
    await expect(page.getByRole('heading', { name: 'notifications@code.example.com', level: 1 })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'From' })).toContainText('Ada Lovelace');
    await expect(rows(page, section(page, 'Their mail'))).toHaveCount(1);
    await expect(reader(page)).toHaveCount(0);

    await page.goBack();
    await sent.getByRole('link', { name: 'notifications@code.example.com' }).click();
    await expect(page.getByRole('combobox', { name: 'From' })).toContainText('Every name');
    await path(page).toBe(SENDER);
  });

  test("a name on its sender's page narrows their mail to it", async ({ page }) => {
    await page.goto(SENDER);
    await section(page, 'Names').getByRole('link', { name: 'Dependabot' }).click();
    await expect(page.getByRole('combobox', { name: 'From' })).toContainText('Dependabot');
    await param(page, 'name').toBe('Dependabot');
  });

  test('a name an address writes under alone does not narrow its page', async ({ page }) => {
    await page.goto(`${senderPage('ada@example.org')}?name=Someone`);
    await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Lunch on Thursday?' })).toBeVisible();
  });

  test("the address in a message's header goes to the sender", async ({ page }) => {
    await page.goto(`/?${messageQuery('m6')}`);
    await reader(page).getByRole('link', { name: 'ada@example.org' }).click();
    await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
  });

  test("a rule's domain goes to the domain and its address to the sender, not to the rule", async ({ page }) => {
    await page.goto('/rules');
    await page.getByRole('link', { name: 'news.example.com' }).click();
    await expect(page.getByRole('heading', { name: 'news.example.com', level: 1 })).toBeVisible();
    await param(page, 'rule').toBeNull();

    await page.goBack();
    await page.getByRole('link', { name: 'orders@shop.example.com' }).click();
    await expect(page.getByRole('heading', { name: 'Shop', level: 1 })).toBeVisible();
    await param(page, 'rule').toBeNull();
  });

  test('the sender in a rule For review offers goes to the sender', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('listitem').filter({ hasText: 'Make a rule…' }).getByRole('link', { name: 'billing@utility.example.net' }).click();
    await path(page).toBe(senderPage('billing@utility.example.net'));
  });
});

test.describe('A domain', () => {
  test('shows what its mail is, the people there, and their mail', async ({ page }) => {
    await page.goto(DOMAIN);
    await expect(page.getByRole('heading', { name: 'code.example.com', level: 1 })).toBeVisible();
    await expect(page.getByRole('row', { name: /^Notifications 5 · 71%/ })).toBeVisible();
    await expect(page.getByRole('row', { name: /^Account alerts 2 · 29%/ })).toBeVisible();
    await expect(
      section(page, 'People here')
        .getByRole('row')
        .filter({ has: page.getByRole('link', { name: 'Dependabot' }) }),
    ).toContainText('notifications@code.example.com');
    await expect(rows(page, section(page, 'Their mail'))).toHaveCount(8);
    for (const name of ['Trust', 'Unwanted', 'Block']) await expect(standing(page, 'code.example.com', name)).toHaveAttribute('aria-pressed', 'false');
  });

  test('Block is on for everyone at the domain in one press', async ({ page }) => {
    await page.goto(DOMAIN);
    await standing(page, 'code.example.com', 'Block').click();
    await expect(toast(page, 'Mail from code.example.com: send it to spam')).toContainText('Rule added');
    await expect(standing(page, 'code.example.com', 'Block')).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('On a phone', () => {
  test.use({ viewport: PHONE });

  test("a rule's toast is one line: Rule added, then the rule, cut short before Undo", async ({ page }) => {
    await page.goto(SENDER);
    await standing(page, 'notifications@code.example.com', 'Block').click();
    const said = toast(page, 'Mail from notifications@code.example.com: send it to spam');
    const kind = await boxOf(said.getByText('Rule added', { exact: true }));
    const rule = await boxOf(said.getByText('Mail from notifications@code.example.com: send it to spam', { exact: true }));
    const undo = await boxOf(said.getByRole('button', { name: /^Undo/ }));
    expect(kind.x + kind.width).toBeLessThan(rule.x);
    expect(rule.x + rule.width).toBeLessThanOrEqual(undo.x);
    // One line: each is beside the other, not under it.
    expect(kind.y).toBeLessThan(rule.y + rule.height);
    expect(rule.y).toBeLessThan(kind.y + kind.height);
  });

  test('a For review row opens its message in the list’s place, the width of the screen in its gutters, and Back returns to the list', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('row').filter({ hasText: 'Lunch on Thursday?' }).click();
    const open = reader(page);
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    const box = await boxOf(open);
    expect(box.x).toBe(16);
    expect(box.width).toBe(PHONE.width - 32);
    await sideScroll(page).toBe(0);

    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
  });

  test('the sender in a For review row goes to the sender, not the message', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('row').filter({ hasText: 'Winter sale starts now' }).getByRole('link', { name: 'Store' }).click();
    await expect(page.getByRole('heading', { name: 'Store', level: 1 })).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
    await path(page).toBe(senderPage('sale@store.example.com'));
    await param(page, 'message').toBeNull();
  });

  test('a sender page fits the screen', async ({ page }) => {
    await page.goto(SENDER);
    await expect(page.getByRole('heading', { name: 'Names' })).toBeVisible();
    await sideScroll(page).toBe(0);
  });
});
