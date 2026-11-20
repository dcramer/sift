# Go through the inbox, apply a rule to it

Mail already in the inbox when Sift starts, or when a rule is added, is not looked at by itself. The user can have Sift go through the inbox from Settings, after seeing what it would cost, or apply one rule to the mail it covers there. Either is a run in the background, one for each mailbox, that the user can stop.

## Sub-features

- `inbox-go`: Settings' `Your inbox` (`21 messages. Going through them costs about $0.06.`), `Go through…`, then `Go through your inbox?` with `In your inbox`, `Need the model`, `About` and the model, and `Go through 21` or `Not now`. The same dialog opens after turning Sift on.
- `inbox-progress`: while it runs, Settings' section is `Going through your inbox`, `Reading your inbox · N found`, with `Stop`; once stopped, `Stopped after N messages … · $N` and `Go through again…`.
- `apply-rule`: `Apply to inbox…` on a rule's panel (and `Apply to your inbox`, opened after adding a rule that moves mail): `In your inbox` `About N`, the newest it found, and the press named by the action (`Archive all`, …) or `Cancel`.
- `apply-progress`: the panel's `Still in your inbox` shows `Finding them in Gmail · N so far` with `Stop` while the run goes, then `Apply to inbox…` again.

## How to get to it (user POV)

- Settings (`?settings=1`), `Your inbox`, `Go through…`; or Settings, `Turn on` twice.
- Rules, a rule that archives or marks spam, `Apply to inbox…`; or `Add rule` with `Apply to mail already there` ticked.

## Driving it with verify.sh

Preconditions:

- Fresh seed. For the run that stays under way until stopped, start it with `verify.sh up "$RUN" --listing`.

- **Go through.** `ab open "$B/?settings=1"`, `ab find role button click --name "Go through…"`. `Go through your inbox?` reads `In your inbox` `21`, `Need the model` `15`, `About` `$0.06` `on claude-haiku-4-5`. `ab find role button click --name "Go through 21"`: Settings shows `Going through your inbox`, `Reading your inbox · 0 found` and `Stop`, and stays there (no pass is given a model).
- **Stop it.** `ab find role button click --name "Stop"`. `Your inbox` reads `Stopped after 0 messages just now · $0` with `Go through again…`. `verify.sh sql "$RUN" "SELECT account_id, stopped, finished_at IS NOT NULL AS done FROM inbox_runs WHERE rule_id IS NULL"` is one row a mailbox, `me@example.org` and `me@work.example.org`, each `true`, `true`.
- **Apply a rule.** `ab open "$B/rules"`, `ab find role cell click --name "anyone at ci.example.org"`, `ab find role button click --name "Apply to inbox…"`. `Apply to your inbox` reads `anyone at ci.example.org → Archive`, `In your inbox` `1`, and `Build failed on main` under `Newest`. `ab find role button click --name "Archive 1"`: the panel's `Still in your inbox` shows `Finding them in Gmail · 0 so far` and `Stop`. `SELECT rule_id, listed, finished_at IS NOT NULL AS done FROM inbox_runs WHERE rule_id IS NOT NULL` is one row a mailbox, each finished within a second; the panel catches up at its next look, about fifteen seconds, and shows `Apply to inbox…` again. Settings' `Check now` then carries it out: Gmail's `m5` loses `INBOX` (`$RUN/google.json`), and `actions` has its `archive`.
- **Stop applying.** In a `--listing` run, a rule from `sale@store.example.com` finds `About 1,200` (`Winter sale starts now`, then `Found in Gmail 1` to `4`) and `Archive all`; pressed, Gmail answers the first page of its search and never the second, so the panel stays at `Finding them in Gmail · 500 so far` (after a reload), and `me@example.org`'s run keeps `finished_at` null. `ab find role button click --name "Stop"`: the panel shows `Apply to inbox…` again, and `me@example.org`'s run is `stopped` (the work mailbox's, with nothing to find, had finished).
- `SELECT type FROM actions WHERE type NOT IN ('filter', 'unfilter')` holds only the applied rule's `archive`, and `ab console` and `ab errors` print nothing.

## Gotchas

- Every count here is the fake Gmail's (SKILL.md), which counts exactly where Gmail estimates. Whether the run finds and moves the right mail in a large mailbox is for `tests/run.test.ts` and a real account.
- A rule that moves nothing (one that leaves mail in the inbox) offers no `Apply to your inbox` after adding.
