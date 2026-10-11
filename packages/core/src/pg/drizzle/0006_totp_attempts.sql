ALTER TABLE "users" ADD COLUMN "totp_failed_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_locked_until" bigint;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_last_step" bigint;