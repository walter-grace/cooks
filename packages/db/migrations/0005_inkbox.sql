CREATE TYPE "public"."message_channel" AS ENUM('sms', 'imessage', 'a2a');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
ALTER TYPE "public"."step_action" ADD VALUE 'manual_imessage';--> statement-breakpoint
ALTER TYPE "public"."step_action" ADD VALUE 'auto_imessage';--> statement-breakpoint
ALTER TYPE "public"."step_action" ADD VALUE 'auto_ai_call';--> statement-breakpoint
ALTER TYPE "public"."mailbox_provider" ADD VALUE 'inkbox';--> statement-breakpoint
CREATE TABLE "channel_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text DEFAULT 'inkbox' NOT NULL,
	"api_key_encrypted" text NOT NULL,
	"webhook_token_encrypted" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "channel_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text DEFAULT 'inkbox' NOT NULL,
	"external_id" text NOT NULL,
	"handle" text NOT NULL,
	"display_name" text,
	"email_address" text,
	"phone_number" text,
	"phone_number_id" text,
	"sms_status" text,
	"imessage_number" text,
	"imessage_number_id" text,
	"user_id" uuid,
	"mailbox_id" uuid,
	"signing_key_encrypted" text,
	"subscription_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inbound_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"prospect_id" uuid,
	"account_id" uuid,
	"owner_id" uuid,
	"identity_id" uuid,
	"sequence_id" uuid,
	"sequence_state_id" uuid,
	"sequence_step_id" uuid,
	"task_id" uuid,
	"channel" "message_channel" NOT NULL,
	"direction" "message_direction" DEFAULT 'outbound' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"from_addr" text,
	"to_addr" text,
	"body" text,
	"media_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text,
	"provider_message_id" text,
	"conversation_id" text,
	"thread_id" text,
	"in_reply_to" text,
	"error" text,
	"block_reason" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"auto_submitted" boolean DEFAULT false NOT NULL,
	"raw" jsonb
);
--> statement-breakpoint
ALTER TABLE "prospects" ADD COLUMN "sms_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD COLUMN "body" text;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_identity_id_channel_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."channel_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sequence_state_id_sequence_states_id_fk" FOREIGN KEY ("sequence_state_id") REFERENCES "public"."sequence_states"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sequence_step_id_sequence_steps_id_fk" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_connections_ws_provider_uq" ON "channel_connections" USING btree ("workspace_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "channel_identities_ws_ext_uq" ON "channel_identities" USING btree ("workspace_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "channel_identities_ws_user_idx" ON "channel_identities" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inbound_events_uq" ON "inbound_events" USING btree ("workspace_id","provider","event_id");--> statement-breakpoint
CREATE INDEX "messages_ws_created_idx" ON "messages" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "messages_ws_prospect_idx" ON "messages" USING btree ("workspace_id","prospect_id");--> statement-breakpoint
CREATE INDEX "messages_ws_state_idx" ON "messages" USING btree ("workspace_id","sequence_state_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_ws_provider_msg_uq" ON "messages" USING btree ("workspace_id","provider","provider_message_id");