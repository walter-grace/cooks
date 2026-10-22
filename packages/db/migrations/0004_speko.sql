DROP INDEX "telephony_ws_uq";--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "speko_session_id" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "outcome" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "transcript" jsonb;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "end_reason" text;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "cost_usd" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "ai_config" jsonb;--> statement-breakpoint
CREATE INDEX "calls_speko_session_idx" ON "calls" USING btree ("speko_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telephony_ws_provider_uq" ON "telephony_connections" USING btree ("workspace_id","provider");