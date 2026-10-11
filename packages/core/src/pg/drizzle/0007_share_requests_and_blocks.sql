CREATE TABLE "share_blocks" (
	"user_id" text NOT NULL,
	"blocked_owner_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "share_blocks_pkey" PRIMARY KEY("user_id","blocked_owner_id")
);
--> statement-breakpoint
CREATE TABLE "share_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"folder_path" text NOT NULL,
	"email" text NOT NULL,
	"permission" text DEFAULT 'read' NOT NULL,
	"requested_by" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "share_requests_permission_check" CHECK (permission IN ('read', 'write'))
);
--> statement-breakpoint
ALTER TABLE "share_blocks" ADD CONSTRAINT "share_blocks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_blocks" ADD CONSTRAINT "share_blocks_blocked_owner_id_users_id_fk" FOREIGN KEY ("blocked_owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_requests" ADD CONSTRAINT "share_requests_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_share_requests_owner" ON "share_requests" USING btree ("owner_id","created_at");