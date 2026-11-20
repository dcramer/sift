ALTER TABLE "suggestion_bodies" RENAME TO "read_bodies";--> statement-breakpoint
ALTER TABLE "read_bodies" DROP CONSTRAINT "suggestion_bodies_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "read_bodies" DROP CONSTRAINT "suggestion_bodies_user_id_account_id_mailboxes_user_id_id_fk";
--> statement-breakpoint
ALTER TABLE "read_bodies" DROP CONSTRAINT "suggestion_bodies_user_id_account_id_message_id_messages_user_id_account_id_id_fk";
--> statement-breakpoint
ALTER TABLE "read_bodies" DROP CONSTRAINT "suggestion_bodies_user_id_account_id_message_id_pk";--> statement-breakpoint
ALTER TABLE "read_bodies" ADD CONSTRAINT "read_bodies_user_id_account_id_message_id_pk" PRIMARY KEY("user_id","account_id","message_id");--> statement-breakpoint
ALTER TABLE "read_bodies" ADD CONSTRAINT "read_bodies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_bodies" ADD CONSTRAINT "read_bodies_user_id_account_id_mailboxes_user_id_id_fk" FOREIGN KEY ("user_id","account_id") REFERENCES "public"."mailboxes"("user_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "read_bodies" ADD CONSTRAINT "read_bodies_user_id_account_id_message_id_messages_user_id_account_id_id_fk" FOREIGN KEY ("user_id","account_id","message_id") REFERENCES "public"."messages"("user_id","account_id","id") ON DELETE no action ON UPDATE no action;