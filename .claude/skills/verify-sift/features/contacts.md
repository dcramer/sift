# Contacts

Everyone the person gets mail from, newest first, each with what Sift does with their next mail (their answers counted), their standing or how many rules name them, their mail in 30 days and when they last wrote; and each one's page, which is a sender's or a domain's.

## Sub-features

- `contacts-list`: the directory at `/contacts`, under `Contacts` in the sections.
- `contacts-search`: `Search contacts`, by name or address, kept in the address (`?q=`).
- `contacts-filters`: `Filters`: `Standing` (`Trusted`, `Unwanted`, `Blocked`) and `How you know them` (`New`, `You write to them`, `Never written back`), each a chip that clears it.
- `contact-page`: a row opens `/sender/<address>`; `Contacts` above the name leads back. A domain's page lists `People here`.
- `contact-write`: `Write to them`, only with Inbox on, opens `New message` to them.

## How to get to it (user POV)

Press `Contacts` in the sections, or open a sender or domain from anywhere they are named.

## Driving it with verify.sh

Preconditions: a fresh `up "$RUN"` (add `--inbox` for `contact-write`).

- **The list.** `ab open "$B/contacts"`: 10 rows, `Weekly Digest` first (`Archive as Newsletters`, `1 rule`), `Utility` says `Keep as Receipts` (answered so, though Sift left it Unlabelled), `Dependabot` `Usually Archive as Notifications`; no row for `me@example.org`.
- **Search.** Type `lovelace` in `Search contacts`: one row, Ada Lovelace; the address has `?q=lovelace`.
- **Filters.** `Filters`, `You write to them`: Ada alone. `Blocked`: `Nothing matches.` until a standing is given.
- **A contact.** Press Ada's row (not her name, which is a link too): `/sender/ada%40example.org`, `Contacts` underlined in the sections, `You have written to them` once, under her name. `Block`: toast `Mail from ada@example.org: send it to spam`; back on `Contacts`, her row says `Spam` and `Blocked`.
- **Write to them.** With `--inbox`, `ab find role button click --name "Write to them"`: `New message` with To `ada@example.org`.
- **Phone.** `ab set viewport 390 844`: each row is the name, the address and what Sift does; nothing scrolls sideways.

## Gotchas

- What a row says Sift does is what the sender's page says under `Their next mail`; the two come from the same place on the server, so check one against the other.
- People only written to, who never wrote, are not listed: Sift does not keep who the person writes to.
