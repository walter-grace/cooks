import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mailboxCredentials, mailboxes } from '@cooks/db';
import { decrypt } from '@cooks/core';
import { createApp } from './app.js';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
const calls: string[] = [];
const fetchImpl: typeof fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  if (url.includes('oauth2.googleapis.com/token')) return Response.json({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 });
  if (url.includes('gmail/v1/users/me/profile')) return Response.json({ emailAddress: 'Olive@Acme.test', historyId: '1' });
  return new Response('nope', { status: 404 });
};
beforeAll(async () => {
  t = await createTestApp({ fetchImpl });
});
afterAll(() => t.close());

async function login(email: string) {
  const r = await t.request('/auth/login', { token: null, method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password: 'hunter22' }).toString() });
  return r.headers.get('set-cookie')!.split(';')[0]!;
}

describe('browser session token', () => {
  it('exchanges the session cookie for a first-party access token that works on /v1', async () => {
    const anon = await t.request('/auth/session-token', { token: null, method: 'POST', json: {} });
    expect(anon.status).toBe(401);
    const cookie = await login('rep@acme.test');
    const r = await t.request('/auth/session-token', { token: null, method: 'POST', json: {}, headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600, workspace: { id: t.workspaceId, role: 'user' }, user: { email: 'rep@acme.test' } });
    const me = await t.request('/v1/me', { token: r.json.access_token });
    expect(me.json.data).toMatchObject({ userId: t.repId, authType: 'oauth', clientId: 'cooks-web' });
    const who = await t.request('/auth/me', { token: null, headers: { cookie } });
    expect(who.json.authenticated).toBe(true);
  });
});

describe('mailbox connectors', () => {
  it('returns 503 when the Google app is not configured', async () => {
    const r = await t.request('/connect/google/start', { token: null });
    expect(r.status).toBe(503);
  });
  it('runs the Google flow with a configured app: redirect → callback stores encrypted tokens on a mailbox', async () => {
    const { app } = createApp({ db: t.db, jobs: t.jobs, clock: t.clock, publicUrl: 'http://localhost', kek: t.kek, fetchImpl, connectorApps: { google: { clientId: 'gid', clientSecret: 'gsec' } } });
    const cookie = await login('owner@acme.test');
    const start = await app.request('/connect/google/start', { headers: { cookie }, redirect: 'manual' });
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost/connect/google/callback');
    const state = loc.searchParams.get('state')!;
    const bad = await app.request(`/connect/google/callback?code=abc&state=${state}x`, { headers: { cookie } });
    expect(bad.status).toBe(400);
    const cb = await app.request(`/connect/google/callback?code=abc&state=${state}`, { headers: { cookie }, redirect: 'manual' });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe('/app/settings?connected=olive%40acme.test');
    const [mb] = await t.db.select().from(mailboxes).where(eq(mailboxes.email, 'olive@acme.test'));
    expect(mb).toMatchObject({ provider: 'gmail', userId: t.ownerId, isDefault: true, status: 'connected' });
    const [cred] = await t.db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mb!.id));
    expect(JSON.parse(decrypt(cred!.encrypted, t.kek))).toMatchObject({ google: { refreshToken: 'rt', email: 'olive@acme.test' } });
    expect(calls.some((u) => u.includes('oauth2.googleapis.com/token'))).toBe(true);
  });
});
