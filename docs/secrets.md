# Secrets

Four kinds of thing would let someone else act as you, and Sift encrypts each when you give it a key. It encrypts the mail it holds the same way:

- in the home directory, the install's own: `google-client.json` (your Google OAuth client) and `dashboard-key` (signs dashboard sessions, unless `SIFT_SESSION_SECRET` gives the key: a host that keeps no files between starts needs that);
- in the database, as each person's own rows (`credentials`), theirs: a Gmail refresh token per mailbox, and their model sign-ins (API keys, a ChatGPT sign-in);
- in the database, the text and HTML of the mail Sift holds for them (`read_bodies`, `mail_bodies`, `examples`), and the headers of every message it records, which say who sent it, to whom and about what. A message with no HTML has none stored, not an empty one. Inbox's text has a search index beside it, a keyed Bloom filter, not encrypted ([security.md](security.md#the-search-index));
- in the database, everything else that names a sender, or may: rule and proposal conditions, a rule's name, the Gmail filter written for a rule, a change's details, a decision's reason, and what a person tells the label and rule models with what those suggest. Senders, domains, conditions and who you have written to are found by a keyed hash ([security.md](security.md)).

A person's sign-ins and mail are their own rows, which row-level security keeps from everyone else. The rest of the database (labels, a rule's condition in your own words, what was decided and done, when) is not encrypted.

A key beside what it protects protects nothing, so the key belongs in the environment, not in the home's `.env`. It guards a copied home directory or backup. It does not guard against someone who can read the running process's environment.

## Setting a key

`sift init` generates one and adds it as `SIFT_KEY` to `.env` in the directory it was run from, before it stores any credential. If it cannot write there (in Docker, say), it prints the key for you to set.

To set one yourself, `openssl rand -base64 32`, and give the result to Sift as `SIFT_KEY`: in the environment, or in a `.env` file. Sift reads `.env` from the home directory and then from the directory it was started in; a variable already set is never replaced. `.env` in the home directory is the convenient place and the weak one, since a copy of the home then carries its own key. With Docker, set it on the container (the compose file passes `SIFT_KEY` and `SIFT_OLD_KEYS` through).

At the next `sift run`, or on Vercel the next deploy's build, everything stored plain is encrypted and every keyed hash made again, and it says so. Without a key Sift still runs, stores these plain (the files owner-only), and says so at start.

## Rotating

1. Put the new key in `SIFT_KEY` and the one it replaces in `SIFT_OLD_KEYS` (comma-separated if there are several).
2. Start `sift run`, or deploy again on Vercel. It re-encrypts every file and every person's sign-ins and mail with the new key and lists them.
3. Remove `SIFT_OLD_KEYS`.

Each value records the id of the key that encrypted it (a short hash, the `2cac0b47` in `sift-secret:v1:2cac0b47:…`), which is how Sift picks the key and how you can tell what an old one still covers.

## If the key was exposed

Rotating the key (above) is enough only if nobody who had the key could also have read what it protects. If a copy of the home directory or a backup may be out with it, treat what it holds as exposed too, and replace it at its source:

| What | Do |
| --- | --- |
| Gmail access | In each Google Account, remove Sift's access under third-party apps; that ends every token Sift was given. Then sign in to the dashboard again. |
| The Google client (`google-client.json`, or `SIFT_GOOGLE_CLIENT_SECRET`) | In Google Cloud Console, reset the client's secret, then `sift init` and paste the new JSON, or set the new secret on Vercel. |
| Model keys and sign-ins | Revoke the API key, or sign out other sessions, at the provider. Then sign in again under Settings in the dashboard. |
| Dashboard sessions (`dashboard-key`, or `SIFT_SESSION_SECRET`) | Delete the file, or set a new secret. Everyone is signed out. |

Then rotate the key itself. The key leaves the rest of the record plain (labels, and what was decided and done, and when), so a copied home carries that too.

## Losing the key

Sift refuses to start (on Vercel, the deploy fails), and names what it cannot open. If `sift init` made the key, first check that Sift was started from the directory whose `.env` holds it. Otherwise nothing the key sealed can be recovered: the files below, every sign-in, and in the databases the text and headers of recorded mail, rules' conditions and names, and decisions' reasons.

| Lost | Then |
| --- | --- |
| `google-client.json` | Delete it, then `sift init`, and paste the client again from Google Cloud Console. |
| `dashboard-key` | Delete it; everyone is signed out of the dashboard. |

Sift checks every sealed row before it starts, so it will not start while any the key sealed is still in a database, and there is not yet a way to drop only those rows (TODO.md).

## How

AES-256-GCM from `node:crypto`. The key is derived from `SIFT_KEY` with scrypt, so a passphrase works, but a random value is better. Two keys per person are derived from it with HKDF, each for one use: the keyed hash senders and conditions are found by (`sift-hash:v1`), and the one Inbox's search index is made with (`sift-search:v1`; [security.md](security.md#the-search-index)). Rotating rewrites both: every hash is made again, and every message's search index with its text; text kept with no index yet is left to the pass that indexes it. Each value is authenticated with what it is for, a file's name or the person, kind and key of a row, so one account's token cannot be moved into another's place, or into another person's database. Code: `src/secrets.ts`, `src/store/credentials.ts` for sign-ins and `src/store/content.ts` for mail; each part of a message (its text, HTML, headers, a decision's reason about it) is bound to the person, the message and which part it is. Without a key a part is stored marked plain, so a subject written to look encrypted is not taken for one.
