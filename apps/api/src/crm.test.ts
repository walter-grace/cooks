import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { notes, prospects, sequenceStates } from '@cooks/db';
import { logCallTaskToHubspot, logEmailToHubspot, systemPrincipal, type Ctx } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

/** In-memory HubSpot: contacts, companies, owners, a list, deals; records engagement writes. */
function fakeHubspot() {
  const contacts: Record<string, Record<string, string | null>> = {
    '101': { firstname: 'Ada', lastname: 'Lovelace', email: 'ada@globex.test', jobtitle: 'CTO', hubspot_owner_id: '7', associatedcompanyid: '900', hs_timezone: 'America/New_York' },
    '102': { firstname: 'Grace', lastname: 'Hopper', email: 'grace@globex.test', jobtitle: 'COO', hubspot_owner_id: '8', associatedcompanyid: '900' },
    '103': { firstname: null, lastname: null, email: null, associatedcompanyid: null },
  };
  const companies: Record<string, Record<string, string | null>> = { '900': { name: 'Globex', domain: 'Globex.test', industry: 'Manufacturing', numberofemployees: '1200' } };
  const writes: Array<{ path: string; body: any }> = [];
  let tokenOk = true;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = (init?.headers as Record<string, string>)?.authorization ?? '';
    if (!tokenOk || !auth.endsWith('good-token')) return Response.json({ status: 'error', message: 'invalid token' }, { status: 401 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const p = url.pathname;
    if (p === '/account-info/v3/details') return Response.json({ portalId: 424242 });
    if (p === '/crm/v3/owners') return Response.json({ results: [{ id: '7', email: 'owner@acme.test' }, { id: '8', email: 'rep@acme.test' }, { id: '9', email: 'nobody@x.test' }] });
    if (p === '/crm/v3/objects/contacts/batch/read') {
      const byEmail = body.idProperty === 'email';
      const results = (body.inputs as Array<{ id: string }>)
        .map(({ id }) => (byEmail ? Object.entries(contacts).find(([, c]) => c.email?.toLowerCase() === id.toLowerCase()) : contacts[id] ? [id, contacts[id]] : undefined))
        .filter((x): x is [string, Record<string, string | null>] => !!x)
        .map(([id, properties]) => ({ id, properties }));
      return Response.json({ results });
    }
    if (p === '/crm/v3/objects/companies/batch/read') return Response.json({ results: (body.inputs as Array<{ id: string }>).filter((i) => companies[i.id]).map((i) => ({ id: i.id, properties: companies[i.id] })) });
    if (p.startsWith('/crm/v3/lists/') && p.endsWith('/memberships')) return Response.json({ results: [{ recordId: '101' }, { recordId: '102' }, { recordId: '103' }] });
    if (p === '/crm/v3/objects/deals/search') return Response.json({ results: [{ id: 'd1' }] });
    if (p === '/crm/v4/objects/deals/d1/associations/contacts') return Response.json({ results: [{ toObjectId: 102 }] });
    if (p === '/crm/v3/objects/notes' || p === '/crm/v3/objects/emails' || p === '/crm/v3/objects/calls') {
      writes.push({ path: p, body });
      return Response.json({ id: `w${writes.length}` }, { status: 201 });
    }
    return Response.json({ message: `unhandled ${p}` }, { status: 404 });
  };
  return { fetchImpl, writes, setTokenOk: (v: boolean) => (tokenOk = v) };
}

let t: TestApp;
const hs = fakeHubspot();
beforeAll(async () => {
  t = await createTestApp({ fetchImpl: hs.fetchImpl });
});
afterAll(() => t.close());
const ctx = (): Ctx => ({ db: t.db, principal: systemPrincipal(t.workspaceId), jobs: t.jobs, clock: t.clock, traceId: 'test', publicUrl: 'http://localhost' });

describe('HubSpot connection', () => {
  it('rejects a bad token, accepts a good one, learns the owner map, hides the token', async () => {
    const bad = await t.request('/v1/workspace/crm/hubspot', { method: 'PUT', json: { data: { accessToken: 'pat-na1-bad-token' } } });
    expect(bad.status).toBe(422);
    const ok = await t.request('/v1/workspace/crm/hubspot', { method: 'PUT', json: { data: { accessToken: 'pat-na1-good-token' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ type: 'hubspot', status: 'connected', hubspot: { portalId: 424242, kind: 'private_app', tokenLast4: 'oken' }, settings: { ownerMapSize: 2, logEmails: true } });
    expect(JSON.stringify(ok.json)).not.toContain('good-token');
  });
  it('syncs contacts by id and by email, creating accounts and mapping owners', async () => {
    const r = await t.request('/v1/integrations/prospects/sync', { method: 'POST', json: { data: { type: 'hubspot', records: ['101', '103', '999'] } } });
    expect(r.status).toBe(200);
    expect(r.json.results).toHaveLength(1);
    expect(r.json.results[0]).toMatchObject({ externalId: '101', created: true });
    expect(r.json.errors.map((e: any) => e.code).sort()).toEqual(['MAPPING_FAILED', 'NOT_FOUND_IN_CRM']);
    const [ada] = await t.db.select().from(prospects).where(eq(prospects.crmId, '101'));
    expect(ada).toMatchObject({ name: 'Ada Lovelace', title: 'CTO', primaryEmail: 'ada@globex.test', ownerId: t.ownerId, timezone: 'America/New_York', crmType: 'hubspot' });
    const acc = await t.request(`/v1/accounts/${ada!.accountId}`);
    expect(acc.json.data).toMatchObject({ name: 'Globex', domain: 'globex.test', numEmployees: 1200 });
    const again = await t.request('/v1/integrations/prospects/sync', { method: 'POST', json: { data: { type: 'hubspot', records: ['101'] } } });
    expect(again.json.results[0].created).toBe(false);
    const byEmail = await t.request('/v1/integrations/hubspot/import', { method: 'POST', json: { data: { emails: ['GRACE@globex.test', 'nobody@globex.test'] } } });
    expect(byEmail.json.results[0]).toMatchObject({ externalId: 'grace@globex.test', created: true });
    expect(byEmail.json.errors[0].code).toBe('NOT_FOUND_IN_CRM');
  });
  it('writes notes to HubSpot with the right associations, and logs sent emails and completed calls', async () => {
    const [ada] = await t.db.select().from(prospects).where(eq(prospects.crmId, '101'));
    const n = await t.request(`/v1/prospects/${ada!.id}/notes`, { method: 'POST', json: { data: { text: 'Spoke at the conference', integrationType: 'hubspot' } } });
    expect(n.status).toBe(201);
    expect(n.json.data).toMatchObject({ integrationType: 'hubspot', externalId: 'w1' });
    const noteWrite = hs.writes.find((w) => w.path === '/crm/v3/objects/notes')!;
    expect(noteWrite.body.properties.hs_note_body).toBe('Spoke at the conference');
    expect(noteWrite.body.associations[0].types[0].associationTypeId).toBe(202);
    const wrongType = await t.request(`/v1/prospects/${ada!.id}/notes`, { method: 'POST', json: { data: { text: 'x', integrationType: 'salesforce' } } });
    expect(wrongType.status).toBe(422);
    expect(await t.db.select().from(notes)).toHaveLength(1);

    const sent = await t.request('/v1/emails', { method: 'POST', json: { data: { prospectId: ada!.id, ownerId: t.ownerId, subject: 'Hi Ada', bodyHtml: '<p>hello</p>', send: true } } });
    await t.db.execute(`update emails set status='sent', date=now(), body_text='hello', from_addr='owner@acme.test' where id='${sent.json.data.id}'` as never);
    expect(await logEmailToHubspot(ctx(), sent.json.data.id, { kek: t.kek, fetchImpl: hs.fetchImpl })).toBe('logged');
    const emailWrite = hs.writes.find((w) => w.path === '/crm/v3/objects/emails')!;
    expect(emailWrite.body.properties).toMatchObject({ hs_email_direction: 'EMAIL', hs_email_subject: 'Hi Ada', hubspot_owner_id: '7' });
    expect(emailWrite.body.associations[0]).toMatchObject({ to: { id: '101' }, types: [{ associationTypeId: 198 }] });

    const task = await t.request('/v1/tasks', { method: 'POST', json: { data: { action: 'call', dueAt: '2026-03-03T15:00:00Z', ownerId: t.repId, prospectId: ada!.id, note: 'Left voicemail' } } });
    await t.request(`/v1/tasks/${task.json.data.id}/complete`, { method: 'POST' });
    expect(await logCallTaskToHubspot(ctx(), task.json.data.id, { kek: t.kek, fetchImpl: hs.fetchImpl })).toBe('logged');
    const callWrite = hs.writes.find((w) => w.path === '/crm/v3/objects/calls')!;
    expect(callWrite.body.properties).toMatchObject({ hs_call_title: 'Call with Ada Lovelace', hs_call_body: 'Left voicemail', hubspot_owner_id: '8' });
    expect(callWrite.body.associations[0].types[0].associationTypeId).toBe(194);
  });
  it('auto-enroll rules: list and deal-stage sources enroll new prospects once', async () => {
    const seq = await t.request('/v1/sequences', { method: 'POST', json: { data: { name: 'HS inbound', owner: { id: t.ownerId } } } });
    await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: seq.json.data.id }, action: 'call', interval: 0 } } });
    const rule = await t.request('/v1/workspace/crm/rules', { method: 'POST', json: { data: { kind: 'list', listId: '55', sequenceId: seq.json.data.id, ownerId: t.ownerId } } });
    expect(rule.status).toBe(201);
    const ruleId = rule.json.data.settings.autoEnroll[0].id;
    const run = await t.request(`/v1/workspace/crm/rules/${ruleId}/actions/run`, { method: 'POST' });
    expect(run.json.data).toEqual({ synced: 2, enrolled: 2, skipped: 0 }); // 103 has no name/email → mapping error, not synced
    const again = await t.request(`/v1/workspace/crm/rules/${ruleId}/actions/run`, { method: 'POST' });
    expect(again.json.data).toEqual({ synced: 2, enrolled: 0, skipped: 2 });
    const states = await t.db.select().from(sequenceStates).where(eq(sequenceStates.sequenceId, seq.json.data.id));
    expect(states).toHaveLength(2);
    const stage = await t.request('/v1/workspace/crm/rules', { method: 'POST', json: { data: { kind: 'dealStage', pipelineId: 'default', stageId: 'appointmentscheduled', sequenceId: seq.json.data.id, ownerId: t.ownerId } } });
    const stageRule = stage.json.data.settings.autoEnroll[1].id;
    const r2 = await t.request(`/v1/workspace/crm/rules/${stageRule}/actions/run`, { method: 'POST' });
    expect(r2.json.data).toEqual({ synced: 1, enrolled: 0, skipped: 1 }); // Grace already enrolled
    const removed = await t.request(`/v1/workspace/crm/rules/${ruleId}`, { method: 'DELETE' });
    expect(removed.json.data.settings.autoEnroll).toHaveLength(1);
    const bad = await t.request('/v1/workspace/crm/rules', { method: 'POST', json: { data: { kind: 'list', sequenceId: seq.json.data.id, ownerId: t.ownerId } } });
    expect(bad.status).toBe(400);
  });
  it('disconnect returns NO_CRM_CONNECTION afterwards; rep cannot manage the connection', async () => {
    const rep = await t.request('/auth/login', { token: null, method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'rep@acme.test', password: 'hunter22' }).toString() });
    const cookie = rep.headers.get('set-cookie')!.split(';')[0]!;
    const tok = await t.request('/auth/session-token', { token: null, method: 'POST', json: {}, headers: { cookie } });
    const denied = await t.request('/v1/workspace/crm', { token: tok.json.access_token, method: 'DELETE' });
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('INSUFFICIENT_PERMISSION');
    const off = await t.request('/v1/workspace/crm', { method: 'DELETE' });
    expect(off.status).toBe(204);
    const sync = await t.request('/v1/integrations/prospects/sync', { method: 'POST', json: { data: { type: 'hubspot', records: ['101'] } } });
    expect(sync.status).toBe(400);
    expect(sync.json.error.code).toBe('NO_CRM_CONNECTION');
  });
});
