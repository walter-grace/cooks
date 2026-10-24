CREATE TYPE "public"."auth_token_kind" AS ENUM('verify', 'reset', 'invite');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "auth_token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"user_id" uuid,
	"workspace_id" uuid,
	"role" "member_role",
	"invited_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "auth_tokens_kind_email_idx" ON "auth_tokens" USING btree ("kind",lower("email"));--> statement-breakpoint
CREATE INDEX "auth_tokens_ws_idx" ON "auth_tokens" USING btree ("workspace_id","kind");