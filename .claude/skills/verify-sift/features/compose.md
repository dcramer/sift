# Write and send mail

With Inbox on, the person writes new mail in a panel over whatever is open, and replies and forwards in the reader at the foot of the conversation, from any of their addresses Google lets Sift send from, and Sift sends it as them. What they have written is kept in the browser until it goes or they discard it.

## Sub-features

- `compose-new` opens a new message with C or the rail's `Compose`, from the mailbox the switch shows (the primary one for All).
- `compose-addresses` checks each address in To and Cc once the reader has moved past it.
- `compose-send` sends with `Send` or Ctrl+Enter (⌘↵ on a Mac), then says `Sent` in a toast.
- `compose-draft` keeps what is written through closing and reloading; `Discard` drops it, with Undo.
- `compose-grant` says Sift may not send from a mailbox yet, and offers `Let Sift send`.
- `compose-reply` answers a message from the mailbox it came to, the newest or any other of its conversation; sent from the reader, it joins the conversation there, open.
- `compose-forward` sends a message on as new mail, `Fwd: ` and its subject, quoted under what is written.

## How to get to it (user POV)

- Any screen, C, or `Compose` in the rail (desktop); on a phone, `Compose` in Inbox's header.
- The reader (Inbox, a conversation open), under the conversation: `Reply` (R), `Reply all` (A), `Forward` (F), which open the reply in their place, on the newest. On any open message's head: `Reply to <sender>`, and `Reply all or forward`, a menu. The address alone opens one too: `?message=<id>&compose=reply` (or `all`, `forward`), with `&answering=<id>` for another message of the conversation.

## Driving it with verify.sh

Preconditions:

- A run started with `verify.sh up "$RUN" --inbox`: Inbox on, Google letting Sift send from `me@example.org` (as itself or `me+lists@example.org`), not from `me@work.example.org`.

- **Open.** `ab open "$B/"`, wait for the rows, `ab press c`. A dialog `New message`: `From` (`me@example.org`), `To` focused, `Cc`, `Subject`, `Message`; `Send` disabled.
- **Addresses.** `ab keyboard type "ada@example.org, nope"`, then click `Subject`: `“nope” is not an address.` under To. `ab find role textbox fill "Ada <ada@example.org>" --name "To"` clears it.
- **Draft.** Fill `Subject` and `Message`, `ab reload`: the same dialog with the same words (`?compose=new`).
- **Send.** Click `Message`, `ab press Control+Enter`. The dialog goes, a toast says `Sent` over the subject. `cat "$RUN/sent.json"` holds it, `mailbox` `me@example.org`; `SELECT id, thread_id, label_ids, decided FROM messages WHERE id LIKE 'sent%'` is `sent-1`, `["SENT"]`, `true`, and `mail_bodies` has its text.
- **Grant.** Switch the mailbox to `me@work.example.org`, `ab press c`: `Sift may not send from me@work.example.org yet` with `Let Sift send` (`/auth/login?grant=send&mailbox=…&to=/?compose=new`), `Send` disabled.
- **Reply.** `ab open "$B/?message=m6&compose=reply"`: the reader on Ada's `Lunch on Thursday?`, and under her message the region `Reply`: From `me@example.org` whatever the switch shows, To `Ada Lovelace <ada@example.org>`, no Subject. Sent, `sent.json` has `threadId` `t6` and `In-Reply-To: <thursday@example.org>`.
- **From the reader.** `ab open "$B/inbox?message=m6&thread=t6"`, wait for `Reply all`, `ab press r`, type (the conversation stays above the reply, and the address gains `&compose=reply` in place), `ab press Control+Enter`: the reader stays, and under Ada's message an open one from `me@example.org` with what was typed; Inbox's row is `Ada, me 2`.
- **An earlier message.** `ab open "$B/inbox?message=m11&thread=bills"`: the three bills, open (unread). `ab find role button click --name "Reply to Utility"` takes the first, May's (`m13`): the region `Reply` at the foot, `Replying to Utility, <time>` over its fields, and `&compose=reply&answering=m13` in the address, which a reload keeps. Sent, `sent.json` has `Subject: Re: Your May bill` and `In-Reply-To: <may@utility.example.net>`.
- **Forward.** In the same reader `ab press f`: `Forward`, To focused and empty, Subject `Fwd: Lunch on Thursday?`, Message starting with two empty lines then `---------- Forwarded message ---------`. Sent, `sent.json` has no `In-Reply-To` and its own `threadId`.

## Gotchas

- With Inbox off (any other seed) there is no `Compose`, C does nothing, and `?compose=new` opens nothing.
- `Let Sift send` goes to Google, which cannot be reached here.
- The stand-in Gmail sends nothing: `sent.json`, beside `gmail.json`, is the only place sent mail goes.
