CREATE TABLE "mail_copies" (
	"user_id" integer DEFAULT current_setting('sift.user')::integer NOT NULL,
	"account_id" text NOT NULL,
	"since" bigint,
	"before" bigint NOT NULL,
	"page_token" text,
	"done" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"started_at" bigint NOT NULL,
	"finished_at" bigint,
	CONSTRAINT "mail_copies_user_id_account_id_pk" PRIMARY KEY("user_id","account_id")
);
--> statement-breakpoint
ALTER TABLE "mail_copies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "mail_window" text DEFAULT 'year' NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_copies" ADD CONSTRAINT "mail_copies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_copies" ADD CONSTRAINT "mail_copies_user_id_account_id_mailboxes_user_id_id_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."mailboxes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_mail_window" CHECK ("preferences"."mail_window" IN ('year', 'three_years', 'all'));--> statement-breakpoint
CREATE POLICY "own" ON "mail_copies" AS PERMISSIVE FOR ALL TO "sift_app" USING (user_id = nullif(current_setting('sift.user', true), '')::integer) WITH CHECK (user_id = nullif(current_setting('sift.user', true), '')::integer);