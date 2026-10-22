CREATE TYPE "public"."api_key_prefix" AS ENUM('cooks', 'nooks');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('user', 'manager', 'admin');--> statement-breakpoint
CREATE TYPE "public"."associated_type" AS ENUM('prospect', 'account');--> statement-breakpoint
CREATE TYPE "public"."contact_point_kind" AS ENUM('email', 'phone');--> statement-breakpoint
CREATE TYPE "public"."crm_type" AS ENUM('none', 'csv', 'salesforce', 'hubspot');--> statement-breakpoint
CREATE TYPE "public"."prospect_email_status" AS ENUM('unknown', 'valid', 'invalid', 'bounced', 'unsubscribed');--> statement-breakpoint
CREATE TYPE "public"."execution_status" AS ENUM('scheduled', 'running', 'sent', 'skipped', 'failed', 'task_created');--> statement-breakpoint
CREATE TYPE "public"."finish_reason" AS ENUM('completed', 'replied', 'unsubscribed', 'bounced', 'manual', 'removed', 'prospect_deleted', 'error');--> statement-breakpoint
CREATE TYPE "public"."privacy" AS ENUM('private', 'team_visible', 'team_editable');--> statement-breakpoint
CREATE TYPE "public"."reply_behavior" AS ENUM('finish', 'pause', 'continue');--> statement-breakpoint
CREATE TYPE "public"."sequence_state_state" AS ENUM('pending_start', 'active', 'paused', 'finished');--> statement-breakpoint
CREATE TYPE "public"."sequence_type" AS ENUM('interval', 'date');--> statement-breakpoint
CREATE TYPE "public"."step_action" AS ENUM('call', 'manual_email', 'auto_email', 'manual_email_reply', 'auto_email_reply', 'basic_task', 'linkedin_connection_request', 'manual_linkedin_connection_request', 'manual_linkedin_message', 'automatic_linkedin_message', 'manual_sms', 'auto_sms', 'manual_whatsapp');--> statement-breakpoint
CREATE TYPE "public"."step_phase" AS ENUM('idle', 'scheduled', 'awaiting_task', 'executing', 'done');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."template_source" AS ENUM('user', 'step_auto', 'ai');--> statement-breakpoint
CREATE TYPE "public"."email_direction" AS ENUM('outbound', 'inbound');--> statement-breakpoint
CREATE TYPE "public"."email_event_kind" AS ENUM('sent', 'delivered', 'opened', 'clicked', 'bounced', 'replied', 'unsubscribed', 'complained');--> statement-breakpoint
CREATE TYPE "public"."email_send_status" AS ENUM('draft', 'queued', 'sending', 'sent', 'failed', 'rejected', 'received');--> statement-breakpoint
CREATE TYPE "public"."mailbox_provider" AS ENUM('smtp', 'gmail', 'ms_graph');--> statement-breakpoint
CREATE TYPE "public"."suppression_reason" AS ENUM('unsubscribe', 'hard_bounce', 'manual', 'complaint');--> statement-breakpoint
CREATE TYPE "public"."call_direction" AS ENUM('inbound', 'outbound');--> statement-breakpoint
CREATE TYPE "public"."call_outcome" AS ENUM('connected', 'not_connected', 'meeting_booked', 'left_voicemail', 'no_answer', 'busy', 'wrong_number', 'do_not_call', 'other');--> statement-breakpoint
CREATE TYPE "public"."call_source" AS ENUM('dialer', 'manual', 'sequence', 'inbound', 'api');--> statement-breakpoint
CREATE TYPE "public"."agent_kind" AS ENUM('email_writer', 'reply_classifier', 'researcher', 'next_best_action');--> statement-breakpoint
CREATE TYPE "public"."ai_provider" AS ENUM('anthropic', 'openai', 'xai', 'openrouter', 'ollama', 'custom');--> statement-breakpoint
CREATE TYPE "public"."run_kind" AS ENUM('draft_email', 'classify_reply', 'research', 'nba', 'agent_loop', 'mcp_tool_call');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'succeeded', 'failed', 'exhausted');--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key_id" text NOT NULL,
	"secret_hash" text NOT NULL,
	"prefix" "api_key_prefix" DEFAULT 'cooks' NOT NULL,
	"name" text NOT NULL,
	"created_by" uuid,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" text,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"name" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"grant_types" jsonb DEFAULT '["authorization_code","refresh_token"]'::jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"allowed_scopes" jsonb,
	"is_dynamic" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_client_id_unique" UNIQUE("client_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scopes" jsonb NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_from" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"alg" text DEFAULT 'ES256' NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk_encrypted" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"crm_id" text,
	"timezone" text,
	"title" text,
	"phone" text,
	"calendar_url" text,
	"signature_html" text,
	"password_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text,
	"domain" text,
	"num_employees" integer,
	"linkedin_url" text,
	"description" text,
	"industry" text,
	"website" text,
	"city" text,
	"timezone" text,
	"crm_id" text,
	"crm_type" "crm_type",
	"crm_custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crm_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"type" "crm_type" DEFAULT 'none' NOT NULL,
	"status" text DEFAULT 'disconnected' NOT NULL,
	"credentials_encrypted" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"associated_type" "associated_type" NOT NULL,
	"associated_id" uuid NOT NULL,
	"text" text NOT NULL,
	"integration_type" text NOT NULL,
	"external_id" text,
	"user_external_id" text,
	"user_name" text,
	"created_by" uuid,
	"external_created_at" timestamp with time zone,
	"external_updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"account_id" uuid,
	"prospect_id" uuid,
	"name" text,
	"stage" text,
	"amount_cents" integer,
	"close_date" timestamp with time zone,
	"crm_id" text,
	"crm_custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospect_contact_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"kind" "contact_point_kind" NOT NULL,
	"value" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prospects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"account_id" uuid,
	"first_name" text,
	"last_name" text,
	"name" text,
	"title" text,
	"primary_email" text,
	"phone" text,
	"linkedin_url" text,
	"city" text,
	"state" text,
	"country" text,
	"timezone" text,
	"crm_id" text,
	"crm_type" "crm_type",
	"crm_custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"email_status" "prospect_email_status" DEFAULT 'unknown' NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"owner_id" uuid
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_counters" (
	"workspace_id" uuid NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" uuid NOT NULL,
	"metric" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "analytics_counters_scope_type_scope_id_metric_pk" PRIMARY KEY("scope_type","scope_id","metric")
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text,
	"subject" text,
	"html_body" text,
	"text_body" text,
	"source" "template_source" DEFAULT 'user' NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"order" integer DEFAULT 0 NOT NULL,
	"owner_id" uuid,
	"privacy" "privacy" DEFAULT 'team_editable' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"sequence_id" uuid NOT NULL,
	"prospect_id" uuid NOT NULL,
	"account_id" uuid,
	"owner_id" uuid NOT NULL,
	"creator_id" uuid,
	"mailbox_id" uuid,
	"state" "sequence_state_state" DEFAULT 'active' NOT NULL,
	"step_phase" "step_phase" DEFAULT 'idle' NOT NULL,
	"current_step_id" uuid,
	"current_step_order" integer,
	"scheduled_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"last_step_done_at" timestamp with time zone,
	"hold_reason" text,
	"finish_reason" "finish_reason",
	"finished_at" timestamp with time zone,
	"pending_job_id" text,
	"reply_behavior" "reply_behavior",
	"email_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_step_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"step_id" uuid NOT NULL,
	"email_template_id" uuid NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"sequence_id" uuid NOT NULL,
	"order" integer NOT NULL,
	"name" text,
	"note" text,
	"action" "step_action" NOT NULL,
	"interval_minutes" integer DEFAULT 0 NOT NULL,
	"email_template_id" uuid,
	"ai_email" jsonb,
	"has_ab_variants" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sequence_tags" (
	"sequence_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	CONSTRAINT "sequence_tags_sequence_id_tag_id_pk" PRIMARY KEY("sequence_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"type" "sequence_type" DEFAULT 'interval' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"privacy" "privacy" DEFAULT 'team_editable' NOT NULL,
	"owner_id" uuid NOT NULL,
	"parent_sequence_id" uuid,
	"parent_sequence_step_id" uuid,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "step_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence_state_id" uuid NOT NULL,
	"sequence_step_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "execution_status" DEFAULT 'scheduled' NOT NULL,
	"task_id" uuid,
	"email_id" uuid,
	"result" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"prospect_id" uuid NOT NULL,
	"account_id" uuid,
	"owner_id" uuid NOT NULL,
	"action" "step_action" NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"note" text,
	"sequence_id" uuid,
	"sequence_state_id" uuid,
	"sequence_step_id" uuid,
	"draft_email_id" uuid,
	"completed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "email_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email_id" uuid NOT NULL,
	"kind" "email_event_kind" NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rolled_up_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"prospect_id" uuid,
	"account_id" uuid,
	"task_id" uuid,
	"sequence_id" uuid,
	"sequence_state_id" uuid,
	"sequence_step_id" uuid,
	"mailbox_id" uuid,
	"owner_id" uuid,
	"type" text,
	"direction" "email_direction" DEFAULT 'outbound' NOT NULL,
	"status" "email_send_status" DEFAULT 'draft' NOT NULL,
	"from_addr" text,
	"to_addr" text,
	"recipients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"bcc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text,
	"body_text" text,
	"body_html" text,
	"message_id" text,
	"thread_id" text,
	"in_reply_to" text,
	"provider_message_id" text,
	"date" timestamp with time zone,
	"send_started_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"replied_at" timestamp with time zone,
	"open_count" integer DEFAULT 0 NOT NULL,
	"click_count" integer DEFAULT 0 NOT NULL,
	"reject_reason" text,
	"error" text,
	"variant_id" uuid,
	"auto_submitted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_credentials" (
	"mailbox_id" uuid PRIMARY KEY NOT NULL,
	"encrypted" text NOT NULL,
	"expires_at" timestamp with time zone,
	"sync_cursor" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_send_state" (
	"mailbox_id" uuid PRIMARY KEY NOT NULL,
	"last_sent_at" timestamp with time zone,
	"day_date" date,
	"day_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"provider" "mailbox_provider" DEFAULT 'smtp' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"daily_send_limit" integer DEFAULT 50 NOT NULL,
	"min_gap_seconds" integer DEFAULT 60 NOT NULL,
	"signature_html" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email_lower" text,
	"domain" text,
	"reason" "suppression_reason" NOT NULL,
	"source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracking_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email_id" uuid NOT NULL,
	"token" text NOT NULL,
	"url" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tracking_links_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "call_dispositions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"call_outcome" "call_outcome" DEFAULT 'other' NOT NULL,
	"order" integer
);
--> statement-breakpoint
CREATE TABLE "call_recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"url" text,
	"storage_key" text,
	"duration_seconds" integer,
	"format" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"provider" text,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"text" text,
	"summary" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"prospect_id" uuid,
	"account_id" uuid,
	"owner_id" uuid,
	"sequence_id" uuid,
	"sequence_state_id" uuid,
	"sequence_step_id" uuid,
	"call_disposition_id" uuid,
	"source" "call_source" DEFAULT 'manual' NOT NULL,
	"direction" "call_direction" DEFAULT 'outbound' NOT NULL,
	"from_number" text,
	"to_number" text,
	"status" text DEFAULT 'completed' NOT NULL,
	"duration_seconds" integer DEFAULT 0 NOT NULL,
	"time" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"notes" text,
	"recording_url" text,
	"transcript_url" text,
	"provider" text,
	"provider_call_sid" text,
	"amd_result" text
);
--> statement-breakpoint
CREATE TABLE "coaching_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"call_id" uuid NOT NULL,
	"rubric" text NOT NULL,
	"score" numeric,
	"feedback" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"prospect_id" uuid,
	"account_id" uuid,
	"kind" text NOT NULL,
	"source" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"score" numeric,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_logs" (
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"line" text NOT NULL,
	"data" jsonb,
	CONSTRAINT "agent_run_logs_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid,
	"kind" "run_kind" NOT NULL,
	"provider" text,
	"model" text,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"parent_type" text,
	"parent_id" text,
	"input_hash" text,
	"input_redacted" jsonb,
	"output" jsonb,
	"turns" integer DEFAULT 0 NOT NULL,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"tokens_cache_read" integer DEFAULT 0 NOT NULL,
	"tokens_cache_write" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6),
	"latency_ms" integer,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"name" text NOT NULL,
	"kind" "agent_kind" DEFAULT 'email_writer' NOT NULL,
	"persona" text,
	"system_prompt" text,
	"style" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"never_mention" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"examples" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider_override" text,
	"model_override" text,
	"temperature" numeric,
	"prompt_version" integer DEFAULT 1 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_cache" (
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" integer NOT NULL,
	"input_hash" text NOT NULL,
	"output" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_cache_kind_model_prompt_version_input_hash_pk" PRIMARY KEY("kind","model","prompt_version","input_hash")
);
--> statement-breakpoint
CREATE TABLE "workspace_ai_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"provider" "ai_provider" DEFAULT 'anthropic' NOT NULL,
	"model" text,
	"base_url" text,
	"api_key_ciphertext" text,
	"api_key_last4" text,
	"classify_model" text,
	"draft_model" text,
	"auto_send_ai_email" boolean DEFAULT false NOT NULL,
	"confidence_threshold" numeric DEFAULT '0.75' NOT NULL,
	"monthly_budget_usd" numeric,
	"log_raw_prompts" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"diff" jsonb,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_workspace_id_key_pk" PRIMARY KEY("workspace_id","key")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"dedupe_key" text,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"workspace_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_workspace_id_bucket_window_start_pk" PRIMARY KEY("workspace_id","bucket","window_start")
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"dedupe_key" text,
	"payload" jsonb NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"response_status" integer,
	"response_ms" integer,
	"error" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"url" text NOT NULL,
	"secret_encrypted" text NOT NULL,
	"events" jsonb DEFAULT '["*"]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_by" uuid,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospect_contact_points" ADD CONSTRAINT "prospect_contact_points_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prospects" ADD CONSTRAINT "prospects_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_states" ADD CONSTRAINT "sequence_states_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_states" ADD CONSTRAINT "sequence_states_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_states" ADD CONSTRAINT "sequence_states_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_variants" ADD CONSTRAINT "sequence_step_variants_step_id_sequence_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_step_variants" ADD CONSTRAINT "sequence_step_variants_email_template_id_email_templates_id_fk" FOREIGN KEY ("email_template_id") REFERENCES "public"."email_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_steps" ADD CONSTRAINT "sequence_steps_email_template_id_email_templates_id_fk" FOREIGN KEY ("email_template_id") REFERENCES "public"."email_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_tags" ADD CONSTRAINT "sequence_tags_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sequence_tags" ADD CONSTRAINT "sequence_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "step_executions" ADD CONSTRAINT "step_executions_sequence_state_id_sequence_states_id_fk" FOREIGN KEY ("sequence_state_id") REFERENCES "public"."sequence_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_sequence_state_id_sequence_states_id_fk" FOREIGN KEY ("sequence_state_id") REFERENCES "public"."sequence_states"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_events" ADD CONSTRAINT "email_events_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_sequence_state_id_sequence_states_id_fk" FOREIGN KEY ("sequence_state_id") REFERENCES "public"."sequence_states"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_sequence_step_id_sequence_steps_id_fk" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "emails" ADD CONSTRAINT "emails_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_credentials" ADD CONSTRAINT "mailbox_credentials_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_send_state" ADD CONSTRAINT "mailbox_send_state_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracking_links" ADD CONSTRAINT "tracking_links_email_id_emails_id_fk" FOREIGN KEY ("email_id") REFERENCES "public"."emails"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_recordings" ADD CONSTRAINT "call_recordings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_transcripts" ADD CONSTRAINT "call_transcripts_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_sequence_id_sequences_id_fk" FOREIGN KEY ("sequence_id") REFERENCES "public"."sequences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_sequence_state_id_sequence_states_id_fk" FOREIGN KEY ("sequence_state_id") REFERENCES "public"."sequence_states"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_sequence_step_id_sequence_steps_id_fk" FOREIGN KEY ("sequence_step_id") REFERENCES "public"."sequence_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_call_disposition_id_call_dispositions_id_fk" FOREIGN KEY ("call_disposition_id") REFERENCES "public"."call_dispositions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coaching_scores" ADD CONSTRAINT "coaching_scores_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_prospect_id_prospects_id_fk" FOREIGN KEY ("prospect_id") REFERENCES "public"."prospects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_logs" ADD CONSTRAINT "agent_run_logs_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_keys_ws_idx" ON "api_keys" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_consents_uq" ON "oauth_consents" USING btree ("user_id","client_id","workspace_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_family_idx" ON "oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_ci_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_members_uq" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "accounts_ws_created_idx" ON "accounts" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "accounts_ws_updated_idx" ON "accounts" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "accounts_ws_domain_idx" ON "accounts" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE INDEX "accounts_ws_crm_idx" ON "accounts" USING btree ("workspace_id","crm_id");--> statement-breakpoint
CREATE INDEX "accounts_ws_name_idx" ON "accounts" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "crm_connections_ws_uq" ON "crm_connections" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "notes_ws_assoc_idx" ON "notes" USING btree ("workspace_id","associated_type","associated_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prospect_contact_points_uq" ON "prospect_contact_points" USING btree ("workspace_id","prospect_id","kind","value");--> statement-breakpoint
CREATE INDEX "prospects_ws_created_idx" ON "prospects" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "prospects_ws_updated_idx" ON "prospects" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "prospects_ws_email_idx" ON "prospects" USING btree ("workspace_id",lower("primary_email"));--> statement-breakpoint
CREATE INDEX "prospects_ws_crm_idx" ON "prospects" USING btree ("workspace_id","crm_id");--> statement-breakpoint
CREATE INDEX "prospects_ws_account_idx" ON "prospects" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE INDEX "prospects_ws_name_idx" ON "prospects" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE INDEX "prospects_ws_title_idx" ON "prospects" USING btree ("workspace_id",lower("title"));--> statement-breakpoint
CREATE UNIQUE INDEX "tags_ws_name_ci_uq" ON "tags" USING btree ("workspace_id",lower("name")) WHERE "tags"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tags_ws_created_idx" ON "tags" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "email_templates_ws_created_idx" ON "email_templates" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "email_templates_ws_updated_idx" ON "email_templates" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "email_templates_ws_owner_idx" ON "email_templates" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE INDEX "email_templates_ws_archived_idx" ON "email_templates" USING btree ("workspace_id","archived");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_states_active_uq" ON "sequence_states" USING btree ("workspace_id","sequence_id","prospect_id") WHERE "sequence_states"."deleted_at" IS NULL AND "sequence_states"."state" <> 'finished';--> statement-breakpoint
CREATE INDEX "sequence_states_ws_created_idx" ON "sequence_states" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sequence_states_ws_updated_idx" ON "sequence_states" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "sequence_states_ws_state_idx" ON "sequence_states" USING btree ("workspace_id","state");--> statement-breakpoint
CREATE INDEX "sequence_states_ws_prospect_idx" ON "sequence_states" USING btree ("workspace_id","prospect_id");--> statement-breakpoint
CREATE INDEX "sequence_states_ws_account_idx" ON "sequence_states" USING btree ("workspace_id","account_id");--> statement-breakpoint
CREATE INDEX "sequence_states_ws_sequence_idx" ON "sequence_states" USING btree ("workspace_id","sequence_id");--> statement-breakpoint
CREATE INDEX "sequence_states_next_run_idx" ON "sequence_states" USING btree ("workspace_id","next_run_at") WHERE "sequence_states"."state" = 'active';--> statement-breakpoint
CREATE INDEX "sequence_steps_seq_order_idx" ON "sequence_steps" USING btree ("sequence_id","order");--> statement-breakpoint
CREATE INDEX "sequence_steps_ws_created_idx" ON "sequence_steps" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sequence_steps_ws_updated_idx" ON "sequence_steps" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sequence_steps_one_li_cr_uq" ON "sequence_steps" USING btree ("sequence_id") WHERE "sequence_steps"."action" = 'linkedin_connection_request' AND "sequence_steps"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "sequences_ws_created_idx" ON "sequences" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "sequences_ws_updated_idx" ON "sequences" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "sequences_ws_owner_idx" ON "sequences" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE INDEX "sequences_ws_parent_idx" ON "sequences" USING btree ("workspace_id","parent_sequence_id");--> statement-breakpoint
CREATE INDEX "sequences_ws_name_idx" ON "sequences" USING btree ("workspace_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "step_executions_once_uq" ON "step_executions" USING btree ("sequence_state_id","sequence_step_id");--> statement-breakpoint
CREATE INDEX "tasks_ws_created_idx" ON "tasks" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tasks_ws_updated_idx" ON "tasks" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_ws_owner_due_idx" ON "tasks" USING btree ("workspace_id","owner_id","due_at");--> statement-breakpoint
CREATE INDEX "tasks_ws_status_idx" ON "tasks" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "tasks_ws_prospect_idx" ON "tasks" USING btree ("workspace_id","prospect_id");--> statement-breakpoint
CREATE INDEX "tasks_ws_state_idx" ON "tasks" USING btree ("workspace_id","sequence_state_id");--> statement-breakpoint
CREATE INDEX "tasks_ws_due_idx" ON "tasks" USING btree ("workspace_id","due_at");--> statement-breakpoint
CREATE INDEX "email_events_email_idx" ON "email_events" USING btree ("email_id","kind");--> statement-breakpoint
CREATE INDEX "email_events_pending_idx" ON "email_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "emails_ws_created_idx" ON "emails" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "emails_ws_updated_idx" ON "emails" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "emails_ws_prospect_idx" ON "emails" USING btree ("workspace_id","prospect_id");--> statement-breakpoint
CREATE INDEX "emails_ws_task_idx" ON "emails" USING btree ("workspace_id","task_id");--> statement-breakpoint
CREATE INDEX "emails_ws_status_idx" ON "emails" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "emails_ws_message_id_idx" ON "emails" USING btree ("workspace_id","message_id");--> statement-breakpoint
CREATE INDEX "emails_ws_thread_idx" ON "emails" USING btree ("workspace_id","thread_id");--> statement-breakpoint
CREATE INDEX "emails_ws_state_idx" ON "emails" USING btree ("workspace_id","sequence_state_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_ws_email_uq" ON "mailboxes" USING btree ("workspace_id","email");--> statement-breakpoint
CREATE INDEX "mailboxes_ws_user_idx" ON "mailboxes" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE INDEX "mailboxes_ws_created_idx" ON "mailboxes" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "mailboxes_ws_updated_idx" ON "mailboxes" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_ws_email_uq" ON "suppressions" USING btree ("workspace_id","email_lower");--> statement-breakpoint
CREATE INDEX "suppressions_ws_domain_idx" ON "suppressions" USING btree ("workspace_id","domain");--> statement-breakpoint
CREATE INDEX "tracking_links_email_idx" ON "tracking_links" USING btree ("email_id");--> statement-breakpoint
CREATE INDEX "call_dispositions_ws_idx" ON "call_dispositions" USING btree ("workspace_id","order");--> statement-breakpoint
CREATE INDEX "calls_ws_created_idx" ON "calls" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "calls_ws_updated_idx" ON "calls" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "calls_ws_time_idx" ON "calls" USING btree ("workspace_id","time");--> statement-breakpoint
CREATE INDEX "calls_ws_prospect_idx" ON "calls" USING btree ("workspace_id","prospect_id");--> statement-breakpoint
CREATE INDEX "calls_ws_owner_idx" ON "calls" USING btree ("workspace_id","owner_id");--> statement-breakpoint
CREATE INDEX "signals_ws_kind_idx" ON "signals" USING btree ("workspace_id","kind","occurred_at");--> statement-breakpoint
CREATE INDEX "agent_runs_ws_created_idx" ON "agent_runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_parent_idx" ON "agent_runs" USING btree ("parent_type","parent_id");--> statement-breakpoint
CREATE INDEX "ai_agents_ws_idx" ON "ai_agents" USING btree ("workspace_id","kind");--> statement-breakpoint
CREATE INDEX "audit_log_ws_idx" ON "audit_log" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox_events" USING btree ("occurred_at") WHERE "outbox_events"."published_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_uq" ON "webhook_deliveries" USING btree ("endpoint_id","event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_status_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_ws_idx" ON "webhook_endpoints" USING btree ("workspace_id","enabled");