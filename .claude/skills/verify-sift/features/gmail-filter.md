# A rule as a Gmail filter

A rule Gmail can run itself can be added to Gmail as a filter, so its mail is handled without Sift. Each rule's panel says whether it is a filter and what happened to it there. Nothing is flagged on the Rules list: a filter Gmail did not take is asked for again, and one deleted in Gmail is the user's choice.

## Sub-features

- `filter-state`: `Gmail filter` on a rule's panel: `Gmail runs this rule itself, as one of your Gmail filters…`, `Its Gmail filter was deleted in Gmail. Sift will not put it back.`, `Once Sift is on, Gmail could run this rule itself…`; with its history (`Filter added`, `Filter removed`, `Filter deleted in Gmail`, `Gmail did not take the filter`). A rule that can never be a filter and has none has no `Gmail filter` section.
- `filter-remove`: `Remove filter` on a rule that is a filter; the rule stays.
- `filter-add`: `Add as a Gmail filter…`, only while Sift is on, then `Add it to Gmail as a filter?` and `Add to Gmail`.
- `filter-rule-remove`: removing a rule that is a filter takes the filter out first.

## How to get to it (user POV)

- Rules, a rule's row, then `Gmail filter` in its panel.
- Settings, `Active`, `Turn on`, before Add as a Gmail filter is offered.

## Driving it with verify.sh

Preconditions:

- Fresh seed. Gmail holds one filter, in `me@example.org`, from `@ci.example.org` (`jq -c '.mailboxes[] | {address, filters}' "$RUN/google.json"`). Rules shows a funnel only on `anyone at ci.example.org`, and nothing in red. The news rule's panel history ends `Gmail did not take the filter`, muted; the shop rule's `Filter deleted in Gmail`, in ink like `Filter added`; neither red.

- **Remove filter.** `ab open "$B/rules"`, `ab find role cell click --name "anyone at ci.example.org"`. `Gmail filter` reads `Gmail runs this rule itself, as one of your Gmail filters…` `ab find role button click --name "Remove filter"`. A toast reads `Gmail filter removed`; `Gmail filter` reads `Once Sift is on, Gmail could run this rule itself…` with `Filter removed` in its history. `$RUN/google.json` has no filters; `SELECT type, status FROM actions ORDER BY id DESC LIMIT 1` is `unfilter`, `done`; the rule is still there.
- **Turn Sift on.** `ab open "$B/?settings=1"`, `ab find role button click --name "Turn on" --exact`; it asks `Archive, label and mark spam on new mail by itself?`; `ab find role button click --name "Turn on" --exact` again. `Go through your inbox?` opens (inbox-run.md): `ab find role button click --name "Not now"`. `Active` reads `On`; `SELECT active FROM preferences` has `true` for person 1.
- **Add as a Gmail filter.** Back on the ci rule's panel, `ab find role button click --name "Add as a Gmail filter…"`. A dialog `Add it to Gmail as a filter?` says mail the filter archives never reaches Sift. `ab find role button click --name "Add to Gmail" --exact`. `Gmail filter` reads `Gmail runs this rule itself…`, its history ends with two `Filter added`, and `$RUN/google.json` holds the filter under both `me@example.org` and `me@work.example.org`: a rule is the person's, so its filter goes to each of their mailboxes. `SELECT type, status, account_id FROM actions ORDER BY id DESC LIMIT 2` is `filter`, `done` for each.
- **Remove the rule.** `ab find role button click --name "Remove" --exact` (the panel also has `Remove filter`), wait for `Remove this rule?`, then `ab find role button click --name "Remove" --exact` on `Remove this rule?`. The row is gone, `$RUN/google.json` has no filters in either mailbox, and the two newest `actions` rows are `unfilter`, `done`, one a mailbox.
- After all of it, `SELECT count(*) AS n FROM actions WHERE type NOT IN ('filter', 'unfilter')` is `0`, and `ab console` and `ab errors` print nothing.

## Gotchas

- The fake Gmail takes every filter it is asked for and never deletes one on its own; the seed's news and shop states were made in the seed and cannot be made again from the page.
- Removing a rule is a rule change, so For review re-decides and Deals goes to the seed's promo → Spam rule (SKILL.md).
- A rule with a fact condition or a Spam action cannot be a filter; its panel has no `Gmail filter` section and does not say why.
