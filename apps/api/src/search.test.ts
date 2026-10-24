import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { indexWorkspace } from '@cooks/core';
import { callTranscripts, calls, emails, prospects, workspaces } from '@cooks/db';
import { createTestApp, type TestApp } from './test/harness.js';

describe('search', () => {
  let t: TestApp;
  let adaId = '';
  let callId = '';

  beforeAll(async () => {
    t = await createTestApp();
    const acct = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex Corporation', domain: 'globex.test', industry: 'Logistics' } } });
    expect(acct.status).toBe(201);
    const ada = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', title: 'VP Engineering', primaryEmail: 'ada@globex.test', account: { id: acct.json.data.id } } } });
    expect(ada.status).toBe(201);
    adaId = ada.json.data.id;
    await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Grace', lastName: 'Hopper', primaryEmail: 'grace@navy.test' } } });
    const sig = await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'research.funding', title: 'Globex raised a $40M Series B', prospect: { id: adaId }, payload: { investor: 'Kleiner Perkins' } } } });
    expect(sig.status).toBe(201);
    const [call] = await t.db
      .insert(calls)
      .values({ workspaceId: t.workspaceId, prospectId: adaId, ownerId: t.ownerId, direction: 'outbound', source: 'dialer', status: 'completed', time: new Date('2026-03-01T15:00:00Z'), summary: 'Discussed seat pricing and the renewal timeline', mode: 'manual' } as typeof calls.$inferInsert)
      .returning();
    callId = call!.id;
    await t.db.insert(callTranscripts).values({
      workspaceId: t.workspaceId,
      callId,
      segments: [
        { speaker: 'rep', start: 0, end: 4, text: 'Hi Ada, this is Ray from Cooks.' },
        { speaker: 'prospect', start: 4, end: 9, text: 'We are comparing you against Salesforce for the renewal.' },
        { speaker: 'rep', start: 9, end: 14, text: 'Happy to walk through pricing per seat.' },
      ],
      text: 'Rep: Hi Ada. Prospect: We are comparing you against Salesforce for the renewal.',
    });
    await t.db.insert(emails).values({ workspaceId: t.workspaceId, prospectId: adaId, ownerId: t.ownerId, direction: 'outbound', status: 'sent', type: 'manual', fromAddr: 'ray@acme.test', toAddr: 'ada@globex.test', subject: 'Demo for the platform team', bodyText: 'Would Thursday work for a demo of the kernel scheduling benchmark?' } as typeof emails.$inferInsert);
  });
  afterAll(() => t.close());

  it('builds the index on first use and finds a prospect by part of the name', async () => {
    const r = await t.request(`/v1/search?q=${encodeURIComponent('Lovel')}`);
    expect(r.status).toBe(200);
    const types = r.json.data.map((h: { type: string }) => h.type);
    expect(types[0]).toBe('prospect');
    expect(r.json.data[0].title).toBe('Ada Lovelace');
    expect(r.json.data[0].href).toBe(`/prospects/${adaId}`);
  });

  it('finds a transcript line with a snippet and a timestamped link', async () => {
    const r = await t.request(`/v1/search?q=${encodeURIComponent('Salesforce renewal')}&types=transcript`);
    expect(r.status).toBe(200);
    expect(r.json.data.length).toBe(1);
    const hit = r.json.data[0];
    expect(hit.type).toBe('transcript');
    expect(hit.snippet).toContain('«Salesforce»');
    expect(hit.href).toBe(`/calls/${callId}#t=4`);
    expect(hit.meta.speaker).toBe('prospect');
    expect(hit.meta.who).toBe('Ada Lovelace');
    expect(hit.title).toBe('We are comparing you against Salesforce for the renewal.');
  });

  it('ranks across types and honours the type filter', async () => {
    const all = await t.request(`/v1/search?q=${encodeURIComponent('pricing')}`);
    const types = new Set(all.json.data.map((h: { type: string }) => h.type));
    expect(types.has('call')).toBe(true);
    expect(types.has('transcript')).toBe(true);
    const only = await t.request(`/v1/search?q=${encodeURIComponent('pricing')}&types=call`);
    expect(only.json.data.every((h: { type: string }) => h.type === 'call')).toBe(true);
    const sig = await t.request(`/v1/search?q=${encodeURIComponent('Kleiner')}`);
    expect(sig.json.data[0].type).toBe('signal');
    const mail = await t.request(`/v1/search?q=${encodeURIComponent('benchmark')}`);
    expect(mail.json.data[0].type).toBe('email');
    expect(mail.json.data[0].title).toBe('Demo for the platform team');
  });

  it('scopes to the prospect and to the workspace', async () => {
    const scoped = await t.request(`/v1/search?q=${encodeURIComponent('a')}&prospectId=${adaId}&limit=50`);
    expect(scoped.json.data.every((h: { prospectId: string | null }) => h.prospectId === adaId)).toBe(true);
    const [other] = await t.db.insert(workspaces).values({ name: 'Other', slug: 'other' }).returning();
    await t.db.insert(prospects).values({ workspaceId: other!.id, firstName: 'Secret', lastName: 'Person', name: 'Secret Person', primaryEmail: 'secret@other.test' } as typeof prospects.$inferInsert);
    await indexWorkspace(t.db, other!.id, { full: true });
    const leak = await t.request(`/v1/search?q=Secret`);
    expect(leak.json.data).toEqual([]);
  });

  it('picks up changes incrementally and drops soft-deleted rows', async () => {
    const renamed = await t.request(`/v1/prospects/${adaId}`, { method: 'PATCH', json: { data: { firstName: 'Augusta' } } });
    expect(renamed.status).toBe(200);
    await indexWorkspace(t.db, t.workspaceId);
    const r = await t.request(`/v1/search?q=Augusta`);
    expect(r.json.data[0].title).toBe('Augusta Lovelace');
    await t.db.update(prospects).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(prospects.id, adaId));
    await indexWorkspace(t.db, t.workspaceId);
    const gone = await t.request(`/v1/search?q=Augusta&types=prospect`);
    expect(gone.json.data).toEqual([]);
  });

  it('validates the query and queues a rebuild for admins', async () => {
    const empty = await t.request('/v1/search?q=');
    expect(empty.status).toBe(400);
    const re = await t.request('/v1/search/actions/reindex', { method: 'POST' });
    expect(re.status).toBe(202);
    expect(t.jobs.sent.some((j) => j.name === 'search.index' && j.data.full === true)).toBe(true);
  });

  it('lists the search routes as extensions', () => {
    const paths = t.registry.filter((r) => r.path.startsWith('/v1/search'));
    expect(paths.length).toBe(2);
    expect(paths.every((r) => r.meta.extension)).toBe(true);
  });
});
