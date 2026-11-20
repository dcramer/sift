# Answer a suggestion

A message Sift could not place, or placed wrongly, waits in For review. The user opens it, chooses what it is, and presses the check. Sift records the label, carries out that label's action on the message on the next pass (even while Sift is off), keeps the message as an example, makes no rule, and moves on to the next one.

## Sub-features

- `answer-open` opens a waiting message from its row, in the reader in the list's place.
- `answer-pick` chooses a label in the reader's dropdown (`What this message is`): `Leave in inbox` first and set apart, then the label Sift gave and its likely others, each with a meter, then the rest. An `Unlabelled` message has no likely group.
- `answer-save` is the check: `Agree:` the label while it is Sift's, `Save:` once changed. The reader moves to the next waiting message and the count drops. Only that message is answered; on For review, a folded row's check answers every message in it.
- `answer-more` is the toast's `Same for N more`: the only way one answer reaches the sender's other waiting mail, offered when that mail has the same label (or, like the two Ops alerts, none).
- `answer-rule` is `Make a rule…`, which opens the rule dialog over the reader, started on this sender and the message's label (see rule-shortcuts.md).

## How to get to it (user POV)

- For review, a row, then the dropdown and the check at the top of the panel.
- From any screen with `?message=<id>` in the address.

## Driving it with verify.sh

Preconditions:

- Fresh seed (counts in [README.md](README.md)).

- **Open.** `ab open "$B/"`, then `ab find role cell click --name "48 hours only: 30% off"`. The address gains `?message=m4`, a level-2 heading reads `48 hours only: 30% off`, the dropdown reads `Unlabelled`, and the check is disabled.
- **Choose and save.** `ab find role combobox click --name "What this message is"`, `ab find role option click --name "Marketing"`, then `ab find role button click --name "Save: Marketing"`. A toast reads `Archive as Marketing`. Deals was the last row, so the reader goes back to the list (the address is `/` again) and the link's count is one fewer.
- **A rule, on purpose.** `ab open "$B/?message=m6"`, `ab find role button click --name "Make a rule…"` (the open reader hides the proposal line's button of the same name). The rule dialog opens over the reader on `What should it do?`, its box started on the sender alone (`Mail from ada@example.org: `, since Ada's mail has no label); `Write it yourself` shows `Value 1` reading `ada@example.org`; the address keeps `?message=m6`. `ab press Escape`.
- **Only this one.** `ab open "$B/"`, `ab find role cell click --name "Replica lag on db-3"`, choose `Notifications`, `ab find role button click --name "Save: Notifications"`. The toast reads `Archive as Notifications` with `Same for 1 more`; leave it. The panel moves to `Disk 91% full on db-2`, still `Unlabelled`, and that row stays on For review.
- **Second view.** `ab open "$B/rules"`. As many rules as before: answering made none.
- **Stored.** `verify.sh sql "$RUN" "SELECT label_id, carry_out, by_user, outcome FROM decisions WHERE message_id = 'm4' ORDER BY id DESC LIMIT 1"` returns `marketing`, `true`, `true`, `skipped`: the answer began a pass, which found no such message in the stand-in Gmail. `SELECT message_id, label_id FROM examples WHERE message_id IN ('m4', 'm9', 'm10')` returns `m4` with `marketing` and `m10` with `notification`, and no `m9` (the seed's three bills are examples too).

## Gotchas

- A row shows the sender's name, not the address; the address is in the panel.
- Each subject is in its row twice, once in a copy shown only on phones, so `find text "<subject>"` reaches the hidden one and fails. Use `find role cell`.
- Rows have no accessible name. `find role row --name` matches nothing.
- The answer copies the text Sift read of the waiting message into the example: `SELECT status FROM examples WHERE message_id = 'm4'` is `captured`, and `read_bodies` still has `m4` until 30 days after it was read.
