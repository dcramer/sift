# Rules from a shortcut

Wherever Sift offers to make a rule outside the Rules screen, the press opens the rule dialog in place, started on everything that place knows, so the user sees and can change the rule before adding it. It opens on `What should it do?` with that rule already said in words; `Write it yourself` shows the form, filled in the same. Nothing else makes a rule in one press: a standing does, since it is only an address or domain and what happens to their mail. Closing the dialog changes nothing.

## Sub-features

- `shortcut-proposal`: For review's proposal line (`Keep Receipts from …?`). `Make a rule…` opens the dialog on the proposal's sender, waiting for its label (`Only when it is this label`), then doing what the user has been doing; adding resolves the proposal, whatever the user changed; closing the dialog leaves it. `Dismiss` is one press and makes no rule.
- `shortcut-message`: the reader's `Make a rule…` (`Rule…`, beside the answer), on the sender and the label the message has; and `Keep as <label>…` under Why, on the sender once a model gives that label, keeping it.
- `shortcut-fact`: a `What Sift saw` row's `Rule…`, on the sender and that fact, or on the list (see message-facts.md).
- `shortcut-standing`: `Trust`, `Unwanted`, `Block` (the group `Where <name> stands`) on a sender's or domain's page add, in one press, a rule for that address or domain: `Leave in inbox` for Trust, or no label and `Archive` or `Spam`. A toast is titled by the rule in words, then `Rule added` (or `Rule replaced`), with `Undo` (Z) and, for Unwanted and Block, `Apply to inbox…`. It replaces another standing, which Undo gives back; when their own rule says more (a label), the press opens the dialog instead. Pressing the standing that is on takes it back in one press.
- `shortcut-sender`: a sender's page's own `Make a rule…` beside `Where <name> stands`, on that address and its label; under `Names` (an address several names write from), one per name, on the address and that name; under `What it is` (one name, mail under more than one label), one per label.
- `shortcut-replaces`: when the dialog's conditions are exactly those of a rule already there, a `Replaces` line names what that rule says, and adding replaces it.

## How to get to it (user POV)

- For review, the line above the list.
- Any message, `Make a rule…` beside the answer or `Rule…` beside what Sift saw.
- A sender's name anywhere, then `Where <their name> stands` on their page; or the domain linked from it.

## Driving it with verify.sh

Preconditions:

- Fresh seed. For review shows `Keep Receipts from billing@utility.example.net? You kept the last 3, but the label archives them.`

- **Open on a proposal.** `ab open "$B/"`, `ab find role button click --name "Make a rule…"`. Add a rule opens over For review, `What should it do?` reading `Mail from billing@utility.example.net, once it is Receipts: leave it in the inbox.` `ab find role button click --name "Write it yourself"`: `Condition 1` reads `from`, `Value 1` `billing@utility.example.net`, `Only when it is this label` `Receipts`, `What happens to it` `Keep`, and a line says `A model reads each message it matches to tell.`
- **Close.** `ab press Escape`. The line is still there; `verify.sh sql "$RUN" "SELECT status FROM proposals"` is `open`.
- **Change and add.** `Make a rule…` again, `Write it yourself`, `ab find role textbox fill "utility.example.net" --name "Value 1"`: the hint reads `Mail from anyone at utility.example.net.` `ab find role button click --name "Add rule" --exact`. A toast reads `Mail from utility.example.net, once it is Receipts: leave it in the inbox` `Rule added`, the rule's panel opens at `/rules/<id>?apply=1` (but the rule moves nothing, so `Apply to your inbox` does not open), and the line is gone. `SELECT status FROM proposals` is `accepted`; `SELECT label_id, when_label, disposition, source FROM rules ORDER BY created_at DESC LIMIT 1` is null, `transactional`, `keep`, `user`. Rules has the row `anyone at utility.example.net as Receipts` with `Leave in inbox`.
- **From a message.** `ab open "$B/?message=m8"`, `ab find role button click --name "Make a rule…"`. The words read `Mail from sale@store.example.com is Marketing.`; `Write it yourself` shows `Value 1` `sale@store.example.com` and `Label it as` `Marketing`; the address still has `?message=m8`. `ab press Escape`. `ab find role button click --name "Keep as Marketing"`: `Mail from sale@store.example.com, once it is Marketing: leave it in the inbox.` `ab press Escape`.
- **From a fact or a list.** On `?message=m4`, `ab find role button click --name "Make a rule for mail that came through a mailing list"`, then `Write it yourself`: `Condition 1` reads `on the list`, `Value 1` `promo.example.com`, `What happens to it` `Archive`. `ab press Escape`.
- **A standing.** `ab open "$B/sender/ada%40example.org"`, `ab find role button click --name "Trust"`. No dialog: a toast reads `Mail from ada@example.org: leave it in the inbox` `Rule added`, with `Undo` and no `Apply to inbox…`, and `Trust` is pressed (read `aria-pressed`, SKILL.md). `SELECT id, label_id FROM rules ORDER BY created_at DESC LIMIT 1` is `everything_else` (note the id). `Block`: the toast reads `Mail from ada@example.org: send it to spam` `Rule replaced`, with `Apply to inbox…`, `Block` is pressed and `SELECT disposition FROM rules WHERE id = '<id>'` is `spam`. `Undo`: `Trust` is pressed again, the same id with no disposition. `Trust` again: none of the three is pressed, and `SELECT count(*) AS n FROM rules WHERE id = '<id>'` is `0`.
- **A standing over a rule that says more.** `ab open "$B/sender/orders%40shop.example.com"`, `Block`: the dialog opens on `Mail from orders@shop.example.com: send it to spam.`; `Write it yourself` shows `Replaces` `Receipts`. `ab press Escape`: nothing is pressed.
- **A sender's page.** `ab open "$B/sender/notifications%40code.example.com"`. Five `Make a rule…`: the first, beside the standing, reads `Mail from notifications@code.example.com is Notifications.`; under `Names`, Dependabot's reads `Mail from notifications@code.example.com named “Dependabot” is Notifications.` Find each by its ref from `ab snapshot -i` (the names are the same). `What it is` shows on no seeded sender: answer the two Ops alerts with different labels (answer-suggestion.md), then on `/sender/alerts%40ops.example.com` its rows' `Make a rule…` read `Mail from alerts@ops.example.com is <label>.`
- **A domain.** `ab open "$B/domain/promo.example.com"`. `Block` is already pressed: the seed's `anyone at promo.example.com` → Spam is the domain's standing, so pressing `Block` would take it back. `Unwanted`: the toast reads `Mail from promo.example.com: archive it` `Rule replaced`, `Unwanted` is pressed and `Block` is not. `Undo`: `Block` again.
- **Phone.** `ab set viewport 390 844`. The proposal line's text wraps above its two buttons; the dialog covers the screen, the form in its three parts with labels above their controls. `ab eval "document.documentElement.scrollWidth - document.documentElement.clientWidth"` is `0`.
- After all of it, no `actions` row but the seed's filters, and `ab console` and `ab errors` print nothing.

## Gotchas

- Several buttons share the name `Make a rule…` (the proposal line, the panel, every row of a sender page), and an open panel hides the ones behind it. On a sender page, take refs from a fresh `ab snapshot -i`.
- A rule that moves mail opens `Apply to your inbox` after `Add rule`, because `Apply to mail already there` is ticked by default; press `Cancel`, or it moves the mail it found in Gmail.
- Any rule added re-decides everything waiting, so the seed's promo → Spam rule takes Deals off For review on the first one.
