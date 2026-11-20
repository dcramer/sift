import type { Page } from '@playwright/test';
import {
  PHONE,
  WORK,
  boxOf,
  composer,
  expect,
  inboxRow,
  readerHeading,
  param,
  readSent,
  reader,
  reviewRows,
  sideScroll,
  switchMailbox,
  test,
  toast,
  toasts,
} from './sift.ts';

const ME = 'me@example.org';
const compose = (page: Page) => page.getByRole('button', { name: /Compose/ });

test.describe('with Inbox on', () => {
  test.use({ variant: 'inbox' });

  test('C writes a new message, each address checked as it is typed, and Ctrl+Enter sends it from the chosen address', async ({ page, sift }) => {
    await page.goto('/');
    // Drawn by the server; its key is bound once the page has loaded.
    await expect(reviewRows(page).first()).toBeVisible();
    // C works with no keycap drawn: the rail is not a list worked through.
    await expect(compose(page)).toHaveAccessibleName('Compose');
    await page.keyboard.press('c');
    const writing = composer(page, 'New message');
    const to = writing.getByRole('textbox', { name: 'To' });
    await expect(to).toBeFocused();
    await expect(writing.getByRole('combobox', { name: 'From' })).toContainText(ME);

    await page.keyboard.type('ada@example.org, nope');
    // Still being typed.
    await expect(writing.getByText('“nope” is not an address.')).toHaveCount(0);
    await writing.getByRole('textbox', { name: 'Subject' }).click();
    await expect(writing.getByText('“nope” is not an address.')).toBeVisible();
    await expect(writing.getByRole('button', { name: /^Send/ })).toBeDisabled();

    await to.fill('Ada <ada@example.org>');
    await writing.getByRole('button', { name: 'Cc', exact: true }).click();
    await expect(writing.getByRole('textbox', { name: 'Cc' })).toBeFocused();
    await page.keyboard.type('grace@example.net');
    await writing.getByRole('combobox', { name: 'From' }).click();
    await page.getByRole('option', { name: 'me+lists@example.org' }).click();
    await writing.getByRole('textbox', { name: 'Subject' }).fill('Lunch');
    await writing.getByRole('textbox', { name: 'Message' }).fill('See you at noon.\nBring the plans.');
    await page.keyboard.press('Control+Enter');

    await expect(toast(page, 'Lunch')).toContainText('Sent');
    await expect(writing).toHaveCount(0);
    await param(page, 'compose').toBeNull();
    const [sent, ...more] = sift.sent();
    expect(more).toEqual([]);
    expect(sent!.mailbox).toBe(ME);
    const { headers, text } = readSent(sent!.raw);
    expect(headers).toMatchObject({ From: 'me+lists@example.org', To: '"Ada" <ada@example.org>', Cc: 'grace@example.net', Subject: 'Lunch' });
    expect(text).toBe('See you at noon.\r\nBring the plans.');

    // Sent, it is not kept as a draft.
    await compose(page).click();
    await expect(composer(page, 'New message').getByRole('textbox', { name: 'To' })).toHaveValue('');
  });

  test.describe('when Sift could not answer', () => {
    test.use({ allow: ['status of 503'] });

    test('Send tried again after a failure goes as the same message, but a draft changed since goes as a new one', async ({ page, sift }) => {
      const ids: string[] = [];
      let fail = 2;
      await page.route('**/api/mail/send', async (route) => {
        ids.push((route.request().postDataJSON() as { id: string }).id);
        if (fail-- > 0) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Try again.' }) });
        else await route.continue();
      });
      await page.goto('/inbox');
      await compose(page).click();
      const writing = composer(page, 'New message');
      await writing.getByRole('textbox', { name: 'To' }).fill('ada@example.org');
      await writing.getByRole('textbox', { name: 'Subject' }).fill('Lunch');
      await writing.getByRole('textbox', { name: 'Message' }).fill('See you at noon.');
      const sendIt = writing.getByRole('button', { name: /^Send/ });
      await sendIt.click();
      await expect.poll(() => ids.length).toBe(1);
      await expect(sendIt).toBeEnabled();
      await sendIt.click();
      await expect.poll(() => ids.length).toBe(2);
      expect(ids[1]).toBe(ids[0]);

      await expect(sendIt).toBeEnabled();
      await writing.getByRole('textbox', { name: 'Message' }).fill('See you at one.');
      await sendIt.click();
      await expect(toast(page, 'Lunch')).toContainText('Sent');
      expect(ids).toHaveLength(3);
      expect(ids[2]).not.toBe(ids[0]);
      const [sent] = sift.sent();
      expect(readSent(sent!.raw).headers['Message-ID']).toBe(ids[2]);
    });
  });

  test('what is written is kept in the browser through a reload, and a draft discarded can be had back', async ({ page }) => {
    await page.goto('/');
    await compose(page).click();
    const writing = composer(page, 'New message');
    await writing.getByRole('textbox', { name: 'To' }).fill('ada@example.org');
    await writing.getByRole('textbox', { name: 'Message' }).fill('Half written');
    await page.reload();
    await expect(writing.getByRole('textbox', { name: 'Message' })).toHaveValue('Half written');
    await expect(writing.getByRole('textbox', { name: 'To' })).toHaveValue('ada@example.org');

    await writing.getByRole('button', { name: 'Discard' }).click();
    await expect(writing).toHaveCount(0);
    await toast(page, 'To ada@example.org').getByRole('button', { name: /^Undo/ }).click();
    await expect(writing.getByRole('textbox', { name: 'Message' })).toHaveValue('Half written');
  });

  test('from a mailbox Google has not let Sift send from, it says so and offers the press that asks', async ({ page, sift }) => {
    await page.goto('/');
    await switchMailbox(page, WORK);
    await page.keyboard.press('c');
    const writing = composer(page, 'New message');
    await expect(writing.getByText(`Sift may not send from ${WORK} yet`)).toBeVisible();
    await expect(writing.getByRole('link', { name: 'Let Sift send' })).toHaveAttribute(
      'href',
      `/auth/login?${new URLSearchParams({ grant: 'send', mailbox: WORK, to: '/?compose=new' }).toString()}`,
    );
    await writing.getByRole('textbox', { name: 'To' }).fill('ada@example.org');
    await expect(writing.getByRole('button', { name: /^Send/ })).toBeDisabled();

    await writing.getByRole('combobox', { name: 'From' }).click();
    await page.getByRole('option', { name: ME, exact: true }).click();
    await expect(writing.getByRole('link', { name: 'Let Sift send' })).toHaveCount(0);
    await expect(writing.getByRole('button', { name: /^Send/ })).toBeEnabled();
    expect(sift.sent()).toEqual([]);
  });

  test('a reply is from the mailbox its message came to, whichever is chosen, to its sender, in its conversation', async ({ page, sift }) => {
    await page.goto('/');
    await switchMailbox(page, WORK);
    await page.goto('/?message=m6&compose=reply');
    const writing = composer(page, 'Reply');
    // Written in the reader, under the message it answers.
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    await expect(reader(page).getByText('Are you free for lunch on Thursday?', { exact: true })).toBeVisible();
    await expect(writing.getByRole('combobox', { name: 'From' })).toContainText(ME);
    await expect(writing.getByRole('textbox', { name: 'To' })).toHaveValue('Ada Lovelace <ada@example.org>');
    await expect(writing.getByRole('textbox', { name: 'Subject' })).toHaveCount(0);
    await expect(writing.getByRole('textbox', { name: 'Message' })).toBeFocused();
    await page.keyboard.type('Thursday works.');
    await writing.getByRole('button', { name: /^Send/ }).click();

    await expect(toast(page, 'Re: Lunch on Thursday?')).toContainText('Sent');
    await expect(writing).toHaveCount(0);
    // The message it answers is still open.
    await expect(readerHeading(page, 'Lunch on Thursday?')).toBeVisible();
    const [sent] = sift.sent();
    expect(sent).toMatchObject({ mailbox: ME, threadId: 't6' });
    expect(readSent(sent!.raw).headers).toMatchObject({
      From: ME,
      To: '"Ada Lovelace" <ada@example.org>',
      Subject: 'Re: Lunch on Thursday?',
      'In-Reply-To': '<thursday@example.org>',
      References: '<lunch@example.org> <thursday@example.org>',
    });
  });

  test('R in the reader replies to the conversation, and the reply sent is in it, with the reader where it was', async ({ page, sift }) => {
    await page.goto('/inbox');
    await inboxRow(page, 'Lunch on Thursday?').getByRole('cell').nth(2).click();
    const open = reader(page);
    // Its key is bound once the press is drawn.
    await expect(open.getByRole('button', { name: /^Reply all(?! or)/ })).toBeVisible();
    await page.keyboard.press('r');
    const writing = composer(page, 'Reply');
    await expect(writing.getByRole('textbox', { name: 'To' })).toHaveValue('Ada Lovelace <ada@example.org>');
    await expect(writing.getByRole('textbox', { name: 'Message' })).toBeFocused();
    // Written in place under the conversation, which stays on the page above it.
    const asked = open.getByText('Are you free for lunch on Thursday?', { exact: true });
    await expect(asked).toBeInViewport();
    expect((await boxOf(asked)).y).toBeLessThan((await boxOf(writing)).y);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await param(page, 'compose').toBe('reply');
    await page.keyboard.type('Thursday works.');
    await page.keyboard.press('Control+Enter');

    await expect(toast(page, 'Re: Lunch on Thursday?')).toContainText('Sent');
    await expect(writing).toHaveCount(0);
    // The newest in the conversation now, open under Ada's.
    await expect(open.getByRole('article').last()).toContainText('Thursday works.');
    // From the account, said as a mail app says it.
    await expect(open.getByRole('article').last().getByText('me', { exact: true })).toBeVisible();
    // Back on the reader, not on its first link, whose card would open over the conversation.
    await expect(open).toBeFocused();
    expect(readSent(sift.sent()[0]!.raw).headers).toMatchObject({ 'In-Reply-To': '<thursday@example.org>' });

    // Opened again, the reply is the newest, so it is the one open and Ada's is folded above it.
    await page.keyboard.press('Escape');
    await expect(open).toHaveCount(0);
    // The row is the conversation's newest message now: the reply.
    await inboxRow(page, 'Re: Lunch on Thursday?').getByRole('cell').nth(2).click();
    await expect(reader(page).getByText('Thursday works.')).toBeVisible();
    await expect(reader(page).getByRole('row').filter({ hasText: 'Thursday works.' })).toHaveCount(0);
    await expect(reader(page).getByRole('row').filter({ hasText: 'Ada' })).toHaveCount(1);
  });

  test('the Reply under the conversation answers its newest, in the box at its foot', async ({ page, sift }) => {
    await page.goto('/inbox');
    await inboxRow(page, 'Your March bill').getByRole('cell').nth(2).click();
    const open = reader(page);
    await open.getByRole('button', { name: /^Reply(?! all| to)/ }).click();
    const writing = composer(page, 'Reply');
    await expect(writing.getByRole('textbox', { name: 'Message' })).toBeFocused();
    // The newest needs no saying, and the address names only the reader's own message.
    await expect(writing.getByText(/^Replying to/)).toHaveCount(0);
    await param(page, 'answering').toBeNull();
    expect((await boxOf(writing)).y).toBeGreaterThan((await boxOf(open.getByRole('article').last())).y);
    await page.keyboard.type('Thanks.');
    await page.keyboard.press('Control+Enter');

    await expect(toast(page, 'Re: Your March bill')).toContainText('Sent');
    expect(readSent(sift.sent()[0]!.raw).headers).toMatchObject({ 'In-Reply-To': '<march@utility.example.net>' });
  });

  test('an earlier message is answered from its own head, in the box at the foot of the conversation, which a reload keeps', async ({ page, sift }) => {
    await page.goto('/inbox');
    await inboxRow(page, 'Your March bill').getByRole('cell').nth(2).click();
    const open = reader(page);
    // Unread, so all three are open; the oldest is May's.
    const may = open.getByRole('article').first();
    await expect(open.getByRole('article')).toHaveCount(3);
    await may.getByRole('button', { name: 'Reply to Utility' }).click();
    const writing = composer(page, 'Reply');
    await expect(writing.getByText(/^Replying to Utility, /)).toBeVisible();
    await expect(writing.getByRole('textbox', { name: 'Message' })).toBeFocused();
    await expect(writing).toBeInViewport();
    expect((await boxOf(writing)).y).toBeGreaterThan((await boxOf(open.getByRole('article').last())).y);
    await param(page, 'message').toBe('m11');
    await param(page, 'answering').toBe('m13');
    await page.keyboard.type('Paid already.');

    await page.reload();
    await expect(writing.getByRole('textbox', { name: 'Message' })).toHaveValue('Paid already.');
    await expect(writing.getByText(/^Replying to Utility, /)).toBeVisible();
    // Read now, the conversation opens on its newest and the message answered.
    await expect(open.getByRole('article')).toHaveCount(2);
    await writing.getByRole('button', { name: /^Send/ }).click();

    await expect(toast(page, 'Re: Your May bill')).toContainText('Sent');
    await expect(writing).toHaveCount(0);
    await param(page, 'answering').toBeNull();
    await expect(open.getByRole('article').last()).toContainText('Paid already.');
    const [sent, ...more] = sift.sent();
    expect(more).toEqual([]);
    expect(sent).toMatchObject({ threadId: 'bills' });
    expect(readSent(sent!.raw).headers).toMatchObject({
      To: '"Utility" <billing@utility.example.net>',
      Subject: 'Re: Your May bill',
      'In-Reply-To': '<may@utility.example.net>',
      References: '<may@utility.example.net>',
    });
  });

  test('Reply all and Forward of an earlier message are behind one press on its head', async ({ page }) => {
    await page.goto('/inbox');
    await inboxRow(page, 'Your March bill').getByRole('cell').nth(2).click();
    const open = reader(page);
    await open.getByRole('article').first().getByRole('button', { name: 'Reply all or forward' }).click();
    await page.getByRole('menuitem', { name: 'Forward' }).click();
    const writing = composer(page, 'Forward');
    await expect(writing.getByText(/^Forwarding Utility’s message, /)).toBeVisible();
    await expect(writing.getByRole('textbox', { name: 'Subject' })).toHaveValue('Fwd: Your May bill');
    await expect(writing.getByRole('textbox', { name: 'To' })).toBeFocused();
    await param(page, 'compose').toBe('forward');
    await param(page, 'answering').toBe('m13');
  });

  test('Forward quotes the message under what is written, and sends it as new mail', async ({ page, sift }) => {
    await page.goto('/inbox');
    await inboxRow(page, 'Lunch on Thursday?').getByRole('cell').nth(2).click();
    await reader(page)
      .getByRole('button', { name: /^Forward/ })
      .click();
    const writing = composer(page, 'Forward');
    const to = writing.getByRole('textbox', { name: 'To' });
    await expect(to).toBeFocused();
    await expect(writing.getByRole('textbox', { name: 'Subject' })).toHaveValue('Fwd: Lunch on Thursday?');
    await page.keyboard.type('grace@example.net');
    await writing.getByRole('textbox', { name: 'Message' }).focus();
    await page.keyboard.type('Are you free too?');
    await writing.getByRole('button', { name: /^Send/ }).click();

    await expect(toast(page, 'Fwd: Lunch on Thursday?')).toContainText('Sent');
    const { headers, text } = readSent(sift.sent()[0]!.raw);
    expect(headers).toMatchObject({ To: 'grace@example.net', Subject: 'Fwd: Lunch on Thursday?' });
    expect(headers['In-Reply-To']).toBeUndefined();
    expect(text).toMatch(/^Are you free too\?\r\n\r\n---------- Forwarded message ---------\r\nFrom: Ada Lovelace <ada@example\.org>\r\nDate: .+\r\n/);
    expect(text).toContain('Subject: Lunch on Thursday?\r\nTo: Me <me@example.org>\r\n\r\nAre you free for lunch on Thursday?');
  });

  test('on a phone Inbox has the press that writes, it covers the screen, and nothing scrolls sideways', async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto('/inbox');
    await compose(page).click();
    const writing = composer(page, 'New message');
    await writing.getByRole('textbox', { name: 'To' }).fill('someone.with.a.very.long.address@a-long-domain.example.com');
    await expect(writing.getByRole('button', { name: /^Send/ })).toBeEnabled();
    await sideScroll(page).toBe(0);
    expect((await boxOf(writing)).width).toBe(PHONE.width);
  });
});

test('with Inbox off, nothing offers to write mail', async ({ page }) => {
  await page.goto('/?compose=new');
  await expect(reviewRows(page).first()).toBeVisible();
  await page.keyboard.press('c');
  await expect(compose(page)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(toasts(page).getByRole('dialog')).toHaveCount(0);
});
