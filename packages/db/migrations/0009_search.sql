CREATE TABLE "search_index" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"chunk" integer DEFAULT 0 NOT NULL,
	"prospect_id" uuid,
	"account_id" uuid,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')) STORED
);
--> statement-breakpoint
CREATE UNIQUE INDEX "search_index_entity_uq" ON "search_index" USING btree ("workspace_id","entity_type","entity_id","chunk");--> statement-breakpoint
CREATE INDEX "search_index_tsv_idx" ON "search_index" USING gin ("tsv");--> statement-breakpoint
CREATE INDEX "search_index_ws_type_idx" ON "search_index" USING btree ("workspace_id","entity_type","source_updated_at");--> statement-breakpoint
CREATE INDEX "search_index_ws_title_idx" ON "search_index" USING btree ("workspace_id",lower("title"));