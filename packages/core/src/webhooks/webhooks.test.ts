import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@cooks/db/test';
import { webhookDeliveries, webhookEndpoints, workspaces, type Db } from '@cooks/db';
import { signWebhook, verifyWebhookSignature } from './sign.js';
import { deliverWebhook, publishOutbox, RETRY_DELAYS_S } from './delivery.js';
import { emitEvent } from '../events.js';
import { MemoryJobs } from '../jobs.js';

describe('signature', () => {
  it('round-trips and rejects stale or tampered headers', () => {
    const h = signWebhook('k', '{"a":1}', 1_700_000_000_000);
    expect(h).toMatch(/^t=1700000000000,s=.+/);
    expect(verifyWebhookSignature(h, '{"a":1}', 'k', { now: 1_700_000_000_000 + 1000 })).toBe(true);
    expect(verifyWebhookSignature(h, '{"a":2}', 'k', { now: 1_700_000_000_000 })).toBe(false);
    expect(verifyWebhookSignature(h, '{"a":1}', 'k', { now: 1_700_000_000_000 + 6 * 60_000 })).toBe(false);
    expect(verifyWebhookSignature('garbage', '{}', 'k')).toBe(false);
  });
});

describe('outbox → deliveries → retries', () => {
  let db: Db;
  let close: () => Promise<void>;
  let ws: string;
  const jobs = new MemoryJobs();
  const received: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let respondWith = 200;
  const fetchImpl: typeof fetch = async (url, init) => {
    received.push({ url: String(url), headers: Object.fromEntries(Object.entries(init?.headers ?? {})), body: String(init?.body) });
    return new Response(null, { status: respondWith });
  };

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    ws = (await db.insert(workspaces).values({ name: 'A', slug: 'a' }).returning())[0]!.id;
  });
  afterAll(() => close());

  it('publishes events to matching endpoints and delivers with a valid signature', async () => {
    await db.insert(webhookEndpoints).values([
      { workspaceId: ws, url: 'https://hooks.test/all', secretEncrypted: 'plain:sek', events: ['*'] },
      { workspaceId: ws, url: 'https://hooks.test/calls', secretEncrypted: 'plain:sek2', events: ['call.logged'] },
      { workspaceId: ws, url: 'https://hooks.test/off', secretEncrypted: 'plain:sek3', events: ['*'], enabled: false },
    ]);
    await emitEvent(db, { workspaceId: ws, type: 'prospect.created', aggregateType: 'prospect', aggregateId: 'p1', payload: { prospectId: 'p1' } });
    await emitEvent(db, { workspaceId: ws, type: 'call.logged', aggregateType: 'call', aggregateId: 'c1', payload: { callData: { callId: 'c1', workspaceId: ws } } });
    const n = await publishOutbox(db, jobs, { now: new Date('2026-03-03T15:00:00Z') });
    expect(n).toBe(2);
    expect(await publishOutbox(db, jobs)).toBe(0); // nothing left
    const deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries).toHaveLength(3); // prospect→all, call→all, call→calls
    expect(jobs.sent.filter((j) => j.name === 'webhook.deliver')).toHaveLength(3);

    const callToAll = deliveries.find((d) => d.eventType === 'call.logged' && d.payload.callData)!;
    expect(callToAll.dedupeKey).toBe('c1');
    const out = await deliverWebhook({ db, jobs, fetchImpl, now: () => new Date('2026-03-03T15:00:01Z') }, callToAll.id);
    expect(out.status).toBe('succeeded');
    const last = received.at(-1)!;
    expect(JSON.parse(last.body)).toMatchObject({ event: 'call.logged', callData: { callId: 'c1' } });
    expect(last.headers['x-webhook-event']).toBe('call.logged');
    const ep = (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, callToAll.endpointId)))[0]!;
    const secret = ep.secretEncrypted.slice(6);
    expect(verifyWebhookSignature(last.headers['x-webhook-signature'], last.body, secret, { now: new Date('2026-03-03T15:00:01Z').getTime() })).toBe(true);
    expect(verifyWebhookSignature(last.headers['x-webhook-signature'], last.body, 'wrong', { now: new Date('2026-03-03T15:00:01Z').getTime() })).toBe(false);
    expect((await deliverWebhook({ db, jobs, fetchImpl }, callToAll.id)).status).toBe('skipped');
  });

  it('retries with backoff and exhausts after 8 attempts', async () => {
    const generic = (await db.select().from(webhookDeliveries)).find((d) => d.eventType === 'prospect.created')!;
    expect(generic.payload).toMatchObject({ event: 'prospect.created', data: { prospectId: 'p1' } });
    respondWith = 500;
    jobs.clear();
    let now = new Date('2026-03-03T16:00:00Z');
    for (let i = 1; i <= 7; i++) {
      const out = await deliverWebhook({ db, jobs, fetchImpl, now: () => now, random: () => 0.5 }, generic.id);
      expect(out.status).toBe('failed');
      expect(out.nextAttemptAt!.getTime() - now.getTime()).toBe(RETRY_DELAYS_S[i - 1]! * 1000);
      now = out.nextAttemptAt!;
    }
    expect(jobs.sent.filter((j) => j.name === 'webhook.deliver')).toHaveLength(7);
    const last = await deliverWebhook({ db, jobs, fetchImpl, now: () => now }, generic.id);
    expect(last.status).toBe('exhausted');
    const row = (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, generic.id)))[0]!;
    expect(row.attempt).toBe(8);
    const ep = (await db.select().from(webhookEndpoints).where(eq(webhookEndpoints.id, generic.endpointId)))[0]!;
    expect(ep.consecutiveFailures).toBe(1);
    respondWith = 200;
  });
});
