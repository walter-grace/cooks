import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { outboxEvents, signals, tasks } from '@cooks/db';
import { evaluateSignal, systemPrincipal, type Ctx } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
let prospectId: string;
let accountId: string;
let sequenceId: string;
beforeAll(async () => {
  t = await createTestApp();
  const acc = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex', domain: 'globex.test' } } });
  accountId = acc.json.data.id;
  const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', primaryEmail: 'ada@globex.test', account: { id: accountId } } } });
  prospectId = p.json.data.id;
  const s = await t.request('/v1/sequences', { method: 'POST', json: { data: { name: 'Signal follow-up', owner: { id: t.ownerId } } } });
  sequenceId = s.json.data.id;
  await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: sequenceId }, action: 'call', interval: 0, name: 'Call them' } } });
});
afterAll(() => t.close());
const ctx = (): Ctx => ({ db: t.db, principal: systemPrincipal(t.workspaceId), jobs: t.jobs, clock: t.clock, traceId: 'test', publicUrl: 'http://localhost' });

describe('signals', () => {
  it('pushes a signal by prospect email, dedupes on dedupeKey, emits signal.created and queues evaluation', async () => {
    const r = await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'web.visit', title: 'Visited /pricing twice', url: 'https://globex.test/pricing', score: 0.8, prospect: { email: 'ADA@globex.test' }, dedupeKey: 'visit-1' } } });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ kind: 'web.visit', status: 'new', score: 0.8, prospect: { id: prospectId }, account: { id: accountId } });
    const again = await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'web.visit', prospect: { id: prospectId }, dedupeKey: 'visit-1' } } });
    expect(again.status).toBe(200);
    expect(again.json.data.id).toBe(r.json.data.id);
    const ev = await t.db.select().from(outboxEvents).where(eq(outboxEvents.eventType, 'signal.created'));
    expect(ev).toHaveLength(1);
    expect(t.jobs.sent.filter((j) => j.name === 'signals.evaluate')).toHaveLength(1);
  });
  it('rejects bad kinds and signals with no subject', async () => {
    expect((await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'Funding', prospect: { id: prospectId } } } })).status).toBe(422);
    expect((await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'custom.event' } } })).status).toBe(422);
    expect((await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'custom.event', prospect: { email: 'nobody@x.test' } } } })).status).toBe(422);
  });
  it('lists with kind prefix, status and include, and summarises', async () => {
    await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'research.funding', title: 'Raised $40M Series B', account: { domain: 'globex.test' }, score: 0.9, dedupeKey: 'f1' } } });
    const all = await t.request('/v1/signals?include=prospect,account');
    expect(all.status).toBe(200);
    expect(all.json.data).toHaveLength(2);
    expect(all.json.data.find((s: any) => s.kind === 'research.funding').account.name).toBe('Globex');
    const research = await t.request('/v1/signals?filter[kind]=research.*');
    expect(research.json.data.map((s: any) => s.kind)).toEqual(['research.funding']);
    const sum = await t.request('/v1/signals/summary?days=7');
    expect(sum.json.data).toMatchObject({ total: 2, new: 2, byKind: { 'web.visit': 1, 'research.funding': 1 } });
    expect(sum.json.data.catalog['research.funding']).toBeTruthy();
  });
  it('acts on a signal by hand: enroll, then task; dismiss', async () => {
    const list = await t.request('/v1/signals?filter[kind]=research.funding');
    const sig = list.json.data[0];
    const enroll = await t.request(`/v1/signals/${sig.id}/actions/act`, { method: 'POST', json: { data: { action: 'enroll', sequenceId, ownerId: t.ownerId } } });
    expect(enroll.status).toBe(200);
    expect(enroll.json.data).toMatchObject({ action: 'enroll', enrolled: true });
    const after = await t.request(`/v1/signals/${sig.id}`);
    expect(after.json.data).toMatchObject({ status: 'acted', actedAction: 'enroll' });
    const visit = (await t.request('/v1/signals?filter[kind]=web.visit')).json.data[0];
    const task = await t.request(`/v1/signals/${visit.id}/actions/act`, { method: 'POST', json: { data: { action: 'task', ownerId: t.ownerId, taskAction: 'call' } } });
    expect(task.status).toBe(200);
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, task.json.data.taskId));
    expect(row!.action).toBe('call');
    expect(row!.note).toContain('Visited /pricing');
    const pushed = await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'custom.event', title: 'noise', prospect: { id: prospectId } } } });
    const dis = await t.request(`/v1/signals/${pushed.json.data.id}/actions/dismiss`, { method: 'POST' });
    expect(dis.json.data.status).toBe('dismissed');
    expect((await t.request('/v1/signals?filter[status]=new')).json.data).toHaveLength(0);
  });
  it('rules: admin-only create, pattern + score gate, fires once per action, counts', async () => {
    const bad = await t.request('/v1/workspace/signalRules', { method: 'POST', json: { data: { kindPattern: 'research', action: 'enroll', ownerId: t.ownerId } } });
    expect(bad.status).toBe(422);
    const noSeq = await t.request('/v1/workspace/signalRules', { method: 'POST', json: { data: { kindPattern: 'research.*', action: 'enroll', ownerId: t.ownerId } } });
    expect(noSeq.status).toBe(422);
    const rule = await t.request('/v1/workspace/signalRules', { method: 'POST', json: { data: { name: 'Hiring → task', kindPattern: 'research.hiring', minScore: 0.5, action: 'task', ownerId: t.ownerId, taskAction: 'basic_task', taskNote: 'Check the job posts' } } });
    expect(rule.status).toBe(201);
    // below the score gate: nothing fires
    const low = await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'research.hiring', title: 'Hiring 2 SDRs', score: 0.2, account: { id: accountId }, dedupeKey: 'h-low' } } });
    expect((await evaluateSignal(ctx(), low.json.data.id)).fired).toHaveLength(0);
    // above it: a task for the account's prospect, signal marked acted, rule counted
    const hi = await t.request('/v1/signals', { method: 'POST', json: { data: { kind: 'research.hiring', title: 'Hiring 20 AEs', score: 0.9, account: { id: accountId }, dedupeKey: 'h-hi' } } });
    const res = await evaluateSignal(ctx(), hi.json.data.id);
    expect(res.fired).toHaveLength(1);
    expect((res.fired![0] as any).taskId).toBeTruthy();
    const [sigRow] = await t.db.select().from(signals).where(eq(signals.id, hi.json.data.id));
    expect(sigRow!.status).toBe('acted');
    const rules = await t.request('/v1/workspace/signalRules');
    expect(rules.json.data.find((r: any) => r.id === rule.json.data.id)).toMatchObject({ firedCount: 1, name: 'Hiring → task' });
    // second evaluation of the same signal is a no-op
    expect((await evaluateSignal(ctx(), hi.json.data.id)).skipped).toBe('acted');
    const del = await t.request(`/v1/workspace/signalRules/${rule.json.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
  });
  it('queues an account scan', async () => {
    const r = await t.request(`/v1/accounts/${accountId}/actions/scan`, { method: 'POST', json: { data: { focus: 'hiring' } } });
    expect(r.status).toBe(202);
    expect(t.jobs.sent.find((j) => j.name === 'signals.scan')?.data).toMatchObject({ accountId, focus: 'hiring' });
  });
});
