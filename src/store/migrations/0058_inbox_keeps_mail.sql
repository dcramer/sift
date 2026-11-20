CREATE TABLE "mail_bodies" (
	"user_id" integer DEFAULT current_setting('sift.user')::integer NOT NULL,
	"account_id" text NOT NULL,
	"message_id" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"fetched_at" bigint NOT NULL,
	CONSTRAINT "mail_bodies_user_id_account_id_message_id_pk" PRIMARY KEY("user_id","account_id","message_id")
);
--> statement-breakpoint
ALTER TABLE "mail_bodies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "preferences" ADD COLUMN "mail" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_bodies" ADD CONSTRAINT "mail_bodies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_bodies" ADD CONSTRAINT "mail_bodies_user_id_account_id_mailboxes_user_id_id_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."mailboxes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_bodies" ADD CONSTRAINT "mail_bodies_user_id_account_id_message_id_messages_user_id_account_id_id_fk" FOREIGN KEY ("user_id","account_id","message_id") REFERENCES "public"."messages"("user_id","account_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE POLICY "own" ON "mail_bodies" AS PERMISSIVE FOR ALL TO "sift_app" USING (user_id = nullif(current_setting('sift.user', true), '')::integer) WITH CHECK (user_id = nullif(current_setting('sift.user', true), '')::integer);