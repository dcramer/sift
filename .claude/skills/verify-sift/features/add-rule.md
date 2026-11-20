# Add a rule

On the Rules screen the user says the rule they want in their own words, and the model fills in the form, looking up the senders they name; or they write it themselves: a condition, then what it says (an action, a label, or an action for mail Sift says is a given label). Either way they see the rule before adding it. Mail already waiting that the rule now covers stops being a suggestion.

## Sub-features

- `rule-describe`: the dialog opens on `What should it do?`; `Fill in the rule` asks the model, which fills in the form below, with a `Not in this rule` note for what it left out. `Write it yourself` goes to the empty form; `Describe it instead` comes back.
- `rule-mail` is one list of lines (`Condition 1`, `Value 1`, `Remove condition 1`, …; `Add a condition` adds a line of the kind before it). A line's kind is `from`, `named`, `name contains`, `on the list`, `sent to` or `subject contains`, with a value, or an answer about what Sift saw in the message (see message-facts.md), with none. Lines of one kind are alternatives; different kinds must all hold. `from` takes an address or a domain. The hint says `Only this address` for one address, and reads the rule back (`Mail from … or from anyone at …`) once there is a domain or more than one value.
- `rule-name` is optional (`Name`); once one is typed, its hint says `Rules and Activity say this in place of the conditions.`
- `rule-label` chooses `Label it as` (`Leave in inbox` first and set apart, the labels, then `No label, just act`); `Only when it is, in your words` narrows a label rule; `Only when it is this label` (`Any label`, or a label) makes the rule wait for a model to give the mail that label.
- `rule-action` chooses `What happens to it` (`Archive`, `Spam`; `Keep` too for a rule that waits for a label), with `Mark it read` and `Unsubscribe, when the sender offers a safe way`. With `Leave in inbox` as the label nothing is asked here: it keeps, and moves nothing.
- `rule-add` adds it to the list; waiting suggestions it covers are re-decided. A rule with exactly the conditions of one already there (no exceptions, waiting for no label) replaces it; the dialog shows `Replaces` with what that rule says.
- `rule-remove` removes a rule from its row.

## How to get to it (user POV)

- Rules, then `Add a rule`.
- Remove: the `Remove` button on a rule's row.

## Driving it with verify.sh

Preconditions:

- Fresh seed (counts in [README.md](README.md)). For review has a row from `deals@promo.example.com`; Rules has, among others, `anyone at promo.example.com` → `Spam`.

- **Open the dialog.** `ab open "$B/rules"`, then `ab find role button click --name "Add a rule"`. It opens on `What should it do?` with `Fill in the rule` disabled and `Write it yourself`.
- **Describe it.** `ab find role textbox fill "Archive the deals from promo" --name "What should it do?"`, `ab find role button click --name "Fill in the rule"`. The form replaces the question, in three parts, `Which mail`, `What it is` and `What happens`: `Condition 1` `from`, `Value 1` `deals@promo.example.com` with the hint `Only this address.`, `Label it as` `No label, just act`, `What happens to it` `Archive`, `Mark it read` checked, and above it all a `Not in this rule` note, `Add another rule for grace@example.net.` (the stand-in names the second sender its look-up found; SKILL.md). `verify.sh sql "$RUN" "SELECT model, lookups, error, rule FROM rule_drafts"` is one row, `faux/stand-in`, `1`, null, and the rule as filled in.
- **Or write it yourself** (instead of describing it). `ab find role button click --name "Write it yourself"`: the same form, empty, with `Add rule` disabled; `Condition 1` reads `from`, `Label it as` `No label, just act`, `What happens to it` `Archive`. `ab find label "Value 1" fill "deals@promo.example.com"`: the hint reads `Only this address.` and `Add rule` is enabled. Steps below hold either way, but `Then` reads `Archive, marked read` only for the described one.
- **Several values, and a name** (instead of the value above). `Value 1` `example.com`, `Add a condition`, `Value 2` `shop@example.net`, `Add a condition`, `Condition 3` → `subject contains`, `Value 3` `receipt`, `Name` `Shop receipts`. The hint reads `Mail from shop@example.net or from anyone at example.com, with a subject containing “receipt”.`; once added the list's row reads `Shop receipts → Archive`.
- **Add.** `ab find role button click --name "Add rule" --exact`. A toast reads the rule in words, then `Rule added` (with `Undo Z`) and, because `Apply to mail already there` was left ticked and the rule archives, `Apply to your inbox` opens over the list with what Gmail's search found (`In your inbox` `1`, `48 hours only: 30% off`, `Archive 1`). Press `Cancel`. The new rule's panel is open: `Matched, 30 days` `1` over a chart of the last 30 days, `Then` `Archive`, and `Still in your inbox` `1` lists `48 hours only: 30% off` (decided, not moved: Sift is off). `Close`: the list has `deals@promo.example.com` above `anyone at promo.example.com`.
- **Effect on what is waiting.** `ab open "$B/"`. The link's count is one fewer and there is no Deals row.
- **Stored.** `verify.sh sql "$RUN" "SELECT disposition, label_id, source, hits FROM rules ORDER BY created_at DESC LIMIT 1"` returns `archive`, null, `user`, `1`; `SELECT count(*) AS n FROM rules` is one more than before; `SELECT stage, disposition FROM decisions WHERE message_id = 'm4' ORDER BY id DESC LIMIT 1` is `rules`, `archive`: the new rule is stored after the Spam one, and wins because an exact sender is more specific than a domain. Rules lists it above the Spam rule because the list sorts by decisions. No `actions` row but the seed's filters.
- **Remove.** `ab open "$B/rules"`, `ab find role cell click --name "deals@promo.example.com"`, `ab find role button click --name "Remove"`: the panel asks `Remove this rule?`. `ab find role button click --name "Remove" --exact`. The panel closes and the row is gone; `SELECT count(*) AS n FROM rules` is back to what it was. It had no filter, so Gmail's filters in `$RUN/google.json` are unchanged and `actions` has no `unfilter` row.

## Gotchas

- The dialog has no Cancel: close it with `Close` (top right) or `Escape`.
- Adding the described rule is a rule change like any other: describe one that does not cover Deals (`Archive the weekly digest`) and add it, and Deals goes to the seed's promo → Spam rule, so a Deals rule added after it decides nothing.
- `Fill in the rule` here is the stand-in drafter (SKILL.md), so what it fills in proves the dialog and the drafting around the model, not what a real model would choose.
- Making a rule a Gmail filter needs Sift on, and goes to the fake Gmail here: [gmail-filter.md](gmail-filter.md).
- A model whose rule cannot be used is told why and asked once more, as is one that answers in words; then the describe step shows `The model could not fill in a rule (…). Try again, or fill it in yourself.` The stand-in always fills in a usable rule, so that is `tests/rule-drafts.test.ts`'s to prove.
- `anyone at promo.example.com` has exactly the conditions of the seed's Spam rule, so adding it replaces that rule (`Replaces` in the dialog) and the count stays the same. Use an address with no rule to prove adding.
- Removing a rule asks Gmail for its filter first, even with none recorded; here the fake answers (SKILL.md). Removing one that is a filter is in [gmail-filter.md](gmail-filter.md).
- Every row's `Remove` has the same name, so remove from the rule's panel, not the list.
