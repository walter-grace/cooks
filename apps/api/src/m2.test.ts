import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { advanceEnrollment, executeStep, systemPrincipal, type Ctx } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
const ids = { seq: '', s1: '', s2: '', s3: '', prospect: '', state: '', task: '' };
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const engineCtx = (): Ctx => ({ db: t.db, principal: systemPrincipal(t.workspaceId), jobs: t.jobs, clock: t.clock, traceId: 'test', publicUrl: 'http://localhost' });

describe('sequences + steps', () => {
  it('creates a sequence with tags and owner, lists and includes', async () => {
    const tag = await t.request('/v1/tags', { method: 'POST', json: { data: { name: 'Outbound' } } });
    const r = await t.request('/v1/sequences', { method: 'POST', json: { data: { name: 'Intro', owner: { id: t.ownerId }, tags: [{ id: tag.json.data.id }] } } });
    expect(r.status).toBe(201);
    ids.seq = r.json.data.id;
    expect(r.json.data).toMatchObject({ type: 'interval', enabled: true, privacy: 'team_editable', sequenceSteps: [], parentSequence: null });
    expect(r.json.data.tags[0].name).toBe('Outbound');
    expect(r.json.data.analytics.email.delivered).toBe(0);
    expect(r.json.data.owner).toEqual({ id: t.ownerId, _href: `/v1/users/${t.ownerId}` });
    const bad = await t.request('/v1/sequences', { method: 'POST', json: { data: { name: 'X', owner: { id: 'nobody' } } } });
    expect(bad.status).toBe(422);
    const inc = await t.request(`/v1/sequences/${ids.seq}?include=owner`);
    expect(inc.json.data.owner.email).toBe('owner@acme.test');
    const tooMany = await t.request(`/v1/sequences/${ids.seq}?include=owner,sequenceSteps,x,y`);
    expect(tooMany.status).toBe(400);
  });
  it('adds steps with auto-created templates, enforces rules, reorders', async () => {
    const s1 = await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: ids.seq }, action: 'call', interval: 0, name: 'Dial' } } });
    expect(s1.status).toBe(201);
    expect(s1.json.data).toMatchObject({ order: 1, action: 'call', interval: 0, template: null });
    const s2 = await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: ids.seq }, action: 'manual_email', interval: 1440, emailSubject: 'Hi {{prospect.firstName}}', emailBody: '<p>Hello</p>' } } });
    expect(s2.status).toBe(201);
    expect(s2.json.data.template.subject).toBe('Hi {{prospect.firstName}}');
    expect(s2.json.data.template.source).toBe('step_auto');
    const s3 = await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: ids.seq }, action: 'auto_email_reply', interval: 2880, emailSubject: 'ignored', emailBody: 'bump' } } });
    expect(s3.json.data.template.subject).toBe('');
    ids.s1 = s1.json.data.id;
    ids.s2 = s2.json.data.id;
    ids.s3 = s3.json.data.id;
    // only one LinkedIn connection request per sequence
    const li1 = await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: ids.seq }, action: 'linkedin_connection_request', interval: 10 } } });
    expect(li1.status).toBe(201);
    const li2 = await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: ids.seq }, action: 'linkedin_connection_request', interval: 10 } } });
    expect(li2.status).toBe(422);
    // automatic_linkedin_message is not creatable
    const auto = await t.request('/v1/sequenceSteps', { method: 'POST', json: { data: { sequence: { id: ids.seq }, action: 'automatic_linkedin_message', interval: 10 } } });
    expect(auto.status).toBe(400);
    // channel change is rejected
    const chg = await t.request(`/v1/sequenceSteps/${ids.s1}`, { method: 'PATCH', json: { data: { action: 'manual_email' } } });
    expect(chg.status).toBe(422);
    const ok = await t.request(`/v1/sequenceSteps/${ids.s1}`, { method: 'PATCH', json: { data: { interval: 5, note: 'be nice' } } });
    expect(ok.json.data).toMatchObject({ interval: 5, note: 'be nice' });
    // reorder must list every step
    const partial = await t.request(`/v1/sequences/${ids.seq}/actions/reorderSteps`, { method: 'POST', json: { data: { stepIds: [ids.s2, ids.s1] } } });
    expect(partial.status).toBe(422);
    const full = await t.request(`/v1/sequences/${ids.seq}/actions/reorderSteps`, { method: 'POST', json: { data: { stepIds: [ids.s2, ids.s1, li1.json.data.id, ids.s3] } } });
    expect(full.status).toBe(200);
    expect(full.json.data.sequenceSteps.map((s: any) => s.order)).toEqual([1, 2, 3, 4]);
    expect(full.json.data.sequenceSteps[0].id).toBe(ids.s2);
    const del = await t.request(`/v1/sequenceSteps/${li1.json.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const list = await t.request(`/v1/sequenceSteps?filter[sequence][id]=${ids.seq}&include=template`);
    expect(list.json.data).toHaveLength(3);
    const tpl = await t.request(`/v1/emailTemplate/${s2.json.data.template.id}`);
    expect(tpl.status).toBe(200);
    const tpls = await t.request('/v1/emailTemplates?filter[archived]=false');
    expect(tpls.json.data.length).toBeGreaterThanOrEqual(2);
  });
});

describe('enrollments + tasks', () => {
  it('enrolls, 409s on duplicate, 422s without email, runs the engine, completes tasks', async () => {
    const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Grace', lastName: 'Hopper', primaryEmail: 'grace@x.test', timezone: 'UTC' } } });
    ids.prospect = p.json.data.id;
    const noEmail = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'NoMail' } } });
    const e422 = await t.request('/v1/sequenceStates', { method: 'POST', json: { data: { prospect: { id: noEmail.json.data.id }, sequence: { id: ids.seq }, owner: { id: t.ownerId } } } });
    expect(e422.status).toBe(422);

    t.jobs.clear();
    const e = await t.request('/v1/sequenceStates', { method: 'POST', json: { data: { prospect: { id: ids.prospect }, sequence: { id: ids.seq }, owner: { id: t.ownerId }, emailOverrides: { [ids.s2]: { subject: 'Custom' } } } } });
    expect(e.status).toBe(201);
    ids.state = e.json.data.id;
    expect(e.json.data).toMatchObject({ state: 'active', sequenceStep: null });
    expect(t.jobs.sent.map((j) => j.name)).toEqual(['enrollment.advance']);
    const dup = await t.request('/v1/sequenceStates', { method: 'POST', json: { data: { prospect: { id: ids.prospect }, sequence: { id: ids.seq }, owner: { id: t.ownerId } } } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe('CONFLICT');
    const badOverride = await t.request(`/v1/sequenceStates/${ids.state}`, { method: 'PATCH', json: { data: { emailOverrides: { '00000000-0000-7000-8000-000000000000': { subject: 'x' } } } } });
    expect(badOverride.status).toBe(422);

    // the prospect now shows the enrollment; include expands it
    const pr = await t.request(`/v1/prospects/${ids.prospect}?include=sequenceStates`);
    expect(pr.json.data.sequenceStates[0]).toMatchObject({ id: ids.state, state: 'active' });

    // run the engine: first step (manual_email, after reorder) → task
    t.clock.set(new Date('2026-03-03T15:00:00Z'));
    expect(await advanceEnrollment(engineCtx(), ids.state)).toBe('scheduled');
    const st = await t.request(`/v1/sequenceStates/${ids.state}?include=sequenceStep`);
    expect(st.json.data.sequenceStep.id).toBe(ids.s2);
    expect(await executeStep(engineCtx(), ids.state, ids.s2)).toBe('task_created');
    const due = await t.request(`/v1/tasks?filter[sequenceState][state]=active&filter[completed]=false&include=prospect`);
    expect(due.json.data).toHaveLength(1);
    expect(due.json.data[0]).toMatchObject({ action: 'manual_email', status: 'ready', completed: false });
    expect(due.json.data[0].prospect.name).toBe('Grace Hopper');
    ids.task = due.json.data[0].id;

    t.jobs.clear();
    const done = await t.request(`/v1/tasks/${ids.task}/complete`, { method: 'POST' });
    expect(done.status).toBe(200);
    expect(done.json.data).toMatchObject({ completed: true, status: 'finished' });
    expect(t.jobs.sent.map((j) => j.name)).toEqual(['enrollment.advance']);
    const again = await t.request(`/v1/tasks/${ids.task}/complete`, { method: 'POST' });
    expect(again.status).toBe(200); // idempotent
    const skipDone = await t.request(`/v1/tasks/${ids.task}/skip`, { method: 'POST' });
    expect(skipDone.status).toBe(409);

    // pause/resume extension, then finish idempotently
    const paused = await t.request(`/v1/sequenceStates/${ids.state}/actions/pause`, { method: 'POST' });
    expect(paused.json.data.state).toBe('paused');
    const resumed = await t.request(`/v1/sequenceStates/${ids.state}/actions/resume`, { method: 'POST' });
    expect(resumed.json.data.state).toBe('active');
    const fin = await t.request(`/v1/sequenceStates/${ids.state}/actions/finish`, { method: 'POST' });
    expect(fin.status).toBe(204);
    const fin2 = await t.request(`/v1/sequenceStates/${ids.state}/actions/finish`, { method: 'POST' });
    expect(fin2.status).toBe(204);
    const finished = await t.request(`/v1/sequenceStates?filter[state]=finished`);
    expect(finished.json.data).toHaveLength(1);
    // re-enrollment after finish is allowed
    const re = await t.request('/v1/sequenceStates', { method: 'POST', json: { data: { prospect: { id: ids.prospect }, sequence: { id: ids.seq }, owner: { id: t.ownerId }, state: 'paused' } } });
    expect(re.status).toBe(201);
    expect(re.json.data.state).toBe('paused');
    const removed = await t.request(`/v1/sequenceStates/${re.json.data.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
  });
  it('one-off tasks: create, patch, filters, delete', async () => {
    const c = await t.request('/v1/tasks', { method: 'POST', json: { data: { action: 'call', dueAt: '2026-03-10T15:00:00Z', ownerId: t.repId, prospectId: ids.prospect, priority: 'high' } } });
    expect(c.status).toBe(201);
    expect(c.json.data).toMatchObject({ action: 'call', priority: 'high', sequence: null, owner: { id: t.repId } });
    const badAction = await t.request('/v1/tasks', { method: 'POST', json: { data: { action: 'auto_email', dueAt: '2026-03-10T15:00:00Z', ownerId: t.repId, prospectId: ids.prospect } } });
    expect(badAction.status).toBe(400);
    const u = await t.request(`/v1/tasks/${c.json.data.id}`, { method: 'PATCH', json: { data: { priority: 'urgent', note: 'asap' } } });
    expect(u.json.data).toMatchObject({ priority: 'urgent', note: 'asap' });
    const byOwner = await t.request(`/v1/tasks?filter[owner][id]=${t.repId}&filter[dueAt][gte]=2026-03-10T00:00:00Z`);
    expect(byOwner.json.data).toHaveLength(1);
    const d = await t.request(`/v1/tasks/${c.json.data.id}`, { method: 'DELETE' });
    expect(d.status).toBe(204);
    const gone = await t.request(`/v1/tasks/${c.json.data.id}`);
    expect(gone.status).toBe(404);
  });
  it('disabling a sequence holds its active enrollments', async () => {
    const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Hold', primaryEmail: 'hold@x.test' } } });
    const e = await t.request('/v1/sequenceStates', { method: 'POST', json: { data: { prospect: { id: p.json.data.id }, sequence: { id: ids.seq }, owner: { id: t.ownerId } } } });
    await advanceEnrollment(engineCtx(), e.json.data.id);
    const off = await t.request(`/v1/sequences/${ids.seq}`, { method: 'PATCH', json: { data: { enabled: false } } });
    expect(off.json.data.enabled).toBe(false);
    expect(await executeStep(engineCtx(), e.json.data.id, ids.s2)).toBe('skipped');
    t.jobs.clear();
    await t.request(`/v1/sequences/${ids.seq}`, { method: 'PATCH', json: { data: { enabled: true } } });
    expect(t.jobs.sent.some((j) => j.name === 'step.execute')).toBe(true);
  });
});
