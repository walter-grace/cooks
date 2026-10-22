import { and, desc, eq, type SQL } from 'drizzle-orm';
import { webhookDeliveries, webhookEndpoints } from '@cooks/db';
import type { Ctx } from '../context.js';
import { encrypt, randomBase62 } from '../crypto.js';
import { notFound, unprocessable } from '../errors.js';
import type { PageArgs } from '../pagination.js';
import { readSecret } from '../webhooks/delivery.js';
import { signWebhook } from '../webhooks/sign.js';
import { iso, isoReq, paginate, tenantWhere, uuidOr404 } from './_shared.js';
import { uuidv7 } from '@cooks/db';

export type EndpointRow = typeof webhookEndpoints.$inferSelect;

export const WEBHOOK_EVENTS = [
  'call.logged',
  'email.sent',
  'email.delivered',
  'email.opened',
  'email.clicked',
  'email.replied',
  'email.bounced',
  'prospect.created',
  'prospect.updated',
  'prospect.unsubscribed',
  'sequence_state.created',
  'sequence_state.paused',
  'sequence_state.resumed',
  'sequence_state.finished',
  'task.created',
  'task.due',
  'task.completed',
  'task.skipped',
  'note.created',
  'signal.created',
  'call.started',
  'call.completed',
] as const;

export function serializeEndpoint(e: EndpointRow) {
  return {
    id: e.id,
    url: e.url,
    events: e.events,
    enabled: e.enabled,
    description: e.description,
    lastSuccessAt: iso(e.lastSuccessAt),
    lastFailureAt: iso(e.lastFailureAt),
    consecutiveFailures: e.consecutiveFailures,
    createdAt: isoReq(e.createdAt),
    updatedAt: isoReq(e.updatedAt),
  };
}

export interface WebhookDeps {
  kek?: string;
  fetchImpl?: typeof fetch;
}

async function ping(ctx: Ctx, url: string, secret: string, endpointId: string, fetchImpl: typeof fetch): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify({ event: 'webhook.verification', eventId: uuidv7(), occurredAt: ctx.clock.now().toISOString(), data: { endpointId } });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Cooks-Webhooks/1', 'x-webhook-signature': signWebhook(secret, body, ctx.clock.now().getTime()), 'x-webhook-event': 'webhook.verification' },
      body,
      signal: ac.signal,
      redirect: 'manual',
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export async function listWebhooks(ctx: Ctx, q: { page: PageArgs; requestUrl: string }) {
  const conds: SQL[] = [tenantWhere(webhookEndpoints, ctx.principal.workspaceId)];
  const page = await paginate({
    table: webhookEndpoints,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(webhookEndpoints)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: page.data.map(serializeEndpoint), links: page.links };
}

export async function getEndpointRow(ctx: Ctx, id: string): Promise<EndpointRow> {
  uuidOr404(id, 'Webhook');
  const [row] = await ctx.db
    .select()
    .from(webhookEndpoints)
    .where(and(tenantWhere(webhookEndpoints, ctx.principal.workspaceId), eq(webhookEndpoints.id, id)))
    .limit(1);
  if (!row) throw notFound('Webhook');
  return row;
}

/**
 * Create an endpoint. The signing secret is returned once. A verification ping must answer
 * 2xx within 15 s; otherwise the endpoint is stored disabled and the call fails with 422.
 */
export async function createWebhook(ctx: Ctx, input: { url: string; events?: string[]; description?: string }, deps: WebhookDeps) {
  const u = new URL(input.url);
  if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) throw unprocessable('Webhook URLs must use https', { field: 'url' });
  const secret = `cooks-webhook-signing-key-${randomBase62(48)}`;
  const stored = deps.kek ? encrypt(secret, deps.kek) : `plain:${secret}`;
  const [row] = await ctx.db
    .insert(webhookEndpoints)
    .values({ workspaceId: ctx.principal.workspaceId, url: input.url, secretEncrypted: stored, events: input.events?.length ? input.events : ['*'], description: input.description ?? null, createdBy: ctx.principal.userId, enabled: false })
    .returning();
  const result = await ping(ctx, input.url, secret, row!.id, deps.fetchImpl ?? fetch);
  if (!result.ok) {
    throw unprocessable('Verification ping failed: the endpoint must answer 2xx within 15 seconds', { endpointId: row!.id, status: result.status, error: result.error });
  }
  const [enabled] = await ctx.db.update(webhookEndpoints).set({ enabled: true, lastSuccessAt: ctx.clock.now() }).where(eq(webhookEndpoints.id, row!.id)).returning();
  return { ...serializeEndpoint(enabled!), secret };
}

export async function updateWebhook(ctx: Ctx, id: string, input: { url?: string; events?: string[]; enabled?: boolean; description?: string | null }, deps: WebhookDeps) {
  const row = await getEndpointRow(ctx, id);
  if (input.url && input.url !== row.url) {
    const result = await ping(ctx, input.url, readSecret(row.secretEncrypted, deps.kek), row.id, deps.fetchImpl ?? fetch);
    if (!result.ok) throw unprocessable('Verification ping failed for the new URL', { status: result.status, error: result.error });
  }
  const [updated] = await ctx.db
    .update(webhookEndpoints)
    .set({
      ...(input.url !== undefined ? { url: input.url } : {}),
      ...(input.events !== undefined ? { events: input.events.length ? input.events : ['*'] } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled, consecutiveFailures: input.enabled ? 0 : row.consecutiveFailures } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    })
    .where(eq(webhookEndpoints.id, id))
    .returning();
  return serializeEndpoint(updated!);
}

export async function deleteWebhook(ctx: Ctx, id: string) {
  await getEndpointRow(ctx, id);
  await ctx.db.update(webhookEndpoints).set({ deletedAt: ctx.clock.now(), enabled: false }).where(eq(webhookEndpoints.id, id));
}

export async function testWebhook(ctx: Ctx, id: string, deps: WebhookDeps) {
  const row = await getEndpointRow(ctx, id);
  const result = await ping(ctx, row.url, readSecret(row.secretEncrypted, deps.kek), row.id, deps.fetchImpl ?? fetch);
  return { ok: result.ok, status: result.status ?? null, error: result.error ?? null };
}

export async function listDeliveries(ctx: Ctx, id: string, q: { page: PageArgs; requestUrl: string }) {
  await getEndpointRow(ctx, id);
  const page = await paginate({
    table: webhookDeliveries,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(webhookDeliveries)
        .where(and(eq(webhookDeliveries.endpointId, id), where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return {
    data: page.data.map((d) => ({
      id: d.id,
      eventId: d.eventId,
      eventType: d.eventType,
      status: d.status,
      attempt: d.attempt,
      responseStatus: d.responseStatus,
      responseMs: d.responseMs,
      error: d.error,
      nextAttemptAt: iso(d.nextAttemptAt),
      deliveredAt: iso(d.deliveredAt),
      createdAt: isoReq(d.createdAt),
    })),
    links: page.links,
  };
}

export { desc };
