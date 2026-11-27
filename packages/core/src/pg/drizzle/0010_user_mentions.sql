CREATE TABLE "user_mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"author_id" text,
	"owner_id" text NOT NULL,
	"path" text NOT NULL,
	"snippet" text NOT NULL,
	"created_at" bigint NOT NULL,
	"delivered_at" bigint
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username_asked_at" bigint;--> statement-breakpoint
ALTER TABLE "user_mentions" ADD CONSTRAINT "user_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mentions" ADD CONSTRAINT "user_mentions_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_mentions" ADD CONSTRAINT "user_mentions_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_user_mentions_user" ON "user_mentions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_username" ON "users" USING btree ("username") WHERE username IS NOT NULL;