import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const redirect = 'http://localhost:9999/cb';
const state = { clientId: '', cookie: '', code: '', access: '', refresh: '' };

describe('OAuth 2.1 (PKCE, rotating refresh, scopes, roles)', () => {
  it('serves discovery metadata and JWKS', async () => {
    const m = await t.request('/.well-known/oauth-authorization-server', { token: null });
    expect(m.json).toMatchObject({ issuer: 'http://localhost', code_challenge_methods_supported: ['S256'], registration_endpoint: 'http://localhost/oauth/register' });
    expect(m.json.scopes_supported).toContain('sequences:write');
    const j = await t.request('/.well-known/jwks.json', { token: null });
    expect(j.json.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
    expect(j.json.keys[0].d).toBeUndefined();
  });
  it('registers a public client dynamically', async () => {
    const r = await t.request('/oauth/register', { token: null, method: 'POST', json: { client_name: 'Claude', redirect_uris: [redirect] } });
    expect(r.status).toBe(201);
    expect(r.json.token_endpoint_auth_method).toBe('none');
    state.clientId = r.json.client_id;
    const bad = await t.request('/oauth/register', { token: null, method: 'POST', json: { client_name: 'x', redirect_uris: ['http://evil.test/cb'] } });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('invalid_redirect_uri');
  });
  it('authorize → login → consent → code', async () => {
    const q = new URLSearchParams({ client_id: state.clientId, redirect_uri: redirect, response_type: 'code', scope: 'prospects:read sequences:read sequence-steps:write', state: 'xyz', code_challenge: challenge, code_challenge_method: 'S256' });
    const anon = await t.request(`/oauth/authorize?${q}`, { token: null, redirect: 'manual' });
    expect(anon.status).toBe(302);
    expect(anon.headers.get('location')).toMatch(/^\/auth\/login\?next=/);

    const login = await t.request('/auth/login', { token: null, method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'rep@acme.test', password: 'hunter22', next: '/docs' }).toString() });
    expect(login.status).toBe(303);
    state.cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const wrong = await t.request('/auth/login', { token: null, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'rep@acme.test', password: 'nope' }).toString() });
    expect(wrong.status).toBe(401);

    const consent = await t.request(`/oauth/authorize?${q}`, { token: null, headers: { cookie: state.cookie } });
    expect(consent.status).toBe(200);
    expect(consent.text).toContain('Allow Claude?');
    expect(consent.text).toContain('sequence-steps:write');
    const qField = /name="q" value="([^"]+)"/.exec(consent.text)![1]!.replace(/&amp;/g, '&');
    const decision = await t.request('/oauth/authorize/decision', { token: null, method: 'POST', redirect: 'manual', headers: { cookie: state.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ q: qField, decision: 'approve' }).toString() });
    expect(decision.status).toBe(302);
    const loc = new URL(decision.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(redirect);
    expect(loc.searchParams.get('state')).toBe('xyz');
    state.code = loc.searchParams.get('code')!;
    expect(state.code).toBeTruthy();
    // consent is remembered: the next authorize redirects straight back with a code
    const again = await t.request(`/oauth/authorize?${q}`, { token: null, redirect: 'manual', headers: { cookie: state.cookie } });
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    const noPkce = await t.request(`/oauth/authorize?${new URLSearchParams({ client_id: state.clientId, redirect_uri: redirect, response_type: 'code', scope: 'prospects:read' })}`, { token: null, headers: { cookie: state.cookie } });
    expect(noPkce.status).toBe(400);
  });
  it('exchanges the code with PKCE, rejects replays and bad verifiers', async () => {
    const badVerifier = await t.request('/oauth/token', { token: null, method: 'POST', json: { grant_type: 'authorization_code', code: state.code, client_id: state.clientId, redirect_uri: redirect, code_verifier: 'wrong' } });
    expect(badVerifier.status).toBe(400);
    expect(badVerifier.json.error).toBe('invalid_grant');
    const ok = await t.request('/oauth/token', { token: null, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: state.code, client_id: state.clientId, redirect_uri: redirect, code_verifier: verifier }).toString() });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'prospects:read sequences:read sequence-steps:write' });
    state.access = ok.json.access_token;
    state.refresh = ok.json.refresh_token;
    const replay = await t.request('/oauth/token', { token: null, method: 'POST', json: { grant_type: 'authorization_code', code: state.code, client_id: state.clientId, redirect_uri: redirect, code_verifier: verifier } });
    expect(replay.json.error).toBe('invalid_grant');
  });
  it('the JWT identifies the user with role + scopes; scope and role rules bite', async () => {
    const me = await t.request('/v1/me', { token: state.access });
    expect(me.status).toBe(200);
    expect(me.json.data).toMatchObject({ userId: t.repId, authType: 'oauth', clientId: state.clientId, email: 'rep@acme.test', scopes: ['prospects:read', 'sequences:read', 'sequence-steps:write'] });
    const denied = await t.request('/v1/prospects', { token: state.access, method: 'POST', json: { data: { firstName: 'X', primaryEmail: 'x@x.test' } } });
    expect(denied.status).toBe(403);
    expect(denied.json.error).toMatchObject({ code: 'INSUFFICIENT_SCOPE', requiredScope: 'prospects:write' });
    // role rule: the rep (role user) cannot delete a step on the owner's sequence, but the API key can
    const seq = await t.request('/v1/sequences', { method: 'POST', json: { data: { name: 'Owner seq', owner: { id: t.ownerId } } } });
    const step = await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: seq.json.data.id }, action: 'call', interval: 0 } } });
    const del = await t.request(`/v1/sequenceSteps/${step.json.data.id}`, { token: state.access, method: 'DELETE' });
    expect(del.status).toBe(403);
    expect(del.json.error.code).toBe('INSUFFICIENT_PERMISSION');
    const own = await t.request('/v1/sequences', { method: 'POST', json: { data: { name: 'Rep seq', owner: { id: t.repId } } } });
    const ownStep = await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: own.json.data.id }, action: 'call', interval: 0 } } });
    const delOwn = await t.request(`/v1/sequenceSteps/${ownStep.json.data.id}`, { token: state.access, method: 'DELETE' });
    expect(delOwn.status).toBe(204);
    const tampered = await t.request('/v1/me', { token: state.access.slice(0, -2) + 'xx' });
    expect(tampered.status).toBe(401);
  });
  it('refresh rotates; reuse revokes the family; revoke works', async () => {
    const r1 = await t.request('/oauth/token', { token: null, method: 'POST', json: { grant_type: 'refresh_token', refresh_token: state.refresh, client_id: state.clientId } });
    expect(r1.status).toBe(200);
    expect(r1.json.refresh_token).not.toBe(state.refresh);
    const widen = await t.request('/oauth/token', { token: null, method: 'POST', json: { grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, client_id: state.clientId, scope: 'prospects:write' } });
    expect(widen.json.error).toBe('invalid_scope');
    const reuse = await t.request('/oauth/token', { token: null, method: 'POST', json: { grant_type: 'refresh_token', refresh_token: state.refresh, client_id: state.clientId } });
    expect(reuse.json.error).toBe('invalid_grant');
    const afterReuse = await t.request('/oauth/token', { token: null, method: 'POST', json: { grant_type: 'refresh_token', refresh_token: r1.json.refresh_token, client_id: state.clientId } });
    expect(afterReuse.json.error).toBe('invalid_grant'); // family revoked
    const rev = await t.request('/oauth/revoke', { token: null, method: 'POST', json: { token: 'does-not-exist' } });
    expect(rev.status).toBe(200);
  });
});
