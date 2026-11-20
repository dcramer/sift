---
name: verify-sift
description: Use before opening a pull request that touches web/ or app/, and whenever asked to look at the page, take a screenshot, check it at phone width, or see a dashboard change working. Launches a disposable, signed-in Sift dashboard seeded with synthetic mail and drives it in a headless browser, for AGENTS.md's "you looked at the page". Also after changing the dashboard's API, rules, labels, answers or triage output, or whenever a test passing is not proof enough.
---

# Verify Sift

`pnpm e2e` (`e2e/`) runs the same seed and server under Playwright, one copy per test: a change to what the seed leaves changes what those tests can expect.

Sift's surface is the dashboard (`web/`, served by `src/dashboard/server.ts`). Every `/api/` route needs a Google sign-in as a connected account, and there is no Gmail behind a scratch home, so this skill stands in for what Sift reaches outside the machine for, and nothing else: Gmail, at the `GmailApi` and `Mailbox` ports, the model that suggests labels, drafts rules and asks Inbox, and what Gmail would count in an inbox (`scripts/stand-ins.ts`, preloaded into the app's server, which takes them as `StandIns`, src/sift/sift.ts); and the sign-in, by minting the same `sift_session` cookie `/auth/callback` would set. The app is the real one, started as `sift run` starts it (`scripts/serve.ts`), on the build as it is.

`scripts/verify.sh` does all of it. Each run owns one directory; nothing is shared between runs, so several can run at once. Never point it at a real home (`~/.config/sift`) and never drive a dashboard this run did not start: the user's own Sift usually listens on 8787 and holds real mail.

## Launch

Prerequisite once per checkout: `pnpm install`.

```bash
V=.claude/skills/verify-sift/scripts/verify.sh
RUN=<scratchpad>/verify-sift/<short-name>   # a new directory per run
$V up "$RUN"
```

`up` seeds `$RUN/home`, picks a free port, builds the app (seconds, with Next.js's cache) and starts it on that port (`scripts/serve.ts`, which has no minute's tick, so a pass runs only when the page presses for one), runs the doctor, and signs the browser session in. It is ready when it prints `ok  pid …` and `browser session … signed in`. It refuses a directory that already has a `home/`. `up "$RUN" --bare` seeds the same, but takes the person's labels out, as before they chose any, so the dashboard is the setting-up steps (features/setting-up.md) until that run makes some. `up "$RUN" --on` then turns Sift on and runs one more pass over three new messages: `m22` from `lin@example.com`, which it cannot place, so it gets Sift's `sift/review` label in Gmail and Activity's Changed says `Asked you`; and `m23`, the Store's `Last day of the sale`, archived as Marketing and then undone; and `m24`, `Widgets, part three` from `digest@news.example.com`, archived as Newsletters by its rule, which stands, so Activity's Time saved and For review's empty page have something to count. `up "$RUN" --chatgpt` reaches the model through a ChatGPT plan (a made-up sign-in) instead of an API key. `up "$RUN" --inbox` has Inbox on before the passes, so they keep the text of all 21 messages (`mail_bodies`), leaves its copy of the last year part-way (Settings' Inbox: `Copying the last year`, `1,240 of about 8,240`) until a pass is begun, which finishes it since the stand-in Gmail lists nothing to copy, and hands the stand-in Gmail each message's labels (`INBOX`, `UNREAD`), so Inbox's archive, read and unread change it and the record; everywhere else the stand-in Gmail holds none of the seed's mail, and a change to one is skipped. Google lets Sift send from `me@example.org` (as itself or `me+lists@example.org`) and not from the work mailbox ([features/compose.md](features/compose.md)); mail sent goes nowhere but `$RUN/sent.json`. `--listing`, beside any of these, has the stand-in Gmail still listing any search of the inbox, for good (features/inbox-run.md).

What the seed leaves (through four real passes with Sift off, `workDue` in `tests/helpers.ts`, with a stand-in model that is sure `m8` is Marketing, places the code.example.com mail by its sender's name, and can place nothing else):

| Id | Sender | What places it | Shows as |
| --- | --- | --- | --- |
| `m1`, `m2` | `digest@news.example.com` | label rule → Newsletters | Activity only |
| `m3` | `orders@shop.example.com` | label rule → Receipts | Activity only |
| `m4` | `deals@promo.example.com` | nothing | For review, `Unlabelled` |
| `m5` | `builds@ci.example.org` | action rule → archive | Activity only |
| `m6` | `ada@example.org` | nothing | For review, `Unlabelled` |
| `m7` | `grace@example.net` | nothing | For review, `Unlabelled` |
| `m8` | `sale@store.example.com` | stand-in model → Marketing, confidence 0.95 | For review, `Marketing` (sure) |
| `m9`, `m10` | `alerts@ops.example.com` | the stand-in model answers unusably, three passes running; a fourth pass leaves them to the user | For review, `Unlabelled` |
| `m11`–`m13` | `billing@utility.example.net` | nothing; then each answered as Receipts but kept, as moving it back to the inbox in Gmail answers | Activity only; the three open a proposal, `Keep Receipts from billing@utility.example.net?` on For review. One conversation (`bills`), so Inbox folds it: `Utility 3`, `Your March bill` (`m11`) the newest, `Your May bill` (`m13`) the oldest, each with a Message-ID (`<march@utility.example.net>`, `<april@…>`, `<may@…>`) for a reply to carry |
| `m14`–`m21` | `notifications@code.example.com`, as Dependabot (3), Security alerts (2), github-actions[bot] (2) and Ada Lovelace (1) | stand-in model, by name → Notifications, Account alerts, Notifications; Ada's it cannot place | For review: one row per name, sure (`Agree: Notifications`): Dependabot's 3 folded into one (`3 messages`), github-actions[bot]'s 2 into another; Ada's as `Unlabelled`; the two Account alerts are kept, so not shown. The address's page lists the four names (`/sender/notifications%40code.example.com`) |

Three rules were written to the fake Gmail as filters, through the real `writeRuleFilter`, so their panels show a filter in each state: `anyone at ci.example.org` landed (`Gmail filter`); `orders@shop.example.com` landed and was then deleted in Gmail, which a check noticed (`Filter deleted in Gmail`); and Gmail did not answer for `anyone at news.example.com`, nor had it kept the filter when asked at once (`Gmail did not take the filter` in its panel's history). Only the first has the `Gmail filter` funnel on the list; the other two show their state only in their panels. `anyone at promo.example.com` → Spam, added after the passes, cannot be a filter, so its panel has no `Gmail filter` section. Each other rule's panel has the history. The seed leaves the fake Gmail's filters in `$RUN/gmail.json` (`filters`: `f1-@ci.example.org` alone; `labels`, each message's, only with `--inbox`), and the stand-in carries on from them: adding or removing a filter, and removing a rule (which first asks Gmail for its filter), run the real filter code against that fake, in every mailbox of the person, and write the file back, so it is where to check what Gmail would hold. Nothing else the dashboard sends to Gmail reaches it.

The promo → Spam rule decided nothing, but any rule added or changed later re-decides what is waiting, and then it catches Deals (`m4`): For review loses that row as well as whatever the new rule covers. Answering a message is not a rule change and does not do this.

The connected account is `me@example.org`, signed in as person 1 and their primary mailbox; they also have `me@work.example.org` (no mail, to remove). A second person, `bravo@example.net`, exists only in the database: there is no way to sign in as them here. Person 1 is the owner, with Sift off (`preferences.active` false) and Inbox off but for `--inbox` (`preferences.mail`), the sample labels (`SAMPLE_LABELS` in `tests/helpers.ts`, the set Sift once gave every mailbox) and Leave in inbox, 4 user rules. Its model is Anthropic, `claude-haiku-4-5`, with a made-up key, and the person has labels (theirs, for every mailbox), so the dashboard is not behind the setting-up steps. A pass is given no model, so nothing reaches Anthropic: the rule dialog's `Fill in the rule` asks the stand-in drafter (it looks up the words typed and archives mail from the first sender found), and `Suggest labels` its stand-in suggester (words naming pitches get a `Sales pitches` label, words naming builds a `Build results` label that digests, words naming receipts a note that Receipts and transactions covers them, words naming none of these an error), each with the real code around it. With Inbox on, Inbox's `Ask` looks up the words typed and narrows the list to the first sender found (`utility` gives `From: billing@utility.example.net`), searching for the words after `about` (`utility about ready` also puts `ready` in the search), or with neither says `Sift cannot tell which mail you have answered.` Inbox's search finds words in the text Inbox keeps: `1042` is only in the text of `Your order has shipped`. How far back Inbox keeps mail (`Keep how much of your mail?`, turning it on, and `Change…` while on) shows the stand-in's counts: about 8,200 messages in the last year, 22K in three, 47K in all. What going through the inbox would cost (Settings' `Your inbox`, and the dialog turning Sift on opens) is its stand-in for Gmail: 2,412 messages, 1,830 for the model, about $3.10 (300, 228 and $0.39 while setting up). A run started there waits for a model, which no pass is given, so it goes no further than `Reading your inbox · 0 found`. To see the connect step, sign it out from the page: `ab eval "fetch('/api/model/signout',{method:'POST',headers:{'content-type':'application/json','x-sift':'1'},body:JSON.stringify({provider:'anthropic'})})"`. Every message carries `dmarc=pass`; the three lists (news, promo, store) carry one-click unsubscribe headers. What Sift saw in each (`messages.facts`) is set up to show: `m6` (Ada) is a reply, `<thursday@example.org>` in thread `t6` answering `<lunch@example.org>`, and the owner has written to her (so she shows as someone you write to, once the model's pass has asked); `m7` (Grace) has an attachment; `m4` (Deals) went through Mailchimp, sends replies elsewhere, is in Promotions and has a tracking pixel and tracked links; `m8` (Store) is in Promotions. Attachments and tracking are known only because the stand-in model read those messages. `m4` is also the one message with an HTML part, held beside its text as a pass would hold it (in `scripts/seed.ts`: a remote image and background, inline styles, a link, a `javascript:` link, a meta refresh and a script); the other waiting mail is held as text alone, and mail not waiting on the user is not held at all.

The dashboard does not pick up code changes. After editing `src/`, `app/` or `web/src`, `down` and `up` a new directory.

## Doctor

```bash
$V doctor "$RUN"
```

Read-only. Passes only if this run's process is alive, the port answers as `me@example.org` with this home's signing key (so it is this instance and not another Sift), and `/api/` still refuses a request without the cookie. Its line ends with the commit and `+changes` when `src` or `web/src` differ from it. Run it first whenever anything looks off.

## Drive

```bash
$V ab "$RUN" open "http://127.0.0.1:$(cat "$RUN/port")/"
$V ab "$RUN" snapshot -i          # interactive elements with refs (@e12)
$V ab "$RUN" find role button click --name "Add a rule"
$V ab "$RUN" press j               # page keys work: J/K move through a list, / searches, ? lists every key
```

`ab` is agent-browser (`npx agent-browser@0.39.2`) in this run's own browser session; any agent-browser command works after it (`agent-browser skills get core` for the full set). Use `127.0.0.1`, which is where the cookie was set, not `localhost`.

Find elements by role and accessible name, not refs or CSS: refs change on every snapshot. `--name` matches part of a name, so `Make a rule` finds `Make a rule…`, a toast's `Undo` finds `Undo Z` (a control with a key has its keycap in its name), and `Remove` finds every `Remove …`; add `--exact` for one. The names the page uses are in [features/](features/README.md). Routes: `/` (For review), `/inbox` (while Inbox is on; a conversation open is `?message=<newest>&thread=<thread>`), `/contacts`, `/activity`, `/labels`, `/rules`, `/rules/<id>` (a rule's panel), `/labels/<id>`, `/sender/<address>`, `/domain/<domain>`, and `/system` (the design-system specimen, no sign-in). An open message is `?message=<id>` on any route, and Settings `?settings=1`.

Phone width: `$V ab "$RUN" set viewport 390 844`. AGENTS.md asks what every part does on a phone.

`snapshot` does not print `aria-pressed`, so a standing that is on (`Trust`, `Unwanted`, `Block` on a sender's page) looks like the others. Read it with `$V ab "$RUN" eval "JSON.stringify([...document.querySelectorAll('[aria-pressed]')].map(b=>[b.textContent,b.getAttribute('aria-pressed')]))"`.

Every row on Rules has a `Remove` of the same name. Open a rule's panel by its first cell (`ab find role cell click --name "anyone at ci.example.org"`, which goes to `/rules/<id>`), where `Remove` is its own; it asks `Remove this rule?` in place, and the confirming press needs `--exact`, as `Remove filter` also matches `Remove`.

Add as a Gmail filter is offered only while Sift is on: Settings (`?settings=1`), `Turn on`, then `Turn on` again to confirm. It is safe here: what a pass carries out goes to the stand-in Gmail, which holds no mail, so nothing is changed.

Adding a rule with `Apply to mail already there` checked (the default for an action rule) opens `Apply to your inbox`. Its count is the stand-in's: `About 1,200` and `Found in Gmail 1` to `5`, whatever the rule. Pressing it (`Archive all` and the like) begins a Workflow run for each mailbox, whose search of the stand-in Gmail finds nothing, so it finishes at once, though the rule's panel shows `Finding them in Gmail · 0 so far` until its next look, about fifteen seconds; started with `up "$RUN" --listing`, the search is still being listed for good, and the panel stays there until `Stop`. The rule is already added by then.

Stored state, read-only: `$V sql "$RUN" "SELECT … FROM rules"`, from a copy of the database (`home/database`, PGlite), read as its owner, so every person's rows show. Tables worth checking: `decisions`, `rules`, `examples`, `feedback` (joined by `decision_id`), `actions`, `labels`, `proposals`, `read_bodies`, `rule_drafts`. Filter by `user_id = 1` where Bravo's rows would mix in (Bravo has a Leave in inbox of their own). Labels are the person's, keyed by `(user_id, id)`, and a removed one keeps its row with `removed_at` set, so add `removed_at IS NULL` for the ones in use. What names a sender or came from mail is sealed (src/store/content.ts): a message's `headers`; a decision's `reason`; a rule's `match`, `except_matches` and `name`, and its filter's `written` (`rule_filters`, one row a mailbox); a proposal's `match`; an action's `payload`; a label proposal's `goal`, `labels` and `note`; a rule draft's `goal` and `rule`; and the text and HTML in `examples` and `suggestion_bodies`. The seed sets no `SIFT_KEY`, so these are stored as `sift-plain:` and the value, readable in SQL (`SELECT rule FROM rule_drafts`); with a key they would be ciphertext. Still prove them on the screen that reads them back (the Rules list, a rule's panel at `/rules/<id>`). A query error prints `sql: <message>` and exits 1.

## Evidence

Write everything into `$RUN/evidence/`; `down` keeps it. For each feature proved, capture:

1. A snapshot or screenshot before the action and after it (`$V ab "$RUN" screenshot "$RUN/evidence/<feature>-after.png"`, `$V ab "$RUN" snapshot > "$RUN/evidence/<feature>-after.txt"`).
2. `$V ab "$RUN" console` and `$V ab "$RUN" errors`, both empty. A hydration mismatch appears only here, never in the build.
3. The stored side effect, from `sql`, and a second view that reads it back (the Rules screen after an answer, the Labels screen after a label edit). For a Gmail filter, also `$RUN/gmail.json` and its `filter` or `unfilter` row in `actions`.
4. `SELECT count(*) AS n FROM actions WHERE type NOT IN ('filter', 'unfilter')` is still `0`. Sift is off here; a row there means something tried to change a mailbox. Filter rows are the seed's and any the run made; with `--inbox`, so are the reader's own presses (`archive`, `read`, `unread`) and `send`.

Do the action the way a user does: press the control, not a POST with curl. The API is the page's private contract; calling it directly proves the server, not the screen. Seeding is the only place internals are used, and it uses the real pass (`runWork`, src/work/run.ts).

## Cleanup

```bash
$V down "$RUN"
```

Closes this run's browser session, stops the process by the pid `up` recorded, deletes `home/` and `gmail.json`, and keeps `$RUN/evidence/`. Run it after a failed attempt too. Never `pkill -f` a pattern: it matches the shell running it, and other sessions' instances.

## Upkeep

A SessionStart hook (`.claude/settings.json`) runs `scripts/maintain-check.sh`. When `app/`, `web/src`, `public/`, `src/dashboard`, `src/cli`, `src/store`, `src/work`, `src/sift` or `tests/helpers.ts` changed on `origin/main` since the last audit, the session is told to offer `/pstack:maintain-verification-skill`. It speaks at most once a day per machine, and never runs the pass itself. It reads local refs only, so it knows only as much of main as the last fetch.

After a maintenance pass ends clean or changed, record it, or tomorrow's first session asks again:

```bash
.claude/skills/verify-sift/scripts/maintain-check.sh --audited <the origin/main commit the pass covered>
```

State is in `~/.cache/sift-verify-maint/`. Delete `suggested-on` there to see today's prompt again.

## What this cannot show

- Anything else that talks to Google: sign-in itself, connecting another account, what `Apply to your inbox` finds and does, undo of a real change. They fail with `Sift has no access to me@example.org.`; that failure is not the change's fault.
- Gmail itself: the fake's filters are whatever the filter code asked for. Whether Gmail accepts a filter, and what it does to mail, is for `tests/filters.test.ts` and a real account.
- The model tier: the seed's stand-in model never calls a provider and places only `m8` and the code.example.com mail it knows by name, so every other unmatched message is "Unlabelled". With no model at all such mail would wait undecided and not be a suggestion, and every screen would be the setting-up steps. The rule and label stand-ins are fixed answers too: what they fill in proves the dialogs and the code around the model, not what a model would choose.
- Sending: the stand-in Gmail writes what it was asked to send to `$RUN/sent.json` and answers as Gmail would, with no one receiving it.
- Changing Gmail. Settings can turn Sift on (`preferences.active`), and a press begins a pass, but the stand-in Gmail holds no mail (with `--inbox`, only its labels, for the reader's own presses), so nothing a pass decides is carried out. Prove the executor with tests (`tests/actions.test.ts`, `tests/run.test.ts`).
- Mail answered that Sift did not hold the text of: its example stays `pending` until a pass reads it from Gmail, which the stand-in cannot give. An answer to waiting mail moves its held text into the example (`captured`), as the seed's three bills show.
