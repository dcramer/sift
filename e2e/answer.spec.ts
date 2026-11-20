import type { Page } from '@playwright/test';
import { makeRule, proposal, ruleDialog, seededRulesOnly } from './rule.ts';
import {
  answersSent,
  boxOf,
  choose,
  expect,
  failureToast,
  forReviewLink,
  messageQuery,
  openMessage,
  back,
  reader,
  readerHeading,
  param,
  PHONE,
  putAway,
  query,
  refused,
  reviewRows,
  reviewSearch,
  row,
  test,
  toast,
} from './sift.ts';

test.describe('Answering mail', () => {
  test('agreeing from a row answers it, opens nothing and makes no rule', async ({ page }) => {
    await page.goto('/');
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 12');

    await row(page, 'Winter sale starts now').getByRole('button', { name: 'Agree: Marketing' }).click();
    await expect(toast(page, 'Archive as Marketing')).toBeVisible();
    await expect(row(page, 'Winter sale starts now')).toHaveCount(0);
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 11');
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');

    await seededRulesOnly(page);
    await expect(page.getByRole('main')).not.toContainText('sale@store.example.com');
  });

  test('picking another label answers it', async ({ page }) => {
    await page.goto('/');
    const store = row(page, 'Winter sale starts now');
    await choose(store, 'Notifications');
    await expect(toast(page, 'Archive as Notifications')).toBeVisible();
    await expect(store).toHaveCount(0);
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 11');
    await expect(reader(page)).toHaveCount(0);
  });

  test('picking Sift’s own label from the list answers it too', async ({ page }) => {
    await page.goto('/');
    await choose(row(page, 'Winter sale starts now'), 'Marketing');
    await expect(toast(page, 'Archive as Marketing')).toBeVisible();
    await expect(row(page, 'Winter sale starts now')).toHaveCount(0);
  });

  test('a folded row is answered as all of its messages', async ({ page }) => {
    await page.goto('/');
    const dependabot = row(page, '3 messages');
    await expect(dependabot.getByRole('cell', { name: 'Bump lodash from 4.17.20 to 4.17.21' })).toBeVisible();
    await dependabot.getByRole('button', { name: 'Agree: Notifications' }).click();
    await expect(toast(page, 'Archive as Notifications: 3 messages')).toBeVisible();
    await expect(dependabot).toHaveCount(0);
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 9');
    await expect(row(page, '2 messages')).toBeVisible();
  });

  test('answering in the panel saves the label, and the last one closes the panel', async ({ page }) => {
    await page.goto('/?q=Lunch');
    const open = await openMessage(page, 'Lunch on Thursday?');
    await param(page, 'message').toBe('m6');
    await expect(open.getByRole('combobox', { name: 'What this message is' })).toHaveText('Unlabelled');
    await expect(open.getByRole('button', { name: 'Choose what it is' })).toBeDisabled();

    await choose(open, 'Marketing');
    await expect(toast(page, 'Archive as Marketing')).toBeVisible();
    await expect(open).toHaveCount(0);
    await param(page, 'message').toBeNull();
    await expect(page.getByText('Nothing waiting matches.')).toBeVisible();
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 11');
  });

  test('an answer is for one message: the panel moves on to the sender’s other one, still unanswered', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Disk 91% full on db-2');
    await choose(open, 'Notifications');

    const said = toast(page, 'Archive as Notifications');
    await expect(said.getByRole('button', { name: 'Same for 1 more' })).toBeVisible();
    await expect(readerHeading(page, 'Replica lag on db-3')).toBeVisible();
    await expect(open.getByRole('combobox', { name: 'What this message is' })).toHaveText('Unlabelled');

    await back(page).click();
    await expect(open).toHaveCount(0);
    await expect(row(page, 'Replica lag on db-3')).toBeVisible();
    await expect(row(page, 'Disk 91% full on db-2')).toHaveCount(0);
    await seededRulesOnly(page);
  });

  test('“Same for 1 more” in the panel answers the message on show, which then says so', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Disk 91% full on db-2');
    await choose(open, 'Notifications');
    await expect(readerHeading(page, 'Replica lag on db-3')).toBeVisible();

    await toast(page, 'Archive as Notifications').getByRole('button', { name: 'Same for 1 more' }).click();
    await expect(toast(page, 'Archive as Notifications: 1 more')).toBeVisible();
    await expect(readerHeading(page, 'Replica lag on db-3')).toBeVisible();
    await putAway(page);
    await expect(open.getByRole('combobox', { name: 'What this message is' })).toHaveText('Notifications');
  });

  test('“Same for 1 more” leaves the panel where the reader has since stepped to', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Disk 91% full on db-2');
    await choose(open, 'Notifications');
    await expect(readerHeading(page, 'Replica lag on db-3')).toBeVisible();
    await open.getByRole('button', { name: 'Next' }).click();
    await expect(readerHeading(page, 'Bump lodash from 4.17.20 to 4.17.21')).toBeVisible();

    await toast(page, 'Archive as Notifications').getByRole('button', { name: 'Same for 1 more' }).click();
    await expect(toast(page, 'Archive as Notifications: 1 more')).toBeVisible();
    await expect(readerHeading(page, 'Bump lodash from 4.17.20 to 4.17.21')).toBeVisible();
    await param(page, 'message').toBe('m14');
  });

  test('“Same for 1 more” after the panel closed leaves a panel opened since open', async ({ page }) => {
    await page.goto('/?q=db-');
    await choose(await openMessage(page, 'Replica lag on db-3'), 'Notifications');
    await expect(reader(page)).toHaveCount(0);

    await reviewSearch(page).fill('');
    await openMessage(page, 'Notes from the review');
    await toast(page, 'Archive as Notifications').getByRole('button', { name: 'Same for 1 more' }).click();
    await expect(toast(page, 'Archive as Notifications: 1 more')).toBeVisible();
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();
    await param(page, 'message').toBe('m7');
  });

  test('“Same for 1 more” in the panel takes the message off the list behind it', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Disk 91% full on db-2');
    await choose(open, 'Notifications');
    await expect(readerHeading(page, 'Replica lag on db-3')).toBeVisible();
    await toast(page, 'Archive as Notifications').getByRole('button', { name: 'Same for 1 more' }).click();
    await expect(toast(page, 'Archive as Notifications: 1 more')).toBeVisible();

    await back(page).click();
    await expect(open).toHaveCount(0);
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 10');
    await expect(row(page, 'Replica lag on db-3')).toHaveCount(0);
  });

  test('“Same for 1 more” answers the sender’s other waiting message', async ({ page }) => {
    await page.goto('/');
    await choose(row(page, 'Replica lag on db-3'), 'Notifications');
    await toast(page, 'Archive as Notifications').getByRole('button', { name: 'Same for 1 more' }).click();
    await expect(toast(page, 'Archive as Notifications: 1 more')).toBeVisible();
    await expect(row(page, 'Disk 91% full on db-2')).toHaveCount(0);
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 10');
    await expect(reader(page)).toHaveCount(0);
  });
});

test.describe('A rule from For review', () => {
  test('“Make a rule…” in the panel opens the dialog over it, and Escape returns to the panel', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Lunch on Thursday?');
    const dialog = await makeRule(open);
    await expect(dialog.getByRole('textbox', { name: 'What should it do?' })).toHaveValue('Mail from ada@example.org: ');
    await dialog.getByRole('button', { name: 'Write it yourself' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Value 1' })).toHaveValue('ada@example.org');
    await param(page, 'message').toBe('m6');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await param(page, 'message').toBe('m6');

    // The panel has the keys again: the next Escape closes it.
    await page.keyboard.press('Escape');
    await expect(open).toHaveCount(0);
    await query(page).toBe('');
    await expect(row(page, 'Lunch on Thursday?')).toBeVisible();
  });

  test('keys pressed in the rule dialog stay in it, and do not step the panel behind', async ({ page }) => {
    await page.goto('/');
    const dialog = await makeRule(await openMessage(page, 'Notes from the review'));
    await dialog.getByRole('textbox', { name: 'What should it do?' }).pressSequentially(' jk');
    await dialog.getByRole('button', { name: 'Write it yourself' }).focus();
    await page.keyboard.press('j');
    await page.keyboard.press('k');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(readerHeading(page, 'Notes from the review')).toBeVisible();
    await param(page, 'message').toBe('m7');
  });

  test('closing the rule dialog over the panel leaves the panel on the same message', async ({ page }) => {
    await page.goto(`/?${messageQuery('m8')}`);
    await expect(readerHeading(page, 'Winter sale starts now')).toBeVisible();
    await reader(page).getByRole('button', { name: 'Keep as Marketing…' }).click();
    const dialog = ruleDialog(page);
    await expect(dialog.getByRole('textbox', { name: 'What should it do?' })).toHaveValue(
      'Mail from sale@store.example.com, once it is Marketing: leave it in the inbox.',
    );
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(readerHeading(page, 'Winter sale starts now')).toBeVisible();
    await param(page, 'message').toBe('m8');
  });

  test('the proposal’s “Make a rule…” opens only the rule dialog, and closing it keeps the proposal', async ({ page }) => {
    await page.goto('/');
    await expect(proposal(page)).toContainText('You kept the last 3, but the label archives them.');
    const dialog = await makeRule(proposal(page));
    await expect(dialog.getByRole('textbox', { name: 'What should it do?' })).toHaveValue(
      'Mail from billing@utility.example.net, once it is Receipts: leave it in the inbox.',
    );
    await expect(reader(page)).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(proposal(page)).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
  });

  test('dismissing the proposal removes it and makes no rule', async ({ page }) => {
    await page.goto('/');
    await proposal(page).getByRole('button', { name: 'Dismiss' }).click();
    await expect(proposal(page)).toHaveCount(0);

    await page.reload();
    await expect(row(page, 'Winter sale starts now')).toBeVisible();
    await expect(proposal(page)).toHaveCount(0);
    await seededRulesOnly(page);
  });
});

test.describe('An answer on its way', () => {
  // A service worker's page is out of reach of page.route.
  test.use({ serviceWorkers: 'block' });

  type Reply = { status: number; json: object } | undefined;

  /** Holds every answer until the returned function lets them through, or answers them with the reply it is given. */
  const holdAnswers = async (page: Page) => {
    let release: (reply?: Reply) => void = () => {};
    const held = new Promise<Reply>((done) => (release = done));
    await page.route(
      (url) => url.pathname === '/api/feedback',
      async (route) => {
        const reply = await held;
        await (reply ? route.fulfill(reply) : route.continue());
      },
    );
    return release;
  };

  test('is sent only once its toast goes', async ({ page }) => {
    const sent = answersSent(page);
    await page.goto('/');
    await row(page, 'Winter sale starts now').getByRole('button', { name: 'Agree: Marketing' }).click();
    await expect(toast(page, 'Archive as Marketing')).toBeVisible();
    await expect(row(page, 'Winter sale starts now')).toHaveCount(0);
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 11');
    expect(sent()).toBe(0);

    await putAway(page);
    await expect(toast(page, 'Archive as Marketing')).toHaveCount(0);
    await expect.poll(sent).toBe(1);
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 11');
    await page.reload();
    await expect(reviewRows(page).first()).toBeVisible();
    await expect(row(page, 'Winter sale starts now')).toHaveCount(0);
  });

  test('is sent when its toast times out', async ({ page }) => {
    const sent = answersSent(page);
    await page.clock.install();
    await page.goto('/');
    await row(page, 'Winter sale starts now').getByRole('button', { name: 'Agree: Marketing' }).click();
    await expect(toast(page, 'Archive as Marketing')).toBeVisible();
    // The row is low on the screen, where the toast comes up, and a toast pointed at waits.
    await page.mouse.move(0, 0);
    await page.clock.runFor(8000);
    await page.clock.resume();
    await expect(toast(page, 'Archive as Marketing')).toHaveCount(0);
    await expect.poll(sent).toBe(1);
  });

  test('times out while the window has lost focus, as it does to a message being read in its frame', async ({ page }) => {
    const sent = answersSent(page);
    await page.clock.install();
    await page.goto('/');
    await row(page, 'Winter sale starts now').getByRole('button', { name: 'Agree: Marketing' }).click();
    await expect(toast(page, 'Archive as Marketing')).toBeVisible();
    await page.mouse.move(0, 0);
    await page.evaluate("window.dispatchEvent(new FocusEvent('blur'))");
    await page.clock.runFor(8000);
    await page.clock.resume();
    await expect(toast(page, 'Archive as Marketing')).toHaveCount(0);
    await expect.poll(sent).toBe(1);
  });

  test("its toast's close button is level with its words, which take no more height than the presses under them", async ({ page }) => {
    await page.goto('/');
    await row(page, 'Winter sale starts now').getByRole('button', { name: 'Agree: Marketing' }).click();
    const said = toast(page, 'Archive as Marketing');
    await expect(said).toBeVisible();
    const box = await boxOf(said);
    const words = await boxOf(said.getByText('Archive as Marketing', { exact: true }));
    const close = await boxOf(said.getByRole('button', { name: 'Dismiss' }));
    const undo = await boxOf(said.getByRole('button', { name: 'Undo' }));
    expect(Math.abs(close.y + close.height / 2 - (words.y + words.height / 2))).toBeLessThan(2);
    expect(close.y - box.y).toBeCloseTo(box.y + box.height - (undo.y + undo.height), 0);
  });

  test('is sent when its toast is dismissed', async ({ page }) => {
    const sent = answersSent(page);
    await page.goto('/');
    await row(page, 'Winter sale starts now').getByRole('button', { name: 'Agree: Marketing' }).click();
    await toast(page, 'Archive as Marketing').getByRole('button', { name: 'Dismiss' }).click();
    await expect(toast(page, 'Archive as Marketing')).toHaveCount(0);
    await expect.poll(sent).toBe(1);
  });

  for (const [where, viewport] of [
    ['', undefined],
    [', across the bottom of a phone', PHONE],
  ] as const) {
    test(`in the reader, its toast leaves Next pressable${where}`, async ({ page }) => {
      if (viewport) await page.setViewportSize(viewport);
      await page.goto('/');
      await (viewport ? page.getByRole('row').filter({ hasText: 'Winter sale starts now' }).click() : openMessage(page, 'Winter sale starts now'));
      await reader(page).getByRole('button', { name: 'Agree: Marketing' }).click();
      const said = toast(page, 'Archive as Marketing');
      await expect(said).toBeVisible();
      const next = await boxOf(reader(page).getByRole('button', { name: 'Next' }));
      const box = await boxOf(said);
      expect(box.y >= next.y + next.height || box.y + box.height <= next.y).toBe(true);
    });
  }

  test('Undo puts the row back and sends nothing', async ({ page }) => {
    const sent = answersSent(page);
    await page.goto('/');
    await choose(row(page, 'Winter sale starts now'), 'Notifications');
    await toast(page, 'Archive as Notifications').getByRole('button', { name: 'Undo' }).click();
    await expect(toast(page, 'Archive as Notifications')).toHaveCount(0);
    await expect(row(page, 'Winter sale starts now')).toBeVisible();
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 12');

    await putAway(page);
    await page.reload();
    await expect(row(page, 'Winter sale starts now')).toBeVisible();
    expect(sent()).toBe(0);
  });

  test('Z undoes only the latest, and the one before it is sent', async ({ page }) => {
    const sent = answersSent(page);
    await page.goto('/');
    await row(page, 'Winter sale starts now').getByRole('button', { name: 'Agree: Marketing' }).click();
    await choose(row(page, 'Notes from the review'), 'Notifications');
    await expect(toast(page, 'Archive as Notifications')).toBeVisible();
    await expect.poll(sent).toBe(1);

    await page.keyboard.press('z');
    await expect(row(page, 'Notes from the review')).toBeVisible();
    await expect(row(page, 'Winter sale starts now')).toHaveCount(0);
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 11');
    expect(sent()).toBe(1);
  });

  test('a folded row comes back whole on Undo', async ({ page }) => {
    await page.goto('/');
    await row(page, '3 messages').getByRole('button', { name: 'Agree: Notifications' }).click();
    await expect(row(page, '3 messages')).toHaveCount(0);
    await toast(page, 'Archive as Notifications: 3 messages').getByRole('button', { name: 'Undo' }).click();
    await expect(row(page, '3 messages')).toBeVisible();
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 12');
  });

  refused('that fails puts its row back and says why', async ({ page }) => {
    const release = await holdAnswers(page);
    await page.goto('/');
    await row(page, 'Winter sale starts now').getByRole('button', { name: 'Agree: Marketing' }).click();
    await putAway(page);
    await expect(row(page, 'Winter sale starts now')).toHaveCount(0);

    release({ status: 409, json: { error: 'That message has changed.' } });
    const failed = failureToast(page, 'Could not save your answer');
    await expect(failed).toBeVisible();
    await expect(failed).toContainText('That message has changed.');
    await expect(row(page, 'Winter sale starts now')).toBeVisible();
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 12');
  });

  refused('from the panel moves on at once, and a failure puts it back in the list', async ({ page }) => {
    const release = await holdAnswers(page);
    await page.goto('/');
    const open = await openMessage(page, 'Disk 91% full on db-2');
    await choose(open, 'Notifications');
    await expect(readerHeading(page, 'Replica lag on db-3')).toBeVisible();
    await putAway(page);

    release({ status: 409, json: { error: 'That message has changed.' } });
    await expect(failureToast(page, 'Could not save your answer')).toBeVisible();
    await back(page).click();
    await expect(open).toHaveCount(0);
    await expect(row(page, 'Disk 91% full on db-2')).toBeVisible();
  });
});
