-- The policy holds for the table's owner too, as for every table of a person's data (0001).
ALTER TABLE "mail_asks" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "mail_summaries" FORCE ROW LEVEL SECURITY;
