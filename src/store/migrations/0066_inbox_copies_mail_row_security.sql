-- Whoever has Inbox on already chose it when it kept only inbox mail: their copy starts at the last year, the default,
-- in every mailbox. Every person's rows at once, so the tables' owner, which migrates on a Postgres server, is let past
-- their policies until the end of the migration.
ALTER TABLE "preferences" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mailboxes" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "mail_copies" ("user_id", "account_id", "since", "before", "started_at")
SELECT m."user_id", m."id", (extract(epoch FROM now()) * 1000)::bigint - 31536000000, (extract(epoch FROM now()) * 1000)::bigint, (extract(epoch FROM now()) * 1000)::bigint
FROM "mailboxes" m JOIN "preferences" p ON p."user_id" = m."user_id"
WHERE p."mail";--> statement-breakpoint
ALTER TABLE "preferences" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mailboxes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- The policy holds for the table's owner too, as for every table of a person's data (0001).
ALTER TABLE "mail_copies" FORCE ROW LEVEL SECURITY;
