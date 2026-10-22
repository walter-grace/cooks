import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverWebhook, publishOutbox, verifyWebhookSignature } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
const hits: Array<{ url: string; event: string; body: string; sig: string }> = [];
let status = 200;
const fetchImpl: typeof fetch = async (url, init) => {
  const h = init?.headers as Record<string, string>;
  hits.push({ url: String(url), event: h['x-webhook-event']!, body: String(init?.body), sig: h['x-webhook-signature']! });
  return new Response(null, { status });
};
beforeAll(async () => {
  t = await createTestApp({ fetchImpl });
});
afterAll(() => t.close());

describe('webhooks API', () => {
  it('creates with a verification ping, returns the secret once, and delivers signed events', async () => {
    status = 500;
    const bad = await t.request('/v1/webhooks', { method: 'POST', json: { data: { url: 'https://hooks.test/in' } } });
    expect(bad.status).toBe(422);
    status = 200;
    const r = await t.request('/v1/webhooks', { method: 'POST', json: { data: { url: 'https://hooks.test/in', events: ['prospect.created', 'sequence_state.finished'], description: 'crm bridge' } } });
    expect(r.status).toBe(201);
    const secret: string = r.json.data.secret;
    expect(secret).toMatch(/^cooks-webhook-signing-key-/);
    expect(r.json.data.enabled).toBe(true);
    expect(hits.at(-1)!.event).toBe('webhook.verification');
    expect(verifyWebhookSignature(hits.at(-1)!.sig, hits.at(-1)!.body, secret, { now: t.clock.now().getTime() })).toBe(true);
    const list = await t.request('/v1/webhooks');
    expect(list.json.data[0]).not.toHaveProperty('secret');
    const plain = await t.request('/v1/webhooks', { method: 'POST', json: { data: { url: 'http://insecure.test/x' } } });
    expect(plain.status).toBe(422);

    // a domain event flows outbox → delivery → endpoint
    hits.length = 0;
    await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Hook', primaryEmail: 'hook@x.test' } } });
    t.jobs.clear();
    expect(await publishOutbox(t.db, t.jobs, { now: t.clock.now() })).toBeGreaterThan(0);
    const deliver = t.jobs.sent.filter((j) => j.name === 'webhook.deliver');
    expect(deliver).toHaveLength(1); // only the subscribed event type
    const out = await deliverWebhook({ db: t.db, jobs: t.jobs, fetchImpl, now: () => t.clock.now() }, deliver[0]!.data.deliveryId as string);
    expect(out.status).toBe('succeeded');
    expect(JSON.parse(hits[0]!.body)).toMatchObject({ event: 'prospect.created', data: { prospectId: expect.any(String) } });
    expect(verifyWebhookSignature(hits[0]!.sig, hits[0]!.body, secret, { now: t.clock.now().getTime() })).toBe(true);

    const dl = await t.request(`/v1/webhooks/${r.json.data.id}/deliveries`);
    expect(dl.json.data[0]).toMatchObject({ eventType: 'prospect.created', status: 'succeeded', attempt: 1, responseStatus: 200 });
    const test = await t.request(`/v1/webhooks/${r.json.data.id}/actions/test`, { method: 'POST' });
    expect(test.json.ok).toBe(true);
    const off = await t.request(`/v1/webhooks/${r.json.data.id}`, { method: 'PATCH', json: { data: { enabled: false } } });
    expect(off.json.data.enabled).toBe(false);
    const del = await t.request(`/v1/webhooks/${r.json.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
  });
});
