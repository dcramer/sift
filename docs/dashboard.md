# Dashboard

`sift run` serves it and prints its addresses. It is where Sift is watched, taught and managed.

## Reaching it

- `http://localhost:8787` on the machine running Sift.
- `https://<machine>.<tailnet>.ts.net` from your other devices, once `tailscale serve --bg 8787` is on.

A plain `http://hostname:8787` address shows the page but cannot sign you in: Google returns a browser only to `localhost` or an HTTPS address.

Signing in with Google is what connects a Gmail account, and only someone signed in as a connected account sees anything. Connect a second account from Settings. Who can sign in at all is Google's to say: the client's test users, or anyone once the app is published.

## Screens

- **Setting up,** in place of every screen until a model is connected and each mailbox has a label of its own: connect a model, say in your own words what you want from Sift, keep what fits of the labels the model suggests, and have Sift go through the newest 300 in the inbox for you to answer, with what that would cost.
- **For review,** the home page: the rules Sift proposes where you keep doing something other than what a label does, then one row per message for what Sift would do, with a sender's mail Sift gave one label folded into one row. Agree in one press (for every message a folded row holds), or open the row to read the mail, see what Sift knows about the sender and what it saw in the message (a mailing list, a one-click unsubscribe, a reply, attachments; each one a rule away). Narrow the list by what Sift saw. The text of each message you answer for is stored, as an example to test and train Sift with.
- **Inbox,** while it is on ([inbox.md](inbox.md)): the conversations in the inbox, newest first, each with what Sift thinks its newest message is, narrowed by that, by label, by unread or by a search. Select rows to archive or mark them read or unread, or open one to read the conversation beside the same answer and sender as For review's.
- **Contacts:** everyone you get mail from, newest first: what Sift does with their next mail (your answers count, not only Sift's own guesses), where they stand (Trusted, Unwanted, Blocked, or how many rules name them), how much they sent in 30 days and when they last wrote. Search by name or address; narrow by standing or by how you know each other. Open one for their page: what their next mail gets and why, Trust, Unwanted or Block in one press, a rule started on them, the names they write under, what their mail is, and their mail itself; and while Inbox is on, Write to them. A domain's page lists the people who write from it. People you have written to who have never written to you are not here: Sift does not keep who you write to.
- **Activity:** the time Sift saved you over a period, which labels it came from, and the lists it unsubscribed you from; then what Sift changed in Gmail, or everything it decided, searchable by subject or sender and narrowed by what Sift saw in the message. Undo what Sift changed in Gmail from the row; open it for that message's whole history, with each decision's reason and cost and each mailbox change.
- **Labels:** what mail can be, and what Sift does with each. Open one to change it, or remove it with the rules that name it (Leave in inbox stays). Add labels by describing the mail to the model and keeping what fits of what it suggests, or by hand.
- **Rules:** what mail is, or what to do with it, without asking a model. Add one by describing it to the model, which fills in the form for you to check, or fill the form in yourself; remove them; see how often and how recently each matched. A rule's conditions can include what Sift saw in the message ("that is a reply", "that has a one-click unsubscribe"); such a rule cannot be a Gmail filter.
- **Settings:** whether Sift is on (changes your Gmail) or off (only suggests), the model and what it has cost, the connected accounts and which is your primary one (who your account is, whichever you sign in with), and going through what is already in the inbox: what it would cost, then how far it has got, with Stop. Turning Sift on offers to go through it there and then. Changes apply to the running Sift straight away. Removing a mailbox, or deleting your account, is confirmed by typing the address: Sift revokes its access at Google and deletes everything it recorded about that mail. Your last mailbox is how you sign in, so it cannot be removed on its own: delete your account instead.

Time saved counts 10 seconds, about what people spend on an email they open, for each message Sift took out of the inbox (archived, marked spam or blocked) and that stayed out: not what was undone, what you answered yourself, or what you opened anyway. A digest is one message back in the inbox, so it comes off its label's count. Reading time is not counted, since most of this mail is never opened; the words in each message the model reads are recorded for when it is. It is shown on Activity, in the cost card of Sift's line, at the foot of the sections, on For review when nothing is waiting, in a rule's panel and on a sender's page; while Sift is off, For review says what it would have saved; and each digest says how many it kept out.

A sender's name anywhere is a link to their page: what Sift knows about them, the standing you give them, and all their mail. An address that writes under several names (a service's "Dependabot" and "Security alerts") is titled by the address, lists each name with what its mail is and a rule for it, and its mail can be narrowed to one name. After the name, a small icon says whether this is their first message (yellow), someone you write to, or someone who writes often and whom you have never answered; pointing at it says which.

## What Sift leaves in Gmail

Mail Sift acts on gets its label (`sift/newsletters`) and, if Sift moved it, a second one for what Sift did (`sift/did/archived`, `sift/did/spam`). Mail it could not place gets `sift/review` and stays in the inbox. So everything Sift touched can be found in Gmail itself. Removing a mailbox from Sift leaves these labels, and the filters it wrote; delete the filters in Gmail's settings if you no longer want them.

## Working on the page

The page is a React app in `web/`, styled with Tailwind and built from Sift's own design system ([design.md](design.md), every part shown at `/system`). Next.js builds and serves it; `app/` is its frame.

- `sift run` builds it the first time and whenever its sources are newer than the build. `pnpm build:web` does the same by hand, into `.next`.
- `pnpm dev` runs Sift from source under `next dev`, which reloads the page and the server as their code changes. Give it `--home <scratch>`.
- Each screen is a route in `app/`, drawn on the server for whoever asked with what is not encrypted (`src/sift/page-data.ts`); the rest the page fetches from `/api/`. A hydration mismatch shows only in the browser console, which every browser test (`pnpm e2e`) fails on.

Why it is built this way is in [architecture.md](architecture.md#dashboard).
