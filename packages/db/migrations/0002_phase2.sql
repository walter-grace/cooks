ALTER TYPE "public"."run_kind" ADD VALUE 'signals.scan' BEFORE 'nba';--> statement-breakpoint
ALTER TYPE "public"."run_kind" ADD VALUE 'coach_call' BEFORE 'nba';--> statement-breakpoint
CREATE TABLE "signal_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"kind_pattern" text NOT NULL,
	"min_score" numeric,
	"action" text NOT NULL,
	"sequence_id" uuid,
	"owner_id" uuid,
	"task_action" text,
	"task_note" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"fired_count" integer DEFAULT 0 NOT NULL,
	"last_fired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "telephony_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"account_sid" text NOT NULL,
	"auth_token_encrypted" text NOT NULL,
	"api_key_sid" text,
	"api_key_secret_encrypted" text,
	"twiml_app_sid" text,
	"from_numbers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"record" boolean DEFAULT true NOT NULL,
	"transcribe" boolean DEFAULT true NOT NULL,
	"coach" boolean DEFAULT true NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD COLUMN "stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "recording_sid" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "recording_duration_seconds" integer;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "logged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "task_id" uuid;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcript_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "coaching_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "mode" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "status" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "acted_action" text;--> statement-breakpoint
ALTER TABLE "signal_rules" ADD CONSTRAINT "signal_rules_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_rules_ws_idx" ON "signal_rules" USING btree ("workspace_id","enabled");--> statement-breakpoint
CREATE UNIQUE INDEX "telephony_ws_uq" ON "telephony_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "calls_provider_sid_idx" ON "calls" USING btree ("provider_call_sid");--> statement-breakpoint
CREATE INDEX "signals_ws_status_idx" ON "signals" USING btree ("workspace_id","status","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signals_ws_dedupe_uq" ON "signals" USING btree ("workspace_id","dedupe_key");