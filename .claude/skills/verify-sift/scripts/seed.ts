#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Verification scaffolding: fills an empty sift home with synthetic mail and prints a session cookie for it.
 *
 *   node .claude/skills/verify-sift/scripts/seed.ts <home> <gmail.json> [--bare | --on | --chatgpt | --inbox]
 *
 * The mail goes through the real pass (`workDue`, with sift off), so decisions, labels, suggestion
 * bodies and proposals are what sift itself would record. Only Gmail is faked, at the `GmailApi` and
 * `Mailbox` ports. Writes the fake Gmail's filters to <gmail.json>, for serve.ts to carry on from, and prints one
 * line: the `sift_session` cookie value for the connected account.
 *
 * `--on` then turns sift on and runs one more pass over three new messages: Lin's, which it cannot place, so it is left
 * for the user with sift's Gmail label; the Store's last-day sale, archived as Marketing and then undone; and a third
 * widgets newsletter, archived as Newsletters by its rule, which stands.
 * `--chatgpt` has the model reached through a ChatGPT plan instead of an API key.
 * `--inbox` has Inbox on before the passes, so they keep the text of the inbox's mail, and hands the fake Gmail each
 * message's labels, so the reader's own presses there change it; elsewhere the fake Gmail holds none of the seed's mail. Its
 * copy of the last year is part-way, 1,240 of about 8,240, until a pass is begun.
 * Google lets Sift send from me@example.org, as itself or as `me+lists@example.org`, and not from the work mailbox.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../../../../src/config.ts';
import { checkRuleFilters, writeRuleFilter } from '../../../../src/actions/rule-filters.ts';
import { memoryEphemeral } from '../../../../src/ephemeral/ephemeral.ts';
import { applyFeedback, pendingSuggestions } from '../../../../src/learn/feedback.ts';
import type { GmailApi, RawMessage } from '../../../../src/gmail/api.ts';
import { saveApiKey } from '../../../../src/model/models.ts';
import { credentials } from '../../../../src/store/credentials.ts';
import { writeSecret } from '../../../../src/secrets.ts';
import { connectAccount, setCanSend, setMailboxAliases } from '../../../../src/store/accounts.ts';
import { listLabels, removeLabel } from '../../../../src/store/labels.ts';
import { setActive, setMail, setModel } from '../../../../src/store/preferences.ts';
import { advanceCopy, goingCopy, startCopies } from '../../../../src/store/copies.ts';
import { lastStandingChange } from '../../../../src/store/actions.ts';
import { undo } from '../../../../src/actions/executor.ts';
import { listProposals } from '../../../../src/store/proposals.ts';
import { openStore } from '../../../../src/store/store.ts';
import { addRule } from '../../../../src/store/rules.ts';
import type { JudgeInput } from '../../../../src/triage/stages/model.ts';
import { LEAVE_IN_INBOX } from '../../../../src/triage/types.ts';
import { FakeMailbox, withSampleLabels, workDue } from '../../../../tests/helpers.ts';
import { plain } from '../../../../src/plain.ts';

const ACCOUNT = 'me@example.org';
const WORK = 'me@work.example.org';
const OTHER = 'bravo@example.net';

const [home, gmailFile, variant] = process.argv.slice(2);
if (!home || !gmailFile) throw new Error('usage: seed.ts <home> <gmail.json> [--bare | --on | --chatgpt | --inbox]');
process.env['SIFT_HOME'] = resolve(home);
const config = loadConfig();
if (existsSync(config.databaseDir)) throw new Error(`${config.databaseDir} already exists. Seed an empty home.`);

const HOUR = 3_600_000;
const now = Date.now();
let n = 0;
const mail = (from: string, subject: string, body: string, extra: { name: string; value: string }[] = [], labelIds: string[] = []) => ({
  raw: {
    id: `m${++n}`,
    threadId: `t${n}`,
    labelIds: ['INBOX', 'UNREAD', ...labelIds],
    internalDate: now - n * HOUR,
    headers: [
      { name: 'From', value: from },
      { name: 'To', value: `Me <${ACCOUNT}>` },
      { name: 'Subject', value: subject },
      { name: 'Authentication-Results', value: `mx.google.com; dmarc=pass header.from=${from.replace(/.*@|>.*/g, '')}` },
      ...extra,
    ],
  } satisfies RawMessage,
  body,
});
const list = (id: string) => [
  { name: 'List-Id', value: `<${id}>` },
  { name: 'List-Unsubscribe', value: `<https://${id}/unsubscribe>` },
  { name: 'List-Unsubscribe-Post', value: 'List-Unsubscribe=One-Click' },
];

const inbox = [
  mail('Weekly Digest <digest@news.example.com>', 'This week in widgets', 'Five stories about widgets.', list('news.example.com')),
  mail('Weekly Digest <digest@news.example.com>', 'Widgets, part two', 'More stories about widgets.', list('news.example.com')),
  mail('Shop <orders@shop.example.com>', 'Your order has shipped', 'Order 1042 is on its way.'),
  mail(
    'Deals <deals@promo.example.com>',
    '48 hours only: 30% off',
    'Everything must go.',
    [...list('promo.example.com'), { name: 'X-Mailer', value: 'Mailchimp Mailer' }, { name: 'Reply-To', value: 'Promo Team <team@promo.example.com>' }],
    ['CATEGORY_PROMOTIONS'],
  ),
  mail('CI <builds@ci.example.org>', 'Build failed on main', 'The build failed at step 3.'),
  mail('Ada Lovelace <ada@example.org>', 'Lunch on Thursday?', 'Are you free for lunch on Thursday?', [
    { name: 'Message-ID', value: '<thursday@example.org>' },
    { name: 'In-Reply-To', value: '<lunch@example.org>' },
    { name: 'References', value: '<lunch@example.org>' },
  ]),
  // To everyone at the review, so the panel's Cc folds.
  mail('Grace Hopper <grace@example.net>', 'Notes from the review', 'Attached are my notes.', [
    { name: 'Cc', value: Array.from({ length: 12 }, (_, i) => `reviewer${i + 1}@example.net`).join(', ') },
  ]),
  // The one the stand-in model places, as Marketing.
  mail('Store <sale@store.example.com>', 'Winter sale starts now', 'Up to half off.', list('store.example.com'), ['CATEGORY_PROMOTIONS']),
  // The stand-in model fails on these every time, so after three passes they are out of the queue and not judged.
  mail('Ops <alerts@ops.example.com>', 'Disk 91% full on db-2', 'Free space is running low.'),
  mail('Ops <alerts@ops.example.com>', 'Replica lag on db-3', 'The replica is 40 seconds behind.'),
  // Kept below as Receipts, which that label archives, as moving them back to the inbox in Gmail answers; so Sift proposes keeping them.
  // One conversation, so Inbox has one to fold.
  ...[
    mail('Utility <billing@utility.example.net>', 'Your March bill', 'Your bill is ready.', [{ name: 'Message-ID', value: '<march@utility.example.net>' }]),
    mail('Utility <billing@utility.example.net>', 'Your April bill', 'Your bill is ready.', [{ name: 'Message-ID', value: '<april@utility.example.net>' }]),
    mail('Utility <billing@utility.example.net>', 'Your May bill', 'Your bill is ready.', [{ name: 'Message-ID', value: '<may@utility.example.net>' }]),
  ].map((bill) => ({ ...bill, raw: { ...bill.raw, threadId: 'bills' } })),
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

const store = await openStore(config);
const user = await connectAccount(store, ACCOUNT, '1', now - 24 * HOUR);
const db = await store.user(user);
await withSampleLabels(db);
// Two label rules and an action rule; a fourth, which cannot be a filter, is added after the passes.
const newsRule = await addRule(db, { match: { fromDomain: ['news.example.com'] }, labelId: 'newsletter' }, 'user');
const ordersRule = await addRule(db, { match: { from: ['orders@shop.example.com'] }, labelId: 'transactional' }, 'user');
const ciRule = await addRule(db, { match: { fromDomain: ['ci.example.org'] }, disposition: 'archive' }, 'user');

/**
 * The Deals mail (m4) as its HTML part, stored by the pass as it would be from Gmail: a remote image, a background from elsewhere, inline styles,
 * a link, and the things the frame must never run or follow. The hosts are on example.com, which resolves,
 * so a request that got out would be seen.
 */
const HTML: Record<string, string> = {
  m4: `<!DOCTYPE html><html><head><title>Deals</title><meta http-equiv="refresh" content="5;url=https://track.example.com/refresh"></head>
<body style="margin:0;background:#f4efe6;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table width="600" style="max-width:100%;background:#ffffff;border:1px solid #ddd">
<tr><td style="padding:0"><img src="https://images.example.com/hero.png" width="600" height="200" alt="48 hours only" style="display:block;width:100%;height:auto"></td></tr>
<tr><td style="padding:24px;color:#222;background-image:url(https://images.example.com/paper.png)">
<h1 style="margin:0 0 12px;font-size:28px;color:#b3261e">30% off everything</h1>
<p style="font-size:16px;line-height:1.5">Everything must go. The sale ends in 48 hours.</p>
<p><a href="https://shop.example.com/sale" style="display:inline-block;padding:12px 20px;background:#222;color:#fff;text-decoration:none">Shop the sale</a></p>
<p style="font-size:12px;color:#777"><a href="javascript:alert('clicked')" onclick="alert('clicked')">Preferences</a> · <a href="https://promo.example.com/unsubscribe">Unsubscribe</a></p>
</td></tr></table>
<img src="https://track.example.com/open.gif?u=me" width="1" height="1" alt="">
</td></tr></table>
<script>document.body.dataset.ran = 'yes'</script>
</body></html>`,
};

const mailbox = new FakeMailbox();
for (const { raw } of inbox) mailbox.labels.set(raw.id, [...raw.labelIds]);
// Ada's mail is a reply: the owner has written to her.
mailbox.sentTo.add('ada@example.org');
// Gmail's history: each delivery moves it on, and a read from a cursor lists what came after, as the timed tick's look and sync read it.
let history = 1;
const arrivals: { at: number; mail: (typeof inbox)[number] }[] = [];
const arrive = (mail: typeof inbox) => {
  history++;
  for (const m of mail) arrivals.push({ at: history, mail: m });
};
arrive(inbox);
const find = (id: string) => inbox.find((m) => m.raw.id === id);
// What a model's read of the whole message adds: Grace's notes come with a file, and the Deals mail is tracked.
function contentOf(id: string) {
  const m = find(id);
  if (!m) return null;
  const html = id === 'm4' ? { trackingPixel: true, trackedLinks: true, linkHosts: 2, linksOffDomain: true } : {};
  return { text: m.body, html: HTML[id] ?? null, facts: { hasAttachments: id === 'm7', ...html } };
}

const api: GmailApi = {
  getProfile: async () => ({ emailAddress: ACCOUNT, historyId: String(history) }),
  listHistory: async (start) => ({
    additions: arrivals.filter((a) => a.at > Number(start)).map(({ mail }) => ({ id: mail.raw.id, labelIds: mail.raw.labelIds })),
    historyId: String(history),
  }),
  searchInbox: async () => ({ ids: [] }),
  inboxSize: async () => inbox.length,
  searchMail: async () => ({ ids: [] }),
  mailboxSize: async () => 0,
  // With Inbox on, sync reads new mail whole once.
  getMessage: async (id) => {
    const m = find(id);
    const read = contentOf(id);
    return m && read ? { raw: m.raw, content: read } : null;
  },
  getMetadata: async (id) => find(id)?.raw ?? null,
  getLabelIds: async (id) => mailbox.labels.get(id) ?? null,
  listLabels: async () => [],
  getContent: async (id) => contentOf(id),
  getThread: async () => null,
  listSendAs: async () => [ACCOUNT],
};

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
if (variant === '--inbox') await setMail(db, true);
// Four passes: three use up the Ops alerts' tries with the model, and the fourth leaves them to the user.
const ephemeral = memoryEphemeral();
for (let pass = 0; pass < 4; pass++) {
  for (const result of await workDue(store, { ephemeral, model: standIn, connect: () => ({ api, mailbox }), log: () => {} }, Infinity))
    if (result.error) throw new Error(`seed pass failed: ${result.error}`);
}
if (mailbox.modifyCalls > 0) throw new Error('seed pass changed the fake mailbox while sift was off');
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
if (variant === '--on') {
  await setActive(db, true);
  const later = [
    mail('Lin <lin@example.com>', 'Quick question', 'Do you have a minute today?'),
    mail('Store <sale@store.example.com>', 'Last day of the sale', 'It ends tonight.', list('store.example.com'), ['CATEGORY_PROMOTIONS']),
    mail('Weekly Digest <digest@news.example.com>', 'Widgets, part three', 'Still more stories about widgets.', list('news.example.com')),
  ];
  inbox.push(...later);
  for (const { raw } of later) mailbox.labels.set(raw.id, [...raw.labelIds]);
  arrive(later);
  // As Check now begins it: the timed tick, moments after the last pass, would wait out the gap between looks.
  for (const result of await workDue(store, { ephemeral, model: standIn, connect: () => ({ api, mailbox }), log: () => {} }, Infinity, [user]))
    if (result.error) throw new Error(`seed pass failed: ${result.error}`);
  const [lin, sale, news] = later.map((m) => m.raw.id);
  if (!mailbox.labels.get(lin ?? '')?.some((l) => l.endsWith('sift/review'))) throw new Error('the pass with sift on did not leave Lin for the user');
  const archived = await lastStandingChange(db, ACCOUNT, sale ?? '');
  if (archived?.type !== 'archive') throw new Error('the pass with sift on did not archive the sale');
  await undo({ db, mailbox }, archived.id);
  if ((await lastStandingChange(db, ACCOUNT, news ?? ''))?.type !== 'archive') throw new Error('the pass with sift on did not archive the newsletter');
}
// Three rules written to the fake Gmail as filters, as the dashboard asks: the CI one lands; the Shop one
// lands and is then deleted in Gmail, which a check notices; Gmail does not answer for the news one.
// A rule added after the passes, so it decides nothing, that cannot be one (Gmail cannot mark spam).
await addRule(db, { match: { fromDomain: ['promo.example.com'] }, disposition: 'spam' }, 'user');
await writeRuleFilter({ db, mailbox, now: () => now - 3 * HOUR }, ordersRule, ACCOUNT);
mailbox.filters = [];
await checkRuleFilters({ db, mailbox, now: () => now - 150 * 60_000 }, ACCOUNT, false);
await writeRuleFilter({ db, mailbox, now: () => now - 2 * HOUR }, ciRule, ACCOUNT);
mailbox.createFilter = async () => {
  throw new Error('Gmail did not answer');
};
await writeRuleFilter({ db, mailbox, now: () => now - HOUR }, newsRule, ACCOUNT).catch(() => undefined);
// A second mailbox of the same person, with no mail (connected after the passes, so none comes to it), to remove; and a second person, who owns nothing yet and
// takes over the install when the first deletes their account. Neither can be signed in to here.
await connectAccount(store, WORK, '1', now - 23 * HOUR, user);
if (variant === '--inbox') {
  await setCanSend(db, ACCOUNT, true);
  await setMailboxAliases(db, ACCOUNT, ['me+lists@example.org']);
  // Copying the year part-way, as if Inbox had been turned on ten minutes ago with that much more in Gmail; the next pass begun finishes it.
  await startCopies(db, [ACCOUNT], { since: now - 365 * 24 * HOUR, before: now - 10 * 60_000, now: now - 10 * 60_000 });
  const copy = (await goingCopy(db, ACCOUNT))!;
  await advanceCopy(db, copy, { listed: 1240, next: 'p2', estimate: 8240 }, now);
}
// `--bare` takes the person's labels out, as before they chose any, so every screen is the setting-up steps.
if (variant === '--bare') for (const label of await listLabels(db)) if (label.id !== LEAVE_IN_INBOX) await removeLabel(db, label.id, now - 23 * HOUR);
await connectAccount(store, OTHER, '1', now - 22 * HOUR);
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
writeFileSync(
  gmailFile,
  JSON.stringify({ filters: { [ACCOUNT]: mailbox.filters }, labels: variant === '--inbox' ? { [ACCOUNT]: Object.fromEntries(mailbox.labels) } : {} }, null, 1),
);

// The same cookie `/auth/callback` sets (`signSession` in src/dashboard/server.ts), signed with this home's key.
const secret = randomBytes(32).toString('base64url');
writeSecret(config.dashboardKeyPath, secret, config.keys);
const body = Buffer.from(JSON.stringify({ e: ACCOUNT, p: user, x: now + 86_400_000 })).toString('base64url');
console.log(`${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`);
