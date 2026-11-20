# Security

How Sift keeps one person's mail from anyone else. Decided 2026-11-15 for Sift on Postgres, hosted (Vercel) or run locally, and changed 2026-11-16 (below: not end to end). Every change is held to it. Where the code does not do something yet, this says so; the plan is in TODO.md.

## Hold as little as possible

Everything stored or sent anywhere (a column, a log line, telemetry, what the model provider is sent) has a reason, a lifetime and a form from the table below; anything without a reason goes. Message text and HTML are kept in three places only: mail the person answered for, until they delete it or for a year; what Sift read of a message, for 30 days from reading, so it is not read from Gmail again; and, while they have Inbox on, their mail within the window they chose.

## What is stored, and how

| What | Stored as | Who can read it |
| --- | --- | --- |
| Message text and HTML, and its headers (sender, recipients, subject, list id) | Encrypted with the install's key, bound to the person, the mailbox, the message and the part | The server |
| Credentials: Gmail refresh tokens, model sign-ins | Encrypted with the install's key, bound to the person and what each is for | The server, which uses them while the person is away |
| The words of the mail Inbox keeps, for its search | A keyed Bloom filter per message, beside its text ([below](#the-search-index)) | The server; the database shows how alike two of one person's messages are, and nothing of which words |
| Sender addresses and domains, in mail records and cached correspondents | A keyed hash per person, which finds and groups them. A record shows its sender from its encrypted headers; a cached correspondent is only its hash | The hash: nobody |
| Rule and proposal conditions, a rule's name, a change's details (an unsubscribe's host, a filter's criteria), the filter written for a rule, a decision's reason, the person's words to the label and rule models and what those suggested, the reasons the model gave for what a digest says is worth a look | Encrypted; conditions are found by the keyed hash of them | The server |
| What the person writes or Sift decides: labels, a rule's condition in their own words, actions, decisions and outcomes, times, costs | Plain | The server. Conditions and label descriptions are read on every pass, to be given to the model |

**Encrypted** is AES-256-GCM under the install's key, through `src/secrets.ts` ([secrets.md](secrets.md)). What a value is for is its associated data: for a message's parts, the person, the mailbox, the message and the part; for a rule's, the person and the rule; for anything else (a proposal, a change, a label suggestion, a rule draft), the person and the mailbox. So a value moved to another message, rule or mailbox, or read through another person's handle, does not open.

**The install's key** is `SIFT_KEY`, in the environment, locally and on Vercel alike. It is never in the database or the repository.

**Keyed hash** means an HMAC with a key derived for the person from the install's key (HKDF of the key and the person's id; `keyedHash` in `src/secrets.ts`). Addresses are lowercased first. A plain hash would not do: addresses are guessable, and a list of them could be hashed and matched. With a key per person the same sender hashes differently for each person, so the database does not show that two people hear from the same sender. The database can only ask whether two are equal: a sender's page, "all mail from this sender" and "the rule with exactly these conditions" look up by hash, and anything else (search, sorting by address) decrypts in Sift. A new key changes every hash, so Sift hashes again what it encrypts again: at start under `sift run`, and in the build on Vercel. Without a key, the hash is the value itself.

## The search index

Inbox's search cannot ask Postgres about text it holds encrypted, so each message whose text Inbox keeps also has a Bloom filter of its words, its sender's and its subject's, and their starts ([inbox.md](inbox.md#search)): a few hundred bytes to 4 KB in which each term sets 7 bits named by an HMAC under a key derived for search alone (HKDF of the install's key and the person's id, `sift-search:v1`; `searchHash` in `src/secrets.ts`), apart from the keyed hash's. It is chosen over a table of keyed hashes of each word, which would be about 30 times larger (a row for each word and start of a word of each message, some 50 million for 100,000 messages) and would show which messages share each word, so that how often each one comes up (the commonest are "the" and "to") names it.

What someone holding the database without the key learns from it:

- **How many different words a message has**, roughly, from its size (a power of two) and how many of its bits are set. Its encrypted text's length says as much already.
- **How alike two of one person's messages are.** A word sets the same bits in all of that person's mail, so two messages that share many words share many bits: mail from the same newsletter, or a thread's replies, can be grouped. Which bits are which word cannot be worked out without the key, and each bit is set by thousands of words.
- **Which of their messages may hold a word they planted.** Someone who can both send the person mail and read the database can send a message of a single unusual word, find its index, and look for its bits in the rest, with about one in a few hundred false matches per word. This is the index's real cost: the same person could not tell that from the text, which no key opens to them. Each message's own salt would end it, but then a search would have to read every message's index into Sift and hash each word for each one, seconds a search for a large mailbox, instead of one query in Postgres.
- **Nothing across people.** The key is the person's, so the same word sets different bits in someone else's mail.

Who can search: only the server with the key, through the person's own handle, like every other read of their mail. A new key moves every bit, so an index read before a rotation tells nothing about the one after it.

## Not end to end

Decided 2026-11-16: mail is not sealed to a key only the person's browser holds (a key pair unlocked by a passkey was considered). Sift reads stored mail while the person is away: the model is shown their earlier answers when it judges new mail, test runs replay them, and search reads subjects and names. Sealing would end all of that. It would also protect less than it seems, because the server holds a Gmail token that reads the whole mailbox.

## Keeping people apart

1. **The application's own checks** are the guard. Every query runs through the per-person handle (`store.user(id)`, through the signed-in person's `open(id)`), and every table of a person's data carries the person's id in its keys and foreign keys, so no row can point at another person's. A test runs every dashboard route as two people.
2. **Row-level security** is defence in depth: the one check the database enforces itself. Every such table is `FORCE ROW LEVEL SECURITY` with a policy on the person's id, set per transaction by the handle. Sift connects as a role that owns no table and cannot bypass the policies; migrations run as another (`DATABASE_MIGRATION_URL`). With that set, Sift refuses to run as a role that is or can become a superuser, a role with BYPASSRLS or a table's owner; without it, Sift runs as the owner and warns at start. PGlite, locally, runs as its superuser inside Sift's own process, where there is no other role to connect as and anyone who could run a statement could read its folder. A test fails when a table has no policy.
3. **Encryption** limits what a leaked database or backup reveals without the key to labels, conditions in the person's own words, and what was decided and done, when: no sender, message content or credential. A row that reaches another person's handle does not decrypt there.
4. **The host's own** encryption at rest and TLS on every connection.

## What it does not cover

- **A leak with the key.** The database and `SIFT_KEY` together open everything stored, including the Gmail token.
- **A server under someone else's control.** It holds the key and the credentials, and a Gmail token reads the whole mailbox.
- **Mail while it is being classified.** Sift reads it from Gmail, and the model provider is sent what the model needs: to judge a message, the message; for a digest, the sender and subject of each message in it.
- **A digest once it is in Gmail.** It lists the senders and subjects of mail Sift archived, in the person's own mailbox, as Gmail holds any other mail.
- **Mail being read in the dashboard.** A message shown as its HTML passes through the server on its way to the browser, like the rest of the page's data. The browser shows it in a sandboxed frame that runs no script and loads nothing from anywhere, so opening it tells no sender it was read.

## What follows from it

- What is stored encrypted is never drawn into HTML on the server. It is `Confidential` from `src/store/content.ts` to the page, which draws it only in the browser (`reveal`, `web/src/lib/reveal.ts`); the type checker, `next build` and the linter refuse anything else (docs/architecture.md, "The page").
- The server's own logs may name a mailbox, never a sender.
- Nobody running Sift reads a person's mail, and no tool is built that would show it (Google's Limited Use).
- Deleting a person is one statement that takes every row of theirs, and removing a mailbox one more after its token is deleted, by cascading keys a test holds every table to; their Gmail access is revoked at Google first. Backups keep them no longer than the stated retention.
- A session names the person as well as the mailbox, so a session for an address that was removed and connected again by someone else opens nothing.

## Now

Done: one Postgres database (PGlite locally); every person's table carries `user_id` in its keys and foreign keys and has a forced row-level security policy; every query is built on the session's `open(id)` handle, whose builder adds the person to every read, join, change and delete and sets them on every insert, and runs as `sift_app` with the person set; tests check each table's policy, that people cannot reach each other's rows, and that the builder keeps them apart with row-level security switched off. Credentials, message content and everything else that names a sender are encrypted with `SIFT_KEY` ([secrets.md](secrets.md)), and once it is set a plain one is refused, so none can be planted in a person's place; senders, domains and rule conditions are found by keyed hash. A model provider's error is recorded as its status and kind, never its text, which can quote the request.
