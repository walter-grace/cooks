CREATE TABLE "dial_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid,
	"dedupe_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dial_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"batch" integer DEFAULT 0 NOT NULL,
	"prospect_id" uuid,
	"task_id" uuid,
	"call_id" uuid,
	"to_number" text,
	"provider_call_sid" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"answered_by" text,
	"skip_reason" text,
	"end_reason" text,
	"recording_sid" text,
	"callback_task_id" uuid,
	"answered_at" timestamp with time zone,
	"amd_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dial_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"status" text DEFAULT 'waiting_rep' NOT NULL,
	"rep_mode" text DEFAULT 'browser' NOT NULL,
	"rep_phone" text,
	"rep_call_sid" text,
	"from_number" text NOT NULL,
	"conference_name" text NOT NULL,
	"conference_sid" text,
	"max_lines" integer DEFAULT 3 NOT NULL,
	"compliance_mode" text DEFAULT 'b2b' NOT NULL,
	"auto_dial" boolean DEFAULT false NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"batch" integer DEFAULT 0 NOT NULL,
	"connected_line_id" uuid,
	"connected_at" timestamp with time zone,
	"rep_joined_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dial_events" ADD CONSTRAINT "dial_events_session_id_dial_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dial_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dial_lines" ADD CONSTRAINT "dial_lines_session_id_dial_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."dial_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dial_lines" ADD CONSTRAINT "dial_lines_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dial_lines" ADD CONSTRAINT "dial_lines_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dial_events_dedupe_uq" ON "dial_events" USING btree ("workspace_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "dial_events_session_idx" ON "dial_events" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "dial_lines_session_idx" ON "dial_lines" USING btree ("session_id","batch","status");--> statement-breakpoint
CREATE INDEX "dial_lines_sid_idx" ON "dial_lines" USING btree ("provider_call_sid");--> statement-breakpoint
CREATE INDEX "dial_lines_ws_created_idx" ON "dial_lines" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "dial_sessions_ws_idx" ON "dial_sessions" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "dial_sessions_rep_sid_idx" ON "dial_sessions" USING btree ("rep_call_sid");--> statement-breakpoint
CREATE UNIQUE INDEX "dial_sessions_conf_uq" ON "dial_sessions" USING btree ("conference_name");