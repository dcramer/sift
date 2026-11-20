import {
  PHONE,
  back,
  boxOf,
  composer,
  expect,
  forReviewLink,
  inboxRow,
  openMessage,
  query,
  reader,
  readerHeading,
  row,
  sideScroll,
  test,
  toast,
} from './sift.ts';

test.describe('The reader, from For review', () => {
  test('opens in the list’s place, inside the frame, and Back returns to the list on the row it showed', async ({ page }) => {
    await page.goto('/');
    await openMessage(page, 'Lunch on Thursday?');
    await expect(page.getByRole('heading', { name: 'For review', level: 1 })).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await expect(reader(page).getByText('2 of 12')).toBeVisible();

    await back(page).click();
    await expect(reader(page)).toHaveCount(0);
    await query(page).toBe('');
    await expect(row(page, 'Lunch on Thursday?')).toBeFocused();
  });

  test('says what Sift saw, the sender, and the history beside the message', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Winter sale starts now');
    await expect(open.getByRole('complementary')).toContainText('What Sift saw');
    await expect(open.getByRole('complementary')).toContainText('Sender');
    await expect(open.getByRole('complementary').getByText(/^History · \d+$/)).toBeVisible();
    // Why is open from the start: answering is the job here.
    await expect(open.getByRole('button', { name: 'Why' })).toHaveAttribute('aria-expanded', 'true');
    await expect(open.getByText('Marketing: synthetic: a sale sent to a list').first()).toBeVisible();
    // The message and the column sit side by side.
    const message = await boxOf(open.getByText('Up to half off.'));
    const column = await boxOf(open.getByRole('complementary'));
    expect(column.x).toBeGreaterThan(message.x + message.width);
  });

  test('agreeing is one press, and moves on to the next message', async ({ page }) => {
    await page.goto('/');
    const open = await openMessage(page, 'Winter sale starts now');
    await open.getByRole('button', { name: 'Agree: Marketing' }).click();
    await expect(toast(page, 'Archive as Marketing')).toBeVisible();
    await expect(readerHeading(page, 'Disk 91% full on db-2')).toBeVisible();
    await expect(forReviewLink(page)).toHaveAccessibleName('For review 11');

    await page.keyboard.press('Escape');
    await expect(reader(page)).toHaveCount(0);
    await expect(row(page, 'Winter sale starts now')).toHaveCount(0);
    await expect(row(page, 'Disk 91% full on db-2')).toBeFocused();
  });
});

test.describe('The reader, from Inbox', () => {
  test.use({ variant: 'inbox' });

  test('J and K step through the conversations, with where it is, and Escape returns to the row last shown', async ({ page }) => {
    await page.goto('/inbox');
    await inboxRow(page, 'This week in widgets').getByRole('cell').nth(2).click();
    const open = reader(page);
    await expect(readerHeading(page, 'This week in widgets')).toBeVisible();
    await expect(open.getByText('1 of 19')).toBeVisible();
    await expect(open.getByRole('button', { name: 'Previous' })).toBeDisabled();
    // Inbox reads mail: nothing beside it.
    await expect(open.getByRole('complementary')).toHaveCount(0);

    await page.keyboard.press('j');
    await expect(readerHeading(page, 'Widgets, part two')).toBeVisible();
    await expect(open.getByText('2 of 19')).toBeVisible();
    await page.keyboard.press('j');
    await expect(readerHeading(page, 'Your order has shipped')).toBeVisible();
    await page.keyboard.press('k');
    await expect(readerHeading(page, 'Widgets, part two')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(open).toHaveCount(0);
    await query(page).toBe('');
    await expect(inboxRow(page, 'Widgets, part two')).toBeFocused();
  });

  test('a conversation reads down the page: its unread start open, a folded one opens beside them, and a press on an open one’s head folds it', async ({
    page,
  }) => {
    await page.goto('/inbox');
    await inboxRow(page, 'Your March bill').getByRole('cell').nth(2).click();
    const open = reader(page);
    const opened = open.getByRole('article');
    const folded = open.getByRole('row', { name: /^Utility/ });
    await expect(opened).toHaveCount(3);
    await expect(opened.getByText('Your bill is ready.', { exact: true })).toHaveCount(3);

    await opened.first().getByRole('button', { name: 'Fold the message from Utility' }).click();
    await expect(opened).toHaveCount(2);
    await expect(folded).toHaveCount(1);
    await opened.first().getByRole('button', { name: 'Fold the message from Utility' }).click();
    await expect(opened).toHaveCount(1);
    await folded.first().click();
    await expect(opened).toHaveCount(2);
    await expect(folded).toHaveCount(1);

    // Read now, it opens again on its newest alone.
    await page.keyboard.press('Escape');
    await inboxRow(page, 'Your March bill').getByRole('cell').nth(2).click();
    await expect(opened).toHaveCount(1);
    await expect(folded).toHaveCount(2);
    expect((await boxOf(folded.last())).y).toBeLessThan((await boxOf(opened)).y);
  });

  test('the sender’s name over the message goes to their page', async ({ page }) => {
    await page.goto('/inbox');
    await inboxRow(page, 'Lunch on Thursday?').getByRole('cell').nth(2).click();
    await reader(page).getByRole('link', { name: 'Ada Lovelace', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Ada Lovelace', level: 1 })).toBeVisible();
    await expect(reader(page)).toHaveCount(0);
  });

  test.describe('on a phone', () => {
    test.use({ viewport: PHONE });

    test('reads top to bottom: the title, Sift’s row, the conversation, the replies; nothing wraps or scrolls sideways', async ({ page }) => {
      await page.goto('/inbox');
      await page.getByRole('row').filter({ hasText: 'Your March bill' }).click();
      const open = reader(page);
      // An open message's text arrives after the conversation, and is shorter than the rows standing in for it. The
      // reader is found by Sift's row, which comes with the conversation: before that, no rows are found because no reader is.
      await expect(readerHeading(page, 'Your March bill')).toBeVisible();
      await expect(open.getByLabel('Loading')).toHaveCount(0);
      const title = await boxOf(readerHeading(page, 'Your March bill'));
      const answer = await boxOf(open.getByRole('combobox', { name: 'What this message is' }));
      const first = await boxOf(open.getByRole('article').first());
      const reply = await boxOf(open.getByRole('button', { name: 'Reply', exact: true }));
      expect(title.y).toBeLessThan(answer.y);
      expect(answer.y).toBeLessThan(first.y);
      expect(first.y).toBeLessThan(reply.y);

      // Sift's row, the bar's presses and each message's head each keep to one line.
      const rule = await boxOf(open.getByRole('button', { name: 'Make a rule…' }));
      expect(rule.y + rule.height / 2).toBeCloseTo(answer.y + answer.height / 2, 0);
      const archive = await boxOf(open.getByRole('button', { name: 'Archive', exact: true }));
      const next = await boxOf(open.getByRole('button', { name: 'Next' }));
      expect(next.y + next.height / 2).toBeCloseTo(archive.y + archive.height / 2, 0);
      const head = open.getByRole('article').first();
      const sender = await boxOf(head.getByRole('link', { name: 'Utility', exact: true }));
      const more = await boxOf(head.getByRole('button', { name: 'Reply all or forward' }));
      expect(more.y + more.height / 2).toBeCloseTo(sender.y + sender.height / 2, 0);
      const forward = await boxOf(open.getByRole('button', { name: 'Forward', exact: true }));
      expect(forward.y).toBe(reply.y);
      await sideScroll(page).toBe(0);

      // Answering an earlier message, the box at the foot still fits the screen.
      await head.getByRole('button', { name: 'Reply to Utility' }).click();
      await expect(composer(page, 'Reply').getByText(/^Replying to Utility, /)).toBeVisible();
      await sideScroll(page).toBe(0);
    });
  });
});

test.describe('The reader, from For review on a phone', () => {
  test.use({ viewport: PHONE });

  test('puts what Sift saw and the sender under the message, and nothing scrolls sideways', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('row').filter({ hasText: 'Winter sale starts now' }).click();
    const open = reader(page);
    const message = await boxOf(open.getByText('Up to half off.'));
    const column = await boxOf(open.getByRole('complementary'));
    expect(column.y).toBeGreaterThan(message.y);
    await sideScroll(page).toBe(0);
  });
});

test.describe('A long conversation', () => {
  // The seed has none that long; the specimen's has seven messages. Its mail frame, below it, runs nothing, and says so.
  test.use({ allow: ["Blocked script execution in 'about:blank'"] });

  test('folds its middle into one row, which opens all of it', async ({ page }) => {
    await page.goto('/system');
    await page.getByRole('button', { name: 'Open a message' }).click();
    const conversation = page.getByRole('region', { name: 'Lunch on Thursday?' });
    await expect(conversation.getByRole('row', { name: /^(Ada|me|Grace)/ })).toHaveCount(2);
    await conversation.getByRole('row', { name: '4 more' }).click();
    await expect(conversation.getByRole('row', { name: /^(Ada|me|Grace)/ })).toHaveCount(6);
    await expect(conversation.getByRole('article')).toHaveCount(1);
  });
});
