import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { outboxEvents, webhookDeliveries, webhookEndpoints, type DbOrTx } from '@cooks/db';
import { decrypt } from '../crypto.js';
import type { JobsPort } from '../jobs.js';
import { signWebhook } from './sign.js';

/** Retry schedule after a failed attempt (seconds), ±20 % jitter; sums to roughly 30 minutes. */
export const RETRY_DELAYS_S = [30, 60, 120, 240, 360, 480, 540];
export const MAX_ATTEMPTS = 8;
export const DELIVERY_TIMEOUT_MS = 15_000;
export const AUTO_DISABLE_AFTER = 50;

export function readSecret(stored: string, kek: string | undefined): string {
  if (stored.startsWith('plain:')) return stored.slice(6);
  if (!kek) throw new Error('Webhook secret is encrypted but COOKS_KEK is not set');
  return decrypt(stored, kek);
}

export function dedupeKeyFor(eventType: string, payload: Record<string, unknown>, eventId: string): string {
  if (eventType === 'call.logged') return String((payload.callData as { callId?: string } | undefined)?.callId ?? eventId);
  if (eventType.startsWith('email.')) return `${payload.emailId}:${eventType.split('.')[1]}`;
  if (eventType.startsWith('sequence_state.')) return `${payload.sequenceStateId}:${eventType.split('.')[1]}`;
  return eventId;
}

/** Wire envelope. `call.logged` keeps the upstream shape; everything else is `{event, eventId, occurredAt, data}`. */
export function envelopeFor(eventType: string, eventId: string, occurredAt: Date, payload: Record<string, unknown>): Record<string, unknown> {
  if (eventType === 'call.logged') return { event: eventType, eventId, occurredAt: occurredAt.toISOString(), callData: payload.callData ?? payload };
  return { event: eventType, eventId, occurredAt: occurredAt.toISOString(), data: payload };
}

/**
 * Fan unpublished outbox rows out to matching endpoints. Safe with many workers:
 * rows are claimed with FOR UPDATE SKIP LOCKED inside one transaction.
 */
export interface OutboxEvent {
  id: string;
  workspaceId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export async function publishOutbox(db: DbOrTx, jobs: JobsPort, opts: { limit?: number; now?: Date; onEvent?: (ev: OutboxEvent) => Promise<void> } = {}): Promise<number> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 200;
  return (db as { transaction: <T>(fn: (tx: DbOrTx) => Promise<T>) => Promise<T> }).transaction(async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id, workspace_id, event_type, aggregate_type, aggregate_id, dedupe_key, payload, occurred_at
      FROM outbox_events WHERE published_at IS NULL ORDER BY occurred_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
    `)) as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const events = (Array.isArray(rows) ? rows : (rows.rows ?? [])) as Array<{
      id: string;
      workspace_id: string;
      event_type: string;
      dedupe_key: string | null;
      payload: Record<string, unknown>;
      occurred_at: string | Date;
    }>;
    if (events.length === 0) return 0;
    const wsIds = [...new Set(events.map((e) => e.workspace_id))];
    const endpoints = await tx
      .select()
      .from(webhookEndpoints)
      .where(and(inArray(webhookEndpoints.workspaceId, wsIds), eq(webhookEndpoints.enabled, true), isNull(webhookEndpoints.deletedAt)));
    const toEnqueue: string[] = [];
    for (const ev of events) {
      const payload = typeof ev.payload === 'string' ? (JSON.parse(ev.payload) as Record<string, unknown>) : ev.payload;
      const matching = endpoints.filter((e) => e.workspaceId === ev.workspace_id && (e.events.includes('*') || e.events.includes(ev.event_type)));
      for (const ep of matching) {
        const inserted = await tx
          .insert(webhookDeliveries)
          .values({
            workspaceId: ev.workspace_id,
            endpointId: ep.id,
            eventId: ev.id,
            eventType: ev.event_type,
            dedupeKey: ev.dedupe_key ?? dedupeKeyFor(ev.event_type, payload, ev.id),
            payload: envelopeFor(ev.event_type, ev.id, new Date(ev.occurred_at), payload),
            nextAttemptAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: webhookDeliveries.id });
        if (inserted[0]) toEnqueue.push(inserted[0].id);
      }
    }
    if (opts.onEvent) {
      for (const ev of events) {
        const payload = typeof ev.payload === 'string' ? (JSON.parse(ev.payload) as Record<string, unknown>) : ev.payload;
        await opts.onEvent({ id: ev.id, workspaceId: ev.workspace_id, eventType: ev.event_type, payload }).catch(() => {});
      }
    }
    await tx.update(outboxEvents).set({ publishedAt: now }).where(inArray(outboxEvents.id, events.map((e) => e.id)));
    for (const id of toEnqueue) await jobs.send('webhook.deliver', { deliveryId: id }, { singletonKey: `deliver:${id}` });
    return events.length;
  });
}

export interface DeliverDeps {
  db: DbOrTx;
  jobs: JobsPort;
  kek?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  random?: () => number;
}

export type DeliverOutcome = { status: 'succeeded' | 'failed' | 'exhausted' | 'skipped'; responseStatus?: number; nextAttemptAt?: Date; error?: string };

/** One delivery attempt. Schedules the next attempt on failure; marks exhausted after MAX_ATTEMPTS. */
export async function deliverWebhook(d: DeliverDeps, deliveryId: string): Promise<DeliverOutcome> {
  const now = d.now?.() ?? new Date();
  const [row] = await d.db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
  if (!row || row.status === 'succeeded' || row.status === 'exhausted') return { status: 'skipped' };
  const [ep] = await d.db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, row.endpointId)).limit(1);
  if (!ep || !ep.enabled || ep.deletedAt) {
    await d.db.update(webhookDeliveries).set({ status: 'failed', error: 'endpoint disabled' }).where(eq(webhookDeliveries.id, deliveryId));
    return { status: 'failed', error: 'endpoint disabled' };
  }
  const attempt = row.attempt + 1;
  const rawBody = JSON.stringify(row.payload);
  const secret = readSecret(ep.secretEncrypted, d.kek);
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'Cooks-Webhooks/1',
    'x-webhook-signature': signWebhook(secret, rawBody, now.getTime()),
    'x-webhook-id': row.eventId,
    'x-webhook-event': row.eventType,
    'x-webhook-attempt': String(attempt),
  };
  const started = Date.now();
  let responseStatus: number | undefined;
  let error: string | undefined;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const res = await (d.fetchImpl ?? fetch)(ep.url, { method: 'POST', headers, body: rawBody, signal: ac.signal, redirect: 'manual' });
      responseStatus = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    error = (e as Error).name === 'AbortError' ? `timeout after ${DELIVERY_TIMEOUT_MS} ms` : (e as Error).message;
  }
  const responseMs = Date.now() - started;

  if (!error) {
    await d.db.update(webhookDeliveries).set({ status: 'succeeded', attempt, responseStatus, responseMs, deliveredAt: now, error: null, nextAttemptAt: null }).where(eq(webhookDeliveries.id, deliveryId));
    await d.db.update(webhookEndpoints).set({ lastSuccessAt: now, consecutiveFailures: 0 }).where(eq(webhookEndpoints.id, ep.id));
    return { status: 'succeeded', responseStatus };
  }
  if (attempt >= MAX_ATTEMPTS) {
    await d.db.update(webhookDeliveries).set({ status: 'exhausted', attempt, responseStatus, responseMs, error, nextAttemptAt: null }).where(eq(webhookDeliveries.id, deliveryId));
    const failures = ep.consecutiveFailures + 1;
    await d.db
      .update(webhookEndpoints)
      .set({ lastFailureAt: now, consecutiveFailures: failures, ...(failures >= AUTO_DISABLE_AFTER ? { enabled: false } : {}) })
      .where(eq(webhookEndpoints.id, ep.id));
    return { status: 'exhausted', responseStatus, error };
  }
  const base = RETRY_DELAYS_S[attempt - 1] ?? RETRY_DELAYS_S[RETRY_DELAYS_S.length - 1]!;
  const jitter = 1 + ((d.random?.() ?? Math.random()) * 0.4 - 0.2);
  const nextAttemptAt = new Date(now.getTime() + Math.round(base * jitter * 1000));
  await d.db.update(webhookDeliveries).set({ status: 'failed', attempt, responseStatus, responseMs, error, nextAttemptAt }).where(eq(webhookDeliveries.id, deliveryId));
  await d.db.update(webhookEndpoints).set({ lastFailureAt: now }).where(eq(webhookEndpoints.id, ep.id));
  await d.jobs.send('webhook.deliver', { deliveryId }, { startAfter: nextAttemptAt, singletonKey: `deliver:${deliveryId}:${attempt}` });
  return { status: 'failed', responseStatus, nextAttemptAt, error };
}
