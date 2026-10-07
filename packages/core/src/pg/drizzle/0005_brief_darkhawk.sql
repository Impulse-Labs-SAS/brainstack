CREATE TABLE "crawl_history" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"source" text NOT NULL,
	"client_ref" text,
	"prompt" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "crawl_history_source_check" CHECK (source IN ('assistant', 'web'))
);
--> statement-breakpoint
ALTER TABLE "crawl_history" ADD CONSTRAINT "crawl_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_crawl_history_user_created" ON "crawl_history" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_crawl_history_created" ON "crawl_history" USING btree ("created_at");