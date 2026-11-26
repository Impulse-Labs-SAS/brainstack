CREATE TABLE "move_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"from_owner_id" text NOT NULL,
	"from_path" text NOT NULL,
	"to_owner_id" text NOT NULL,
	"to_path" text NOT NULL,
	"requested_by" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "move_requests" ADD CONSTRAINT "move_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_requests" ADD CONSTRAINT "move_requests_from_owner_id_users_id_fk" FOREIGN KEY ("from_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "move_requests" ADD CONSTRAINT "move_requests_to_owner_id_users_id_fk" FOREIGN KEY ("to_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_move_requests_user" ON "move_requests" USING btree ("user_id","created_at");