import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, tenant, timestamps, workspaceId } from './_base.js';

export const deliveryStatus = pgEnum('delivery_status', ['pending', 'succeeded', 'failed', 'exhausted']);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: id(),
    workspaceId: workspaceId(),
    eventType: text('event_type').notNull(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: text('aggregate_id').notNull(),
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [index('outbox_unpublished_idx').on(t.occurredAt).where(sql`${t.publishedAt} IS NULL`)],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    ...tenant(),
    url: text('url').notNull(),
    secretEncrypted: text('secret_encrypted').notNull(),
    events: jsonb('events').$type<string[]>().notNull().default(['*']),
    enabled: boolean('enabled').notNull().default(true),
    description: text('description'),
    createdBy: uuid('created_by'),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastFailureAt: timestamp('last_failure_at', { withTimezone: true }),
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  },
  (t) => [index('webhook_endpoints_ws_idx').on(t.workspaceId, t.enabled)],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: id(),
    workspaceId: workspaceId(),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: 'cascade' }),
    eventId: uuid('event_id').notNull(),
    eventType: text('event_type').notNull(),
    dedupeKey: text('dedupe_key'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    attempt: integer('attempt').notNull().default(0),
    status: deliveryStatus('status').notNull().default('pending'),
    responseStatus: integer('response_status'),
    responseMs: integer('response_ms'),
    error: text('error'),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('webhook_deliveries_uq').on(t.endpointId, t.eventId),
    index('webhook_deliveries_status_idx').on(t.status, t.nextAttemptAt),
  ],
);

export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    workspaceId: workspaceId(),
    bucket: text('bucket').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.bucket, t.windowStart] })],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: id(),
    workspaceId: workspaceId(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    diff: jsonb('diff').$type<Record<string, unknown>>(),
    traceId: text('trace_id'),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('audit_log_ws_idx').on(t.workspaceId, t.createdAt)],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    workspaceId: workspaceId(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.key] })],
);
