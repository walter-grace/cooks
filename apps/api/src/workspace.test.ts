import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('workspace + api keys', () => {
  it('reads and merges settings', async () => {
    const r = await t.request('/v1/workspace');
    expect(r.json.data).toMatchObject({ name: 'Acme', slug: 'acme', settings: {} });
    const u = await t.request('/v1/workspace', { method: 'PATCH', json: { data: { settings: { timezone: 'America/New_York', jitterSeconds: 0 } } } });
    expect(u.json.data.settings).toEqual({ timezone: 'America/New_York', jitterSeconds: 0 });
    const u2 = await t.request('/v1/workspace', { method: 'PATCH', json: { data: { settings: { tracking: { opens: true, clicks: false } } } } });
    expect(u2.json.data.settings).toEqual({ timezone: 'America/New_York', jitterSeconds: 0, tracking: { opens: true, clicks: false } });
    const bad = await t.request('/v1/workspace', { method: 'PATCH', json: { data: { settings: { sendWindow: { days: [8], start: '9', end: '17:00' } } } } });
    expect(bad.status).toBe(400);
  });
  it('creates, lists and revokes keys; revoked keys stop working', async () => {
    const c = await t.request('/v1/apiKeys', { method: 'POST', json: { data: { name: 'ci' } } });
    expect(c.status).toBe(201);
    expect(c.json.data.token).toMatch(/^cooks-api-/);
    const me = await t.request('/v1/me', { token: c.json.data.token });
    expect(me.status).toBe(200);
    const l = await t.request('/v1/apiKeys');
    expect(l.json.data.map((k: any) => k.name).sort()).toEqual(['ci', 'test']);
    expect(JSON.stringify(l.json)).not.toContain(c.json.data.token);
    const d = await t.request(`/v1/apiKeys/${c.json.data.id}`, { method: 'DELETE' });
    expect(d.status).toBe(204);
    const gone = await t.request('/v1/me', { token: c.json.data.token });
    expect(gone.status).toBe(401);
  });
});
