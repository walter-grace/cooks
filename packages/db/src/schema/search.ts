import { sql, type SQL } from 'drizzle-orm';
import { customType, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, workspaceId } from './_base.js';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * One row per searchable thing (or per transcript line), written by the indexer from the source
 * tables. Title is weighted above body; the generated tsvector gets a GIN index. `source_updated_at`
 * mirrors the source row's updated_at so the indexer can pick up only what changed.
 */
export const searchIndex = pgTable(
  'search_index',
  {
    id: id(),
    workspaceId: workspaceId(),
    /** prospect, account, call, transcript, signal, email, note, task, sequence */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    /** 0 for a whole record; the segment index for transcript lines. */
    chunk: integer('chunk').notNull().default(0),
    prospectId: uuid('prospect_id'),
    accountId: uuid('account_id'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
    tsv: tsvector('tsv').generatedAlwaysAs(
      (): SQL => sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('search_index_entity_uq').on(t.workspaceId, t.entityType, t.entityId, t.chunk),
    index('search_index_tsv_idx').using('gin', t.tsv),
    index('search_index_ws_type_idx').on(t.workspaceId, t.entityType, t.sourceUpdatedAt),
    index('search_index_ws_title_idx').on(t.workspaceId, sql`lower(${t.title})`),
  ],
);
