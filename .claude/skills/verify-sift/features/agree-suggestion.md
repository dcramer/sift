# Agree with a suggestion

A message Sift placed shows the label it gave in the row's answer: a dropdown starting on that label, after a meter of how sure Sift is, and a check. Pressing the check agrees: Sift records the answer, keeps the message as an example, and begins a pass that carries out what the label does to that message in Gmail, even while Sift is off. No rule is made.

## Sub-features

- `agree-check` is the check beside the dropdown; its name is `Agree:` then the label.
- `agree-change` is choosing another label in the dropdown (`What this message is`), which turns the check into `Save:` and inks it; nothing is sent until it is pressed.
- `agree-fold`: a folded row's check answers every message in it.
- `agree-more` is the toast's `Same for N more`, offered when the sender has other waiting mail Sift guessed the same way. On For review that mail is folded into the same row, so it shows only after agreeing in the reader.

## How to get to it (user POV)

- For review, the check on a row.
- On a phone the row has no dropdown or check; it opens the message, where the same answer is under the title.

## Driving it with verify.sh

Preconditions:

- Fresh seed. The Store row (`Winter sale starts now`) has a dropdown (`What this message is`, like every row's) holding a `Sure` meter and `Marketing`, and the check `Agree: Marketing`; the Notifications rows have `Agree: Notifications`; the six `Unlabelled` rows have the check disabled (`Choose what it is first`).

- **Agree.** `ab open "$B/"`, then `ab find role button click --name "Agree: Marketing"`. A toast reads `Archive as Marketing`. The link's count is one fewer, the Store row is gone, and no panel opens.
- **A folded row.** `ab find role button click --name "Agree: Notifications"` on Dependabot's row (`3 messages`; take its ref from `ab snapshot -i`, as both Notifications rows have that name). The toast reads `Archive as Notifications: 3 messages` and the count drops by three.
- **Same for more.** `ab find role cell click --name "Run failed: CI on main"` opens github-actions[bot]'s fold on one message; `ab find role button click --name "Agree: Notifications"` in the reader. The toast reads `Archive as Notifications` with `Same for 1 more`, and the reader moves on.
- **Second view.** `ab open "$B/rules"`. No rule mentions `sale@store.example.com`. The message's reader (`ab open "$B/activity?show=all&message=m8"`) reads `You said this is Marketing · Done`.
- **Stored.** `verify.sh sql "$RUN" "SELECT label_id, carry_out, by_user, outcome FROM decisions WHERE message_id = 'm8' ORDER BY id DESC LIMIT 1"` returns `marketing`, `true`, `true`, `done`: the answer began a pass at once, which carried it out whether Sift is on or off. `SELECT type, status FROM actions WHERE message_id = 'm8'` is `archive`, `done`, and in `$RUN/google.json` Gmail's `m8` has lost `INBOX` and gained `sift/marketing`. `SELECT e.message_id, e.label_id, f.verdict FROM examples e JOIN decisions d ON d.message_id = e.message_id JOIN feedback f ON f.decision_id = d.id WHERE e.message_id = 'm8'` returns `m8`, `marketing`, `right`.

## Gotchas

- An answer makes no rule, and answers that agree with the label propose none. Only answers giving a label's mail another action do (two in a row for one sender), which the dashboard's check never gives: the seed makes its one from Gmail answers.
- Only a row Sift placed starts on a label. In the seed those are Store (`m8`) and the Dependabot and github-actions[bot] rows, placed by the stand-in model as sure; it is unsure of everything else, so `Unsure` and `Fairly sure` meters cannot be shown here, and the dropdown's likely group holds only the label itself.
- The check has no key of its own; Enter on a focused check presses it.
