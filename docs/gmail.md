# What Gmail's API gives Sift

What Sift can use directly, and what it has to do itself. From Google's documentation as read on 2026-11-15; re-check before relying on a limit. Sift holds two scopes, `gmail.modify` and `gmail.settings.basic`, both of which Google classes as restricted, and a third, `gmail.send` (sensitive), for a mailbox whose person lets it send.

## Used directly

| Need | API | Notes |
| --- | --- | --- |
| Find new mail | `users.history.list` | A history id is "typically valid for at least a week", sometimes only hours. A 404 means resync, which Sift does with a bounded search. 2 quota units. Besides new messages it lists labels added and removed, per message; a record has no time and does not say who made the change, and Sift's own changes appear like anyone's. A new message is not always listed as added: Gmail has been seen to name one only in a record's `messages`, and that is not documented. So Sift also reads, at 20 units each, any message a record names without saying what happened to it, and any put in the inbox, that it has not recorded, and takes it as new mail if it is in the inbox and arrived after the last sync began, less an hour. |
| Where history starts | `users.getProfile` | The mailbox's current history id, at the first sync and after a resync; and how many messages it holds (`messagesTotal`, Spam and Trash among them), for what copying all of it would take. 1 unit. |
| Search | `users.messages.list` | The inbox, for a resync, for going through it and for applying a rule to it; sent mail to one address, for whether the owner has written to it; a digest by its Message-ID (`rfc822msgid:`), for whether a try whose answer was lost put it in; the whole mailbox but Spam and Trash, for copying it for Inbox, where `after:` and `before:` take epoch seconds (otherwise a date is midnight Pacific) and `{a b}` is either. Its `resultSizeEstimate` is what the choice of how far back shows, and can be well off. 5 units. |
| Read a message | `users.messages.get` | 20 units for metadata or minimal, 60 for `full`, `raw` or `html` (checked 2026-11-19). Metadata is headers and labels only: whether a message has attachments needs the full message, whose parts carry a `filename`. `full` holds every header too, so mail Sift copies or keeps from outside the inbox, and with Inbox on new inbox mail, is read once, at 60, not 20 then 60 (`getMessage`). `raw` costs the same and would need parsing here. Each message is read once of each kind at most: what a later step needs is kept at the first read ([AGENTS.md](../AGENTS.md#read-gmail-once)). |
| Who took part in a thread | `users.threads.get` | `format=minimal` gives each message's id and labels; one the owner sent carries `SENT`. Asked only for a reply the model is about to judge, once, and not while Inbox has copied the mailbox, when the record holds the thread. 40 units (120 for `full`). |
| Archive, mark spam, mark read, label | `users.messages.modify` | Add or remove label ids: `INBOX`, `SPAM`, `UNREAD`, `STARRED`, `IMPORTANT`, the `CATEGORY_*` tabs and user labels can all be applied. 5 units. |
| Put a message in the mailbox | `users.messages.insert` | A digest, into the inbox. Works with `gmail.modify` and "does not send a message", so it reaches no one but the owner. 25 units. |
| Send | `users.messages.send` | With `gmail.send`. Mail a person wrote in the composer, as RFC 2822 text, into a thread when it answers one. 100 units. Sift gives it a Message-ID of its own, so a try whose answer was lost is looked for (`rfc822msgid:`) before sending again. Its answer, and a search's, give the message's id and its thread's, which is how Sift keeps what was sent in the record. Gmail threads a reply by `threadId` only when its `References` or `In-Reply-To` name the thread and its subject matches, so the server sets all three from the message answered. |
| Let Sift send | OAuth, `include_granted_scopes` | `/auth/login?grant=send&mailbox=<address>` asks Google for `gmail.send` alone, hinting the mailbox; with `include_granted_scopes` the new refresh token holds what was granted before as well, and every sign-in asks with it, so signing in again keeps sending. Which scopes a token holds is its `scope` (`mailboxes.can_send`). Google's account picker can return another account, which is refused. |
| Many at once | `users.messages.batchModify` | Up to 1,000 ids, 50 units. Not used yet: Sift changes one message at a time so each has its own audit row. |
| Labels | `users.labels.*` | Nested names (`sift/newsletters`) are ordinary labels with a slash. Names are compared without case: once the person renames `sift` to `Sift` in Gmail, creating `sift/newsletters` is refused as `409 Label name exists or conflicts`, so Sift matches names the same way. `users.labels.get` on `INBOX` counts what is in the inbox (`messagesTotal`) for 1 unit, which is how going through it is priced before a message is read. |
| Copy a rule to Gmail | `users.settings.filters` | With `gmail.settings.basic`, which Sift already asks for. A filter matches on from, to, subject, a Gmail search query, attachment and size, and can add or remove labels: archive (`INBOX` off), mark read (`UNREAD` off), star, mark important, one user label, never-spam. Up to 1,000 filters; no update, only create, delete, get and list; creating a duplicate is refused. The documentation does not say a filter can add `SPAM`, so Sift never writes one. Filters apply to a message, not its thread, and only to mail that arrives afterwards. `to` matches Cc and Bcc as well as To. |
| The owner's other addresses | `users.settings.sendAs.list` | With `gmail.settings.basic`. Lists the account's own address and every send-as alias; one still `pending` was never confirmed from its own inbox, so Sift does not count it. 1 unit. |

Quotas (projects created since 2026-05-01; older ones keep their old quotas):

| Per | Units | |
| --- | --- | --- |
| User, minute | 6,000 | 100 full reads. A pass reads at most 50 waiting messages' text and, with Inbox on, 50 inbox messages' it never read; examples read Gmail only for mail Sift never read. What the steady state uses: [runtime.md](runtime.md#expectations). |
| Project, minute | 1,200,000 | Per install. |
| Project, day | 80,000,000 | Not raisable; Google plans to bill above it. A 200-messages-a-day mailbox uses ~33,000. |

## Signing in

From Google's OAuth documentation as read on 2026-11-20. Which of these an install is under is set in its Google Cloud project, which Sift cannot read.

- **Testing** (audience External, publishing status Testing). A refresh token ends 7 days after the person agreed on Google's consent screen. Only a client asking for nothing beyond name, email and profile is spared, so Gmail's scopes always bring it. Using the token does not extend it. Signing in again starts a new 7 days, since Sift asks for consent each time and so gets a new token. Then Google refuses to refresh it with `invalid_grant`, which Sift reads as an expired sign-in (`passWanted`, `src/work/run.ts`). At most 100 test users, and only they can sign in. Nothing in Google's answer says when the token ends: `refresh_token_expires_in` is documented only for time-based access (not checked against a Testing client).
- **In production, unverified.** No 7-day end. Each person clicks through Google's unverified-app screen, and the project may take 100 people over its whole life, a cap that cannot be reset.
- **In production, verified.** Neither limit, but Gmail's restricted scopes need Google's verification (TODO.md).
- **Internal.** Only accounts in the project's own Workspace organisation, so never a `@gmail.com` address.
- **Personal.** Only the Google account that created the project. No 7-day end, no unverified-app screen, no verification. It is chosen once, when the client is first configured, and an External or Internal project cannot switch to it. Google does not say whether it allows Gmail's scopes (not tried).

Whatever the mode, a refresh token also ends when the person revokes it, after six months unused, when the account's password changes (for one with Gmail scopes), or when one account has more than 100 live tokens on one client, which ends the oldest without warning. Each sign-in makes one; Sift keeps only the newest.

## Available, not used yet

- **Push** (`users.watch`). Gmail publishes to a Google Cloud Pub/Sub topic, usually within seconds, and says only the address and its new history id: the changes still come from `history.list`. The watch is renewed at least every 7 days (Google suggests daily). A mailbox gets at most one notification a second, the rest are dropped, and any may be late or lost, so a slow poll stays as the fallback. Google recommends polling only for apps on the person's own device (installed, mobile, a browser); a server can take push, which would read history as mail arrives instead of on the look gap ([runtime.md](runtime.md#the-core)). Pub/Sub pushes only to a public HTTPS address, so `sift run` on localhost or Tailscale would pull from a subscription instead.
- **Threads** (`users.threads.modify`). Applies a change to every message in a thread; later messages do not inherit it.

## Not checked against real Gmail

- Whether a filter's `from: @example.com` leaves out subdomains, as Sift's domain rules do.
- Whether Gmail hands a filter back exactly as it was created. Sift compares against what Gmail returned at creation, not what it sent, so a rewrite at creation is harmless; a later rewrite would show as "changed".
- How a snoozed message appears in history. If snoozing takes `INBOX` off and waking puts it back, Sift reads each as the user moving the message, and records two answers for it.
- Whether Gmail keeps the Message-ID Sift gives mail it sends. If it puts its own in, a try whose answer was lost is not found, and is sent again.
- Whether editing a filter in Gmail's settings keeps its id (seen by Sift as "changed") or replaces it (seen as "gone").

## Not in the API: Sift does it itself, or cannot

| Feature | Status |
| --- | --- |
| **Block a sender** | Gmail's blocked-senders list is not exposed. Sift's block is its own: the message is marked spam and a rule makes that sender's later mail spam without a model. A Gmail filter cannot stand in for it unless filters can add `SPAM`, which is not documented. |
| **Unsubscribe** | No API. Sift makes the sender's one-click request itself (RFC 8058) when the user asks; see `src/actions/unsubscribe.ts`. Lists that need an email sent cannot be left: Sift sends only what a person writes. |
| **Report spam or phishing** | No API beyond applying the `SPAM` label. |
| **Mute, snooze** | Not in the API. |
| **Contacts, "people I have emailed"** | Not in the Gmail API. Sift searches sent mail for an address instead and caches the answer. |
| **Forward** | Needs a verified forwarding address. Sift does not forward. |
| **Delete** | Trash is possible with `gmail.modify`; permanent deletion needs full mail access. Sift does neither. |
