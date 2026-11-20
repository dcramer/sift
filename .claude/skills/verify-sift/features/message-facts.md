# What Sift saw in a message

An opened message lists what Sift saw in it that the reader can use (a mailing list, a one-click unsubscribe, a reply, attachments, a tracking pixel), each in the words of the rule condition it makes. A rule can carry those conditions, and For review and Activity can be narrowed by a few of them.

## Sub-features

- `facts-panel`: the reader's `What Sift saw` section, beside the message (under it on a phone); each row with a `Rule…` press (named `Make a rule for mail that …`) that opens Add a rule over the reader, started on the sender and that fact, or on the list.
- `facts-rule`: in Add a rule, a line under `Which mail` can be an answer about what Sift saw (a `Condition N` whose value is `is in Promotions`, `has a one-click unsubscribe`, …; `Remove condition N` beside it). With only those, the mail is `From anyone.`
- `facts-rules-list`: a rule's facts read after its sender on Rules: `mail that is in Promotions`, `the list promo.example.com, that has a tracking pixel`.
- `facts-filter`: `What Sift saw` in the Filters panel of For review and Activity; the chip reads `Mail that …`.

## How to get to it (user POV)

- Open any message from For review or Activity; `What Sift saw` is under `Sender`, in the right-hand column, or after the message on a phone.
- Rules, then `Add a rule`, then `Add a condition`.
- For review or Activity, then `Filters`, then a choice under `What Sift saw`.

## Driving it with verify.sh

Preconditions:

- Fresh seed (counts in [README.md](README.md)).

- **See the facts.** `ab open "$B/?message=m4"`. `What Sift saw` lists `Came through a mailing list` (`promo.example.com`), `Has a one-click unsubscribe` (`Sift can use it`), `Was sent through a bulk mail service` (`Mailchimp`), `Has replies going elsewhere`, `Is in Promotions`, `Has a tracking pixel` (`And its links are tracked`). `?message=m7` shows only `Has attachments`; `?message=m6` only `Is a reply`.
- **Rule from a fact.** On m4, `ab find role button click --name "Make a rule for mail that has a one-click unsubscribe"`. Add a rule opens over the reader (the address is unchanged) on `Mail from deals@promo.example.com that has a one-click unsubscribe: `; `Write it yourself` shows `Value 1` `deals@promo.example.com` and `Condition 2` `has a one-click unsubscribe`. `ab press Escape`.
- **Rule from the editor.** `ab open "$B/rules"`, `ab find role button click --name "Add a rule"`, `ab find role button click --name "Write it yourself"`, `ab find role combobox click --name "Condition 1"`, `ab find role option click --name "is in Promotions"`. The hint under `Mail` reads `From anyone.` `ab find role button click --name "Add rule" --exact`. `Apply to mail already there` is ticked and the rule archives, so `Apply to your inbox` opens over the rule's panel: `ab find role button click --name "Cancel"`, then `Close`.
- **On Rules, and in a new decision.** A row reads `mail that is in Promotions` with `Archive`; the masthead's count is two fewer (Deals and Store). `verify.sh sql "$RUN" "SELECT message_id, stage, disposition FROM decisions WHERE message_id IN ('m4','m8') ORDER BY id"` ends with `m8` `rules` `archive` and `m4` `rules` `spam`: the change re-decided both, and Deals met the seed's `anyone at promo.example.com` → Spam first.
- **Filter For review.** On a fresh seed, `ab open "$B/"`, `ab find role button click --name "Filters"`, `ab find role radio click --name "Is a reply"`. Only Ada's `Lunch on Thursday?` row is left; the address has `?fact=reply`; closing Filters shows the chip `Mail that is a reply`.
- **Filter Activity.** `ab open "$B/activity?show=all"`, `Filters`, `ab find role radio click --name "Has a one-click unsubscribe"`. Only Store, Deals and Weekly Digest's two rows are left.
- **Phone.** `ab set viewport 390 844` and repeat any step: the facts rows keep their `Rule…`; Add a rule's form is in its three parts with labels above their controls; Activity's Changed and Everything take a row under the search. `ab eval "document.documentElement.scrollWidth - document.documentElement.clientWidth"` is `0`.

## Gotchas

- Attachments and tracking are known only for mail a model has read; on other mail those conditions and filters match nothing.
- A rule with a fact condition cannot be a Gmail filter, and Gmail filters cannot be shown here anyway.
