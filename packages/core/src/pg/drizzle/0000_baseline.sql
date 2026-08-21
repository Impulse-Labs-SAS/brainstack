CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "api_keys_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "email_verification_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	CONSTRAINT "email_verification_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "folder_share_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"folder_path" text NOT NULL,
	"owner_id" text NOT NULL,
	"mode" text NOT NULL,
	"invitee_email" text,
	"token_hash" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"accepted_at" bigint,
	"accepted_by_user_id" text,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "folder_share_invites_token_hash_key" UNIQUE("token_hash"),
	CONSTRAINT "folder_share_invites_mode_check" CHECK (mode IN ('email', 'link'))
);
--> statement-breakpoint
CREATE TABLE "folder_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"folder_path" text NOT NULL,
	"owner_id" text NOT NULL,
	"shared_with_user_id" text NOT NULL,
	"granted_at" bigint NOT NULL,
	"granted_by" text NOT NULL,
	CONSTRAINT "folder_shares_folder_path_owner_id_shared_with_user_id_key" UNIQUE("folder_path","owner_id","shared_with_user_id")
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"path" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "links" (
	"source_path" text NOT NULL,
	"target_path" text NOT NULL,
	"target_type" text NOT NULL,
	"link_kind" text NOT NULL,
	"alias" text,
	"section" text,
	"position" integer NOT NULL,
	CONSTRAINT "links_pkey" PRIMARY KEY("source_path","target_path","position")
);
--> statement-breakpoint
CREATE TABLE "magic_link_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed_at" bigint,
	CONSTRAINT "magic_link_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"path" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"updated_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"checksum" text NOT NULL,
	"owner_id" text,
	"body_tsv" "tsvector" GENERATED ALWAYS AS ((
       setweight(to_tsvector('simple',  coalesce(title, '')), 'A') ||
       setweight(to_tsvector('spanish', coalesce(title, '')), 'A') ||
       setweight(to_tsvector('simple',  coalesce(body,  '')), 'B') ||
       setweight(to_tsvector('spanish', coalesce(body,  '')), 'B')
     )) STORED
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect_to" text,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"used_at" bigint,
	CONSTRAINT "password_reset_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"user_agent" text,
	"ip_address" text,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"note_path" text NOT NULL,
	"tag" text NOT NULL,
	CONSTRAINT "tags_pkey" PRIMARY KEY("note_path","tag")
);
--> statement-breakpoint
CREATE TABLE "totp_backup_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"code_hash" text NOT NULL,
	"used_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "totp_backup_codes_code_hash_key" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"created_at" bigint NOT NULL,
	"last_login_at" bigint,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"google_id" text,
	"totp_secret" text,
	"updated_at" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "users_email_key" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_share_invites" ADD CONSTRAINT "folder_share_invites_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_share_invites" ADD CONSTRAINT "folder_share_invites_accepted_by_user_id_users_id_fk" FOREIGN KEY ("accepted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_shares" ADD CONSTRAINT "folder_shares_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_shares" ADD CONSTRAINT "folder_shares_shared_with_user_id_users_id_fk" FOREIGN KEY ("shared_with_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folder_shares" ADD CONSTRAINT "folder_shares_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "links" ADD CONSTRAINT "links_source_path_notes_path_fk" FOREIGN KEY ("source_path") REFERENCES "public"."notes"("path") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_note_path_notes_path_fk" FOREIGN KEY ("note_path") REFERENCES "public"."notes"("path") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_backup_codes" ADD CONSTRAINT "totp_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_api_keys_hash" ON "api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_api_keys_user" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_email_verification_user" ON "email_verification_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_share_invites_owner" ON "folder_share_invites" USING btree ("owner_id","folder_path");--> statement-breakpoint
CREATE INDEX "idx_share_invites_email" ON "folder_share_invites" USING btree ("invitee_email");--> statement-breakpoint
CREATE INDEX "idx_folder_shares_target" ON "folder_shares" USING btree ("shared_with_user_id","folder_path");--> statement-breakpoint
CREATE INDEX "idx_folder_shares_owner" ON "folder_shares" USING btree ("owner_id","folder_path");--> statement-breakpoint
CREATE INDEX "idx_folders_owner" ON "folders" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_links_target" ON "links" USING btree ("target_path");--> statement-breakpoint
CREATE INDEX "idx_links_source" ON "links" USING btree ("source_path");--> statement-breakpoint
CREATE INDEX "idx_magic_token_hash" ON "magic_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_notes_tsv" ON "notes" USING gin ("body_tsv");--> statement-breakpoint
CREATE INDEX "idx_notes_updated_at" ON "notes" USING btree ("updated_at" desc);--> statement-breakpoint
CREATE INDEX "idx_notes_owner" ON "notes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_password_reset_user" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_tags_tag" ON "tags" USING btree ("tag");--> statement-breakpoint
CREATE INDEX "idx_totp_backup_user" ON "totp_backup_codes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_google_id" ON "users" USING btree ("google_id") WHERE google_id IS NOT NULL;