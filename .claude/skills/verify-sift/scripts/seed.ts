#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Verification scaffolding: fills an empty sift home with synthetic mail and prints a session cookie for it.
 *
 *   node .claude/skills/verify-sift/scripts/seed.ts <home> <google.json> [--bare | --on | --chatgpt | --inbox]
 *
 * The mail is put in the fake Google the unit tests use (tests/google.ts), signed in to with the fake's OAuth client, and
 * goes through the real pass (with sift off) and Sift's own Gmail client, so decisions, labels, suggestion bodies and
 * proposals are what sift itself would record. Writes the fake Google, as Gmail is after the last pass, to <google.json>
 * for serve.ts to carry on from, and prints one line: the `sift_session` cookie value for the connected account.
 *
 * `--on` then turns sift on and runs one more pass over three new messages: Lin's, which it cannot place, so it is left
 * for the user with sift's Gmail label; the Store's last-day sale, archived as Marketing and then undone; and a third
 * widgets newsletter, archived as Newsletters by its rule, which stands.
 * `--chatgpt` has the model reached through a ChatGPT plan instead of an API key.
 * `--inbox` has Inbox on before the passes, so they keep the text of the inbox's mail, and its copy of the last year
 * part-way, its first ten listed, until a pass is begun. Google lets Sift send from me@example.org, as itself or as
 * `me+lists@example.org`, and not from the work mailbox.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../../../src/config.ts';
import { checkRuleFilters, writeRuleFilter } from '../../../../src/actions/rule-filters.ts';
import { memoryEphemeral } from '../../../../src/ephemeral/ephemeral.ts';
import { installClient } from '../../../../src/gmail/auth.ts';
import { applyFeedback, pendingSuggestions } from '../../../../src/learn/feedback.ts';
import { saveApiKey } from '../../../../src/model/models.ts';
import { gmailFor } from '../../../../src/sift/controls.ts';
import { credentials } from '../../../../src/store/credentials.ts';
import { writeSecret } from '../../../../src/secrets.ts';
import { connectAccount, setCanSend } from '../../../../src/store/accounts.ts';
import { listLabels, removeLabel } from '../../../../src/store/labels.ts';
import { setActive, setMail, setModel } from '../../../../src/store/preferences.ts';
import { advanceCopy, goingCopy, startCopies } from '../../../../src/store/copies.ts';
import { lastStandingChange } from '../../../../src/store/actions.ts';
import { undo } from '../../../../src/actions/executor.ts';
import { listProposals } from '../../../../src/store/proposals.ts';
import type { Sql } from '../../../../src/store/sql.ts';
import { openStore } from '../../../../src/store/store.ts';
import { addRule } from '../../../../src/store/rules.ts';
import type { JudgeInput } from '../../../../src/triage/stages/model.ts';
import { LEAVE_IN_INBOX } from '../../../../src/triage/types.ts';
import { copyQuery } from '../../../../src/work/copy.ts';
import { type RunOptions, dueWork, runWork } from '../../../../src/work/run.ts';
import { withSampleLabels } from '../../../../tests/helpers.ts';
import { type FakeGmail, FakeGoogle, type Mail, SECRETS, serveGoogle } from '../../../../tests/google.ts';
import { plain } from '../../../../src/plain.ts';

const ACCOUNT = 'me@example.org';
const WORK = 'me@work.example.org';
const OTHER = 'bravo@example.net';

const [home, googleFile, variant] = process.argv.slice(2);
if (!home || !googleFile) throw new Error('usage: seed.ts <home> <google.json> [--bare | --on | --chatgpt | --inbox]');
process.env['SIFT_HOME'] = resolve(home);
const config = loadConfig();
if (existsSync(config.databaseDir)) throw new Error(`${config.databaseDir} already exists. Seed an empty home.`);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();
let n = 0;
const mail = (from: string, subject: string, text: string, headers: Record<string, string> = {}, labelIds: string[] = []): Mail => ({
  id: `m${++n}`,
  threadId: `t${n}`,
  from,
  to: `Me <${ACCOUNT}>`,
  subject,
  text,
  labelIds: ['INBOX', 'UNREAD', ...labelIds],
  at: now - n * HOUR,
  headers: { 'Authentication-Results': `mx.google.com; dmarc=pass header.from=${from.replace(/.*@|>.*/g, '')}`, ...headers },
});
const list = (id: string) => ({
  'List-Id': `<${id}>`,
  'List-Unsubscribe': `<https://${id}/unsubscribe>`,
  'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
});

/**
 * The Deals mail's HTML part, beside its text: a remote image, a background from elsewhere, inline styles,
 * a link, one through a click tracker, a tracking pixel, and the things the frame must never run or follow. The hosts are on example.com, which resolves,
 * so a request that got out would be seen.
 */
const DEALS_HTML = `<!DOCTYPE html><html><head><title>Deals</title><meta http-equiv="refresh" content="5;url=https://track.example.com/refresh"></head>
<body style="margin:0;background:#f4efe6;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="600" style="max-width:100%;background:#ffffff;border:1px solid #ddd">
<tr><td style="padding:0"><img src="https://images.example.com/hero.png" width="600" height="200" alt="48 hours only" style="display:block;width:100%;height:auto"></td></tr>
<tr><td style="padding:24px;color:#222;background-image:url(https://images.example.com/paper.png)">
<h1 style="margin:0 0 12px;font-size:28px;color:#b3261e">30% off everything</h1>
<p style="font-size:16px;line-height:1.5">Everything must go. The sale ends in 48 hours.</p>
<p><a href="https://shop.example.com/sale" style="display:inline-block;padding:12px 20px;background:#222;color:#fff;text-decoration:none">Shop the sale</a></p>
<p style="font-size:12px;color:#777"><a href="javascript:alert('clicked')" onclick="alert('clicked')">Preferences</a> · <a href="https://click.promo.example.com/u/unsubscribe">Unsubscribe</a></p>
</td></tr></table>
<img src="https://track.example.com/open.gif?u=me" width="1" height="1" alt="">
</td></tr></table>
<script>document.body.dataset.ran = 'yes'</script>
</body></html>`;

const inbox = [
  mail('Weekly Digest <digest@news.example.com>', 'This week in widgets', 'Five stories about widgets.', list('news.example.com')),
  mail('Weekly Digest <digest@news.example.com>', 'Widgets, part two', 'More stories about widgets.', list('news.example.com')),
  mail('Shop <orders@shop.example.com>', 'Your order has shipped', 'Order 1042 is on its way.'),
  {
    ...mail(
      'Deals <deals@promo.example.com>',
      '48 hours only: 30% off',
      'Everything must go.',
      { ...list('promo.example.com'), 'X-Mailer': 'Mailchimp Mailer', 'Reply-To': 'Promo Team <team@promo.example.com>' },
      ['CATEGORY_PROMOTIONS'],
    ),
    html: DEALS_HTML,
  },
  mail('CI <builds@ci.example.org>', 'Build failed on main', 'The build failed at step 3.'),
  mail('Ada Lovelace <ada@example.org>', 'Lunch on Thursday?', 'Are you free for lunch on Thursday?', {
    'Message-ID': '<thursday@example.org>',
    'In-Reply-To': '<lunch@example.org>',
    References: '<lunch@example.org>',
  }),
  // To everyone at the review, so the panel's Cc folds, with her notes as a file.
  {
    ...mail('Grace Hopper <grace@example.net>', 'Notes from the review', 'Attached are my notes.', {
      Cc: Array.from({ length: 12 }, (_, i) => `reviewer${i + 1}@example.net`).join(', '),
    }),
    attachments: [{ filename: 'review-notes.pdf', mimeType: 'application/pdf', data: '%PDF-1.4 synthetic' }],
  },
  // The one the stand-in model places, as Marketing.
  mail('Store <sale@store.example.com>', 'Winter sale starts now', 'Up to half off.', list('store.example.com'), ['CATEGORY_PROMOTIONS']),
  // The stand-in model fails on these every time, so after three passes they are out of the queue and not judged.
  mail('Ops <alerts@ops.example.com>', 'Disk 91% full on db-2', 'Free space is running low.'),
  mail('Ops <alerts@ops.example.com>', 'Replica lag on db-3', 'The replica is 40 seconds behind.'),
  // Kept below as Receipts, which that label archives, as moving them back to the inbox in Gmail answers; so Sift proposes keeping them.
  // One conversation, so Inbox has one to fold.
  ...[
    mail('Utility <billing@utility.example.net>', 'Your March bill', 'Your bill is ready.', { 'Message-ID': '<march@utility.example.net>' }),
    mail('Utility <billing@utility.example.net>', 'Your April bill', 'Your bill is ready.', { 'Message-ID': '<april@utility.example.net>' }),
    mail('Utility <billing@utility.example.net>', 'Your May bill', 'Your bill is ready.', { 'Message-ID': '<may@utility.example.net>' }),
  ].map((bill) => ({ ...bill, threadId: 'bills' })),
  // One address under several names, which the stand-in model places by name, so For review folds them by name and
  // gives the address's page a list of names.
  ...(
    [
      ['Dependabot', 'Bump lodash from 4.17.20 to 4.17.21'],
      ['Dependabot', 'Bump vite from 6.0.1 to 6.0.3'],
      ['Security alerts', 'A critical vulnerability in lodash'],
      ['github-actions[bot]', 'Run failed: CI on main'],
      ['Dependabot', 'Bump zod from 4.0.0 to 4.0.2'],
      ['Security alerts', 'A new SSH key was added to your account'],
      ['github-actions[bot]', 'Run failed: Deploy on main'],
      ['Ada Lovelace', 'Re: Fix the release script (#412)'],
    ] as const
  ).map(([name, subject]) => mail(`${name} <notifications@code.example.com>`, subject, subject)),
];

const google = new FakeGoogle();
const gmail = google.mailbox(ACCOUNT);
const server = serveGoogle(() => google);
server.listen();
installClient(config, JSON.stringify({ web: { client_id: SECRETS.clientId, client_secret: SECRETS.clientSecret } }));
/** Where the mailbox's history is now, which a mailbox connected now starts from. */
const cursor = (mailbox: FakeGmail) => String(mailbox.save().historyId);
/** The mailbox's sign-in, as Google's consent screen leaves it, kept in the person's database. */
const signIn = async (db: Sql, address: string, send = false) => await (await credentials(db, 'gmail')).write(address, google.grant(address, { send }));

const store = await openStore(config);
const user = await connectAccount(store, ACCOUNT, cursor(gmail), now - DAY);
const db = await store.user(user);
await signIn(db, ACCOUNT, variant === '--inbox');
await withSampleLabels(db);
// Two label rules and an action rule; a fourth, which cannot be a filter, is added after the passes.
const newsRule = await addRule(db, { match: { fromDomain: ['news.example.com'] }, labelId: 'newsletter' }, 'user');
const ordersRule = await addRule(db, { match: { from: ['orders@shop.example.com'] }, labelId: 'transactional' }, 'user');
const ciRule = await addRule(db, { match: { fromDomain: ['ci.example.org'] }, disposition: 'archive' }, 'user');

// Ada's mail is a reply: the owner wrote to her, from Gmail, long before Sift.
gmail.deliver(
  {
    id: 's1',
    from: `Me <${ACCOUNT}>`,
    to: 'Ada Lovelace <ada@example.org>',
    subject: 'Lunch?',
    text: 'Lunch one day?',
    labelIds: ['SENT'],
    at: now - 400 * DAY,
    headers: { 'Message-ID': '<lunch@example.org>' },
  },
  { quietly: true },
);
if (variant === '--inbox') gmail.sendAs = [{ email: 'me+lists@example.org' }];
for (const m of inbox) gmail.deliver(m);

// A stand-in model that calls no provider. It is sure the Store's sale is Marketing, answers unusably about
// the Ops alerts every time (a provider error would be taken for an outage and not count), and can place nothing else, so what no rule covers is left Unlabelled: with
// no model at all it would wait, undecided, and never be asked about.
const standIn = async () => ({
  model: 'synthetic/stand-in',
  judge: async ({ evidence }: JudgeInput) =>
    evidence.facts.from.address === 'sale@store.example.com'
      ? { label: 'marketing', reason: 'synthetic: a sale sent to a list', confidence: 0.95 }
      : evidence.facts.from.address === 'alerts@ops.example.com'
        ? { failed: 'synthetic: the model did not return a usable verdict', unusable: true as const }
        : evidence.facts.from.address === 'notifications@code.example.com' && evidence.facts.from.name !== 'Ada Lovelace'
          ? evidence.facts.from.name === 'Security alerts'
            ? { label: 'security', reason: 'synthetic: an alert about the account', confidence: 0.95 }
            : { label: 'notification', reason: 'synthetic: an automated notice', confidence: 0.95 }
          : { label: 'unsure', reason: 'synthetic: cannot tell', confidence: 0.3 },
});
const ephemeral = memoryEphemeral();
const options: RunOptions = { ephemeral, model: standIn, connect: async (db, account) => await gmailFor(config, ephemeral, db, account.email), log: () => {} };
/** One pass of whatever is due, as the tick begins it. */
const pass = async (people?: readonly number[]) => {
  for (const piece of await dueWork(store, options, people)) {
    const result = await runWork(store, piece, options, Infinity);
    if (result?.error) throw new Error(`seed pass failed: ${result.error}`);
  }
};
if (variant === '--inbox') await setMail(db, true);
// Four passes: three use up the Ops alerts' tries with the model, and the fourth leaves them to the user.
for (let i = 0; i < 4; i++) await pass();
if (gmail.asked('users.messages.modify').length > 0) throw new Error('seed pass changed Gmail while sift was off');
// Each answered as Gmail answers a move back to the inbox: the label, kept. Two alike propose a rule that keeps them.
for (const waiting of await pendingSuggestions(db, { accountId: ACCOUNT, sender: 'billing@utility.example.net' }))
  await applyFeedback(
    db,
    {
      accountId: ACCOUNT,
      sender: plain(waiting.fromAddress),
      label: 'transactional',
      disposition: 'keep',
      decisionId: waiting.decisionId,
      messageId: waiting.messageId,
      via: 'gmail',
    },
    now,
  );
if ((await listProposals(db, ACCOUNT)).length !== 1) throw new Error('seed answers did not propose a rule');
const { api, mailbox } = await gmailFor(config, ephemeral, db, ACCOUNT);
if (variant === '--on') {
  await setActive(db, true);
  const later = [
    mail('Lin <lin@example.com>', 'Quick question', 'Do you have a minute today?'),
    mail('Store <sale@store.example.com>', 'Last day of the sale', 'It ends tonight.', list('store.example.com'), ['CATEGORY_PROMOTIONS']),
    mail('Weekly Digest <digest@news.example.com>', 'Widgets, part three', 'Still more stories about widgets.', list('news.example.com')),
  ];
  for (const m of later) gmail.deliver(m);
  // As Check now begins it: the timed tick, moments after the last pass, would wait out the gap between looks.
  await pass([user]);
  const [lin, sale, news] = later.map((m) => m.id!);
  const review = [...gmail.labels.values()].find((l) => l.name.toLowerCase().endsWith('sift/review'));
  if (!review || !gmail.message(lin!)?.labelIds.includes(review.id)) throw new Error('the pass with sift on did not leave Lin for the user');
  const archived = await lastStandingChange(db, ACCOUNT, sale!);
  if (archived?.type !== 'archive') throw new Error('the pass with sift on did not archive the sale');
  await undo({ db, mailbox }, archived.id);
  if ((await lastStandingChange(db, ACCOUNT, news!))?.type !== 'archive') throw new Error('the pass with sift on did not archive the newsletter');
}
// Three rules written to Gmail as filters, as the dashboard asks: the CI one lands; the Shop one
// lands and is then deleted in Gmail, which a check notices; Gmail does not answer for the news one.
// A rule added after the passes, so it decides nothing, that cannot be one (Gmail cannot mark spam).
await addRule(db, { match: { fromDomain: ['promo.example.com'] }, disposition: 'spam' }, 'user');
await writeRuleFilter({ db, mailbox, now: () => now - 3 * HOUR }, ordersRule, ACCOUNT);
gmail.filters = [];
await checkRuleFilters({ db, mailbox, now: () => now - 150 * 60_000 }, ACCOUNT, false);
await writeRuleFilter({ db, mailbox, now: () => now - 2 * HOUR }, ciRule, ACCOUNT);
gmail.fail('users.settings.filters.create', 'network');
await writeRuleFilter({ db, mailbox, now: () => now - HOUR }, newsRule, ACCOUNT).catch(() => undefined);
if (gmail.filters.length !== 1) throw new Error(`Gmail holds ${gmail.filters.length} filters, not the CI rule's alone`);
// A second mailbox of the same person, with no mail (connected after the passes, so none comes to it), to remove; and a second person, who owns nothing yet and
// takes over the install when the first deletes their account. Neither can be signed in to here.
await connectAccount(store, WORK, cursor(google.mailbox(WORK)), now - 23 * HOUR, user);
await signIn(db, WORK);
if (variant === '--inbox') {
  await setCanSend(db, ACCOUNT, true);
  // Copying the year part-way, as if Inbox had been turned on ten minutes ago and its first ten listed; the next pass begun finishes it.
  await startCopies(db, [ACCOUNT], { since: now - 365 * DAY, before: now - 10 * 60_000, now: now - 10 * 60_000 });
  const copy = (await goingCopy(db, ACCOUNT))!;
  const page = await api.searchMail(copyQuery(copy), 10);
  await advanceCopy(db, copy, { listed: page.ids.length, next: page.nextPageToken ?? null, estimate: page.estimate ?? 0 }, now);
}
// `--bare` takes the person's labels out, as before they chose any, so every screen is the setting-up steps.
if (variant === '--bare') for (const label of await listLabels(db)) if (label.id !== LEAVE_IN_INBOX) await removeLabel(db, label.id, now - 23 * HOUR);
const other = await connectAccount(store, OTHER, cursor(google.mailbox(OTHER)), now - 22 * HOUR);
await signIn(await store.user(other), OTHER);
// A model in use, so the dashboard is not behind its setting-up steps. The key and the sign-in are made up, and the
// model is a stand-in (stand-ins.ts), so nothing ever calls Anthropic or OpenAI with them.
if (variant === '--chatgpt') {
  await (
    await credentials(db, 'model')
  ).write('openai-codex', JSON.stringify({ type: 'oauth', access: 'synthetic', refresh: 'synthetic', expires: now + 86_400_000 }));
  await setModel(db, 'openai-codex/gpt-5.6-luna');
} else {
  await saveApiKey({ ...(await credentials(db, 'model')), exclusive: (work) => work() }, 'anthropic', 'sk-ant-synthetic-seed');
  await setModel(db, 'anthropic/claude-haiku-4-5');
}
await store.close();
server.close();
writeFileSync(googleFile, JSON.stringify(google.save()));

// The same cookie `/auth/callback` sets (`signSession` in src/dashboard/server.ts), signed with this home's key.
const secret = randomBytes(32).toString('base64url');
writeSecret(config.dashboardKeyPath, secret, config.keys);
const body = Buffer.from(JSON.stringify({ e: ACCOUNT, p: user, x: now + 86_400_000 })).toString('base64url');
console.log(`${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`);
