import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApiKey, ensureSigningKey, type ClerkGateway } from '@cooks/auth';
import { decrypt } from '@cooks/core';
import { mailboxCredentials, mailboxes, users, workspaceMembers, workspaces } from '@cooks/db';
import { createTestDb } from '@cooks/db/test';
import { createApp } from './app.js';
import { MemoryRateLimitStore } from './middleware/rate-limit.js';

const gateway: ClerkGateway = {
  async verify(token) {
    if (token === 'sess-ada') return { userId: 'user_ada', orgId: 'org_globex', orgSlug: 'globex', orgRole: 'org:admin' };
    if (token === 'sess-bob') return { userId: 'user_bob', orgId: 'org_globex', orgSlug: 'globex', orgRole: 'org:member' };
    if (token === 'sess-solo') return { userId: 'user_solo', orgId: null, orgSlug: null, orgRole: null };
    return null;
  },
  async getProfile(id) {
    return { user_ada: { email: 'Ada@globex.test', name: 'Ada Lovelace' }, user_bob: { email: 'bob@globex.test', name: 'Bob' }, user_solo: { email: 'solo@me.test', name: 'Solo' } }[id] ?? null;
  },
  async getProviderToken(id, provider) {
    if (id === 'user_ada' && provider === 'google') return { token: 'ya29.clerk-google', expiresAt: Date.now() + 3600_000 };
    if (id === 'user_ada' && provider === 'hubspot') return { token: 'pat-clerk-good-token', expiresAt: Date.now() + 1800_000 };
    return null;
  },
};
const hsFetch: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  const auth = (init?.headers as Record<string, string>)?.authorization ?? '';
  if (!auth.endsWith('good-token')) return Response.json({ message: 'bad' }, { status: 401 });
  if (url.pathname === '/account-info/v3/details') return Response.json({ portalId: 99 });
  if (url.pathname === '/crm/v3/owners') return Response.json({ results: [] });
  return Response.json({}, { status: 404 });
};

let db: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>['app'];
const kek = Buffer.alloc(32, 3).toString('base64');
beforeAll(async () => {
  db = await createTestDb();
  const key = await ensureSigningKey(db.db, undefined);
  app = createApp({ db: db.db, rateLimitStore: new MemoryRateLimitStore(), publicUrl: 'http://localhost', kek, fetchImpl: hsFetch, oauth: { key, secureCookies: false }, clerk: { gateway, publishableKey: 'pk_test_x' } }).app;
});
afterAll(() => db.close());

const post = (path: string, json: unknown, headers: Record<string, string> = {}) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(json) });

describe('Clerk SSO mode', () => {
  let cookie = '';
  let bearer = '';
  it('exposes the publishable key and rejects bad sessions', async () => {
    const cfg: any = await (await app.request('/auth/config')).json();
    expect(cfg).toEqual({ mode: 'clerk', clerkPublishableKey: 'pk_test_x' });
    expect((await post('/auth/clerk/session', { token: 'nope' })).status).toBe(401);
  });
  it('maps a Clerk org admin to a new workspace as admin and sets the Cooks cookie', async () => {
    const r = await post('/auth/clerk/session', { token: 'sess-ada' });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body).toMatchObject({ ok: true, role: 'admin', user: { email: 'ada@globex.test', name: 'Ada Lovelace' } });
    cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const [ws] = await db.db.select().from(workspaces).where(eq(workspaces.clerkOrgId, 'org_globex'));
    expect(ws).toMatchObject({ slug: 'globex', name: 'globex' });
    const tok: any = await (await post('/auth/session-token', {}, { cookie })).json();
    expect(tok.workspace).toMatchObject({ id: ws!.id, role: 'admin' });
    bearer = tok.access_token;
    // second sign-in reuses the user and workspace
    await post('/auth/clerk/session', { token: 'sess-ada' });
    expect(await db.db.select().from(users).where(eq(users.clerkUserId, 'user_ada'))).toHaveLength(1);
  });
  it('org members join the same workspace as users; users without an org get a personal workspace', async () => {
    const bob: any = await (await post('/auth/clerk/session', { token: 'sess-bob' })).json();
    expect(bob.role).toBe('user');
    const members = await db.db.select().from(workspaceMembers);
    expect(members.filter((m) => m.workspaceId === bob.workspaceId)).toHaveLength(2);
    const solo: any = await (await post('/auth/clerk/session', { token: 'sess-solo' })).json();
    expect(solo.role).toBe('admin');
    const [ws] = await db.db.select().from(workspaces).where(eq(workspaces.id, solo.workspaceId));
    expect(ws!.slug).toMatch(/^u-solo/);
  });
  it('connects Gmail from the Google account linked in Clerk, storing a Clerk-managed credential', async () => {
    const r = await post('/v1/mailboxes/from-clerk', { data: { provider: 'google' } }, { authorization: `Bearer ${bearer}` });
    expect(r.status).toBe(201);
    const body: any = await r.json();
    expect(body.data).toMatchObject({ email: 'ada@globex.test', isDefault: true });
    const [mb] = await db.db.select().from(mailboxes).where(eq(mailboxes.id, body.data.id));
    expect(mb!.provider).toBe('gmail');
    const [cred] = await db.db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mb!.id));
    expect(JSON.parse(decrypt(cred!.encrypted, kek))).toMatchObject({ google: { accessToken: 'ya29.clerk-google', viaClerk: true, refreshToken: '' } });
    const none = await post('/v1/mailboxes/from-clerk', { data: { provider: 'microsoft' } }, { authorization: `Bearer ${bearer}` });
    expect(none.status).toBe(422);
  });
  it('connects HubSpot from the HubSpot account linked in Clerk', async () => {
    const r = await app.request('/v1/workspace/crm/hubspot/from-clerk', { method: 'PUT', headers: { authorization: `Bearer ${bearer}` } });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.data).toMatchObject({ type: 'hubspot', status: 'connected', hubspot: { portalId: 99, kind: 'clerk' } });
  });
  it('API keys still work alongside Clerk', async () => {
    const [ws] = await db.db.select().from(workspaces).where(eq(workspaces.clerkOrgId, 'org_globex'));
    const key = await createApiKey(db.db, { workspaceId: ws!.id, name: 'k' });
    const me: any = await (await app.request('/v1/me', { headers: { authorization: `Bearer ${key.token}` } })).json();
    expect(me.data.workspaceId).toBe(ws!.id);
  });
});
