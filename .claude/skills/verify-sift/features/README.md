# Sift verification map

The maintained recipes for proving what a dashboard user sees and does. Read this, then the feature file for what changed.

## Baseline preconditions

- A run started with `verify.sh up "$RUN"` in a new directory, and `verify.sh doctor "$RUN"` printing `ok`.
- The seed as SKILL.md describes it: account `me@example.org` with a second, empty mailbox `me@work.example.org`, and a second person `bravo@example.net` who cannot be signed in to; Sift off, Anthropic in use with a made-up key (the seed judged its mail with a stand-in model, and `Fill in the rule` asks another; SKILL.md); 12 messages (the link counts messages) in 9 rows: first the two Ops alerts (`Replica lag on db-3`, `Disk 91% full on db-2`) as `Unlabelled`, left to the user after the model failed on them; then, oldest first, Ada Lovelace (`Re: Fix the release script (#412)`, from `notifications@code.example.com`) as `Unlabelled`; github-actions[bot] (`2 messages`) and Dependabot (`3 messages`), each folded into one row, as `Notifications`; Store (`Winter sale starts now`) as `Marketing`; Grace Hopper, Ada Lovelace (`Lunch on Thursday?`) and Deals (`48 hours only: 30% off`, last) as `Unlabelled`; one proposal (`Keep Receipts from billing@utility.example.net?`, from three of its bills kept in the inbox); 4 user rules, among them `anyone at promo.example.com` → Spam, which catches Deals at the next rule change; the sample labels and Leave in inbox, the person's, for both mailboxes.
- These counts move as the product does; recipes say how a count changes (`one fewer`), so only this line needs updating when the seed's result changes.
- `B=http://127.0.0.1:$(cat "$RUN/port")`, and `ab` below means `verify.sh ab "$RUN"`.
- Never drive an instance this run did not start.

## Driving conventions

- Start each recipe from a fresh seed unless it says otherwise. Recipes change rules and labels, so two in one run interact: any rule change re-decides everything waiting.
- Find by role and accessible name (`ab find role button click --name "Agree: Marketing"`). Table rows have no name to find by. Open a suggestion by its subject cell, `ab find role cell click --name "<subject>"`; a folded row's cell reads `3 messages` and then each subject, and `--name` matches part of a name, so any one of them finds it. `find text` on a subject reaches the hidden phone copy and fails. Open a label with `ab find text "<label name>" click --exact`.
- Pick from a combobox with two steps: `ab find role combobox click --name "<combobox>"`, then `ab find role option click --name "<option>"`.
- After every action, wait for the result you expect to see, not a fixed time.

## Proof and skip reporting

- Before and after: a snapshot or screenshot of the state the action changed, in `$RUN/evidence/`.
- `ab console` and `ab errors` empty after the journey.
- The stored row, via `verify.sh sql`, and a second screen that shows it.
- `SELECT count(*) AS n FROM actions WHERE type NOT IN ('filter', 'unfilter')` is `0` (the filter rows are the seed's).
- A rule's conditions are sealed, stored here as `sift-plain:` text: read them on Rules or the rule's panel as well as in SQL (SKILL.md, Drive).
- Name the feature and entry point with each artifact. An entry point not driven is reported as not verified, not covered by another.

## Feature entry contract

An H1 and one paragraph of what the user gets, then four H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.sh`, `Gotchas`. The driving section starts with `Preconditions:` and pairs each user action with its command and what should be visible after it. User paths and handles only, no implementation.

## Features

- [Contacts](./contacts.md): everyone who writes, what Sift does with their next mail and where they stand, and each one's page.
- [Agree with a suggestion](./agree-suggestion.md): press the check beside the label Sift gave a row.
- [Answer a suggestion](./answer-suggestion.md): teach Sift what a waiting message is, and the rule that makes.
- [Add a rule](./add-rule.md): a rule made on the Rules screen, and its effect on what is waiting.
- [Rules from a shortcut](./rule-shortcuts.md): every other press that makes a rule opens the rule dialog in place, started on what that place knows: a proposal, a message, a fact; and a standing, given in one press with Undo.
- [A rule as a Gmail filter](./gmail-filter.md): whether a rule is a filter in Gmail, adding and removing one, and removing a rule that is one.
- [Edit a label](./edit-label.md): change what a label does, add labels, suggested or by hand, and remove one.
- [Setting up](./setting-up.md): the steps shown until a model is in use and the person has labels.
- [Read a message as its HTML](./message-html.md): the Text and HTML choice in the reader, and that nothing remote loads.
- [What Sift saw in a message](./message-facts.md): the facts shown on an opened message, rules on them, and lists narrowed by them.
- [Remove a mailbox, delete the account](./remove-mailbox.md): what Sift holds about a mailbox, or a whole person, goes.
- [Go through the inbox, apply a rule to it](./inbox-run.md): a run over mail already in the inbox, from Settings or a rule, and stopping it.
- [Write and send mail](./compose.md): the composer, for new mail and replies, with Inbox on.
