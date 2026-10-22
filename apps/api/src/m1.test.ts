import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

describe('auth + envelope', () => {
  it('rejects missing and bad tokens with the error envelope', async () => {
    const r = await t.request('/v1/me', { token: null });
    expect(r.status).toBe(401);
    expect(r.json.error.code).toBe('UNAUTHORIZED');
    expect(r.json.traceId).toBeTruthy();
    expect(r.headers.get('x-trace-id')).toBe(r.json.traceId);
    const bad = await t.request('/v1/me', { token: 'cooks-api-AAAAAAAAAAAA-' + 'B'.repeat(40) });
    expect(bad.status).toBe(401);
  });
  it('accepts a nooks-api- prefixed key with the same key id and secret', async () => {
    const r = await t.request('/v1/me', { token: t.token.replace(/^cooks-/, 'nooks-') });
    expect(r.status).toBe(200);
  });
  it('GET /me describes an API key principal', async () => {
    const r = await t.request('/v1/me');
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ workspaceId: t.workspaceId, userId: null, authType: 'apiKey', clientId: null });
    expect(r.json.data.scopes).toContain('sequences:write');
  });
  it('public-ip-list needs no auth; unknown routes are NOT_FOUND', async () => {
    const r = await t.request('/v1/public-ip-list', { token: null });
    expect(r.json).toEqual({ addresses: ['203.0.113.7'] });
    const nf = await t.request('/v1/nope');
    expect(nf.status).toBe(404);
    expect(nf.json.error.code).toBe('NOT_FOUND');
  });
  it('rate limit headers are present', async () => {
    const r = await t.request('/v1/tags');
    expect(r.headers.get('x-ratelimit-limit')).toBe('300');
    expect(Number(r.headers.get('x-ratelimit-remaining'))).toBeLessThan(300);
  });
});

describe('tags', () => {
  it('POST is idempotent by case-insensitive name (201 then 200)', async () => {
    const a = await t.request('/v1/tags', { method: 'POST', json: { data: { name: 'Hot' } } });
    expect(a.status).toBe(201);
    const b = await t.request('/v1/tags', { method: 'POST', json: { data: { name: 'hot' } } });
    expect(b.status).toBe(200);
    expect(b.json.data.id).toBe(a.json.data.id);
    const g = await t.request(`/v1/tags/${a.json.data.id}`);
    expect(g.json.data.name).toBe('Hot');
    const l = await t.request('/v1/tags?filter[name]=HOT');
    expect(l.json.data).toHaveLength(1);
    expect(l.json.links).toEqual({ first: '/v1/tags?filter%5Bname%5D=HOT', prev: null, next: null });
  });
  it('validation errors are BAD_REQUEST with details', async () => {
    const r = await t.request('/v1/tags', { method: 'POST', json: { data: { name: '' } } });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('BAD_REQUEST');
    expect(r.json.error.details[0].path).toBe('data.name');
  });
});

describe('users', () => {
  it('lists only workspace members and filters by email', async () => {
    const r = await t.request('/v1/users');
    expect(r.json.data.map((u: any) => u.email).sort()).toEqual(['owner@acme.test', 'rep@acme.test']);
    const f = await t.request('/v1/users?filter[email]=REP@acme.test');
    expect(f.json.data).toHaveLength(1);
    const g = await t.request(`/v1/users/${t.repId}`);
    expect(g.json.data.name).toBe('Ray Rep');
  });
});

describe('accounts + prospects', () => {
  let accountId: string;
  it('creates and reads an account, hiding custom fields unless asked', async () => {
    const r = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex', domain: 'globex.test', crmCustomFields: { tier: 'A' } } } });
    expect(r.status).toBe(201);
    accountId = r.json.data.id;
    const plain = await t.request(`/v1/accounts/${accountId}`);
    expect(plain.json.data.crmCustomFields).toEqual({});
    const withCf = await t.request(`/v1/accounts/${accountId}?includeCRMCustomFields=true`);
    expect(withCf.json.data.crmCustomFields).toEqual({ tier: 'A' });
    const byDomain = await t.request('/v1/accounts?filter[domain]=GLOBEX.test');
    expect(byDomain.json.data).toHaveLength(1);
  });
  it('creates prospects, derives name, links account, filters and paginates', async () => {
    const p1 = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', primaryEmail: 'ada@globex.test', account: { id: accountId } } } });
    expect(p1.status).toBe(201);
    expect(p1.json.data.name).toBe('Ada Lovelace');
    expect(p1.json.data.account).toEqual({ id: accountId, _href: `/v1/accounts/${accountId}` });
    expect(p1.json.data.sequenceStates).toEqual([]);
    for (let i = 0; i < 3; i++) {
      await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: `P${i}`, primaryEmail: `p${i}@x.test` } } });
    }
    const page1 = await t.request('/v1/prospects?page[size]=2');
    expect(page1.json.data).toHaveLength(2);
    expect(page1.json.links.next).toBeTruthy();
    const page2 = await t.request(page1.json.links.next);
    expect(page2.json.data).toHaveLength(2);
    expect(page2.json.links.prev).toBeTruthy();
    const ids = [...page1.json.data, ...page2.json.data].map((p: any) => p.id);
    expect(new Set(ids).size).toBe(4);
    const back = await t.request(page2.json.links.prev);
    expect(back.json.data.map((p: any) => p.id)).toEqual(page1.json.data.map((p: any) => p.id));
    const byAccount = await t.request(`/v1/prospects?filter[account][id]=${accountId}`);
    expect(byAccount.json.data).toHaveLength(1);
    const bad = await t.request('/v1/prospects?include=foo');
    expect(bad.status).toBe(400);
    const badAccount = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'X', account: { id: '00000000-0000-7000-8000-000000000000' } } } });
    expect(badAccount.status).toBe(422);
  });
  it('notes return NO_CRM_CONNECTION until a CRM is connected', async () => {
    const list = await t.request('/v1/prospects?filter[primaryEmail]=ada@globex.test');
    const pid = list.json.data[0].id;
    const r = await t.request(`/v1/prospects/${pid}/notes`, { method: 'POST', json: { data: { text: 'hi', integrationType: 'hubspot' } } });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'NO_CRM_CONNECTION', integrationType: 'hubspot' });
    const sync = await t.request('/v1/integrations/prospects/sync', { method: 'POST', json: { data: { type: 'salesforce', records: ['003xx'] } } });
    expect(sync.status).toBe(400);
    expect(sync.json.error.code).toBe('NO_CRM_CONNECTION');
  });
});

describe('openapi', () => {
  it('serves JSON and YAML documents with upstream operationIds', async () => {
    const r = await t.request('/openapi.json', { token: null });
    expect(r.status).toBe(200);
    const ops = Object.values(r.json.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
    expect(ops).toEqual(expect.arrayContaining(['listProspects', 'getProspect', 'createTag', 'getMe', 'getPublicIpList', 'listUsers', 'createAccountNote']));
    expect(r.json.paths['/prospects']).toBeDefined();
    const y = await t.request('/openapi.yml', { token: null });
    expect(y.headers.get('content-type')).toContain('yaml');
    expect(y.text).toContain('operationId: listTags');
  });
});
