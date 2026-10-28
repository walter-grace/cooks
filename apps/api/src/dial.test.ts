import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { callTranscripts, calls, tasks } from '@cooks/db';
import { dialCallState, dialInstruction, pollAiCall, systemPrincipal, type Ctx } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

/** In-memory Dial (api.getdial.ai). Calls advance one state per GET: Queued → Ringing → In-Progress → Terminated. */
function fakeDial() {
  const placed: Array<{ body: Record<string, any>; headers: Record<string, string> }> = [];
  const callsById = new Map<string, { gets: number; stopped: boolean; to: string; createdAt: string }>();
  let n = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const m = init?.method ?? 'GET';
    if (url.hostname === 'dial.test') {
      if (headers.authorization !== 'Bearer sk_live_dialgood') return Response.json({ error: 'Invalid API key' }, { status: 401 });
      if (url.pathname === '/api/v1/account') return Response.json({ id: 'acct_1', email: 'owner@example.test', role: 'owner', maxCallDurationSeconds: null, limits: { maxCallDurationSeconds: 300, maxConcurrentCalls: 2 } });
      if (url.pathname === '/api/v1/billing') return Response.json({ ok: true, balanceCents: 200, numbers: [{ id: 'num_1', number: '+16815550100', mode: 'PAYG', ownershipCents: 300 }], pricing: { monthlyCents: 2000 } });
      if (url.pathname === '/api/v1/numbers' && m === 'GET') return Response.json({ numbers: [{ id: 'num_1', number: '+16815550100', nickname: null, capabilities: ['sms', 'call'], callingEnabled: true, country: 'US' }, { id: 'num_2', number: '+16815550199', nickname: 'texts only', capabilities: ['sms', 'call'], callingEnabled: false, country: 'US' }] });
      if (url.pathname === '/api/v1/calls' && m === 'POST') {
        const body = JSON.parse(String(init?.body));
        placed.push({ body, headers });
        if (body.to === '+15550009999') return Response.json({ error: 'Insufficient credit', code: 'insufficient_credit' }, { status: 402 });
        const id = `call_${++n}`;
        const createdAt = '2026-03-03T15:00:05.000Z';
        callsById.set(id, { gets: 0, stopped: false, to: body.to, createdAt });
        return Response.json({ call: { id, phoneNumberId: 'num_1', from: body.fromNumber, to: body.to, direction: 'outbound', status: { state: 'Queued', terminationType: null, cancelRequested: false, cancelPending: false, label: 'Queued' }, duration: 0, transcript: null, transcriptTurns: null, voiceRuntime: 'managed', createdAt } }, { status: 201 });
      }
      const one = /^\/api\/v1\/calls\/([^/]+)(\/stop)?$/.exec(url.pathname);
      if (one) {
        const c = callsById.get(one[1]!);
        if (!c) return Response.json({ error: 'Not found' }, { status: 404 });
        if (one[2]) {
          c.stopped = true;
          return Response.json({ call: { id: one[1], status: { state: 'In-Progress', cancelRequested: true, cancelPending: true, label: 'Hanging up' } } });
        }
        c.gets += 1;
        const base = { id: one[1], phoneNumberId: 'num_1', from: '+16815550100', to: c.to, direction: 'outbound', voiceRuntime: 'managed', createdAt: c.createdAt };
        if (c.stopped) return Response.json({ call: { ...base, status: { state: 'Terminated', terminationType: 'canceled', cancelRequested: true, cancelPending: false, label: 'Completed (Cancelled)' }, duration: 4, transcript: null, transcriptTurns: null } });
        if (c.gets >= 3)
          return Response.json({
            call: {
              ...base,
              status: { state: 'Terminated', terminationType: 'completed', cancelRequested: false, cancelPending: false, label: 'Completed' },
              duration: 41,
              transcript: 'Agent: Hi Ada… User: Sure, Thursday works.',
              transcriptTurns: [
                { speaker: 'agent', text: "Hi Ada, this is Olive Owner's assistant at Acme. Do you have thirty seconds?", startMs: 1200, endMs: 4900 },
                { speaker: 'user', text: 'Sure, Thursday works.', startMs: 5400, endMs: 7100 },
              ],
            },
          });
        return Response.json({ call: { ...base, status: { state: c.gets === 1 ? 'Ringing' : 'In-Progress', terminationType: null, cancelRequested: false, cancelPending: false, label: c.gets === 1 ? 'Ringing' : 'In progress' }, duration: 0, transcript: null, transcriptTurns: null } });
      }
      return Response.json({ error: `unhandled ${url.pathname}` }, { status: 404 });
    }
    return Response.json({ message: `unhandled host ${url.hostname}` }, { status: 404 });
  };
  return { fetchImpl, placed, callsById };
}

let t: TestApp;
const fake = fakeDial();
let prospectId: string;
const DAY = new Date('2026-03-03T15:00:00Z');
const deps = () => ({ kek: t.kek, fetchImpl: fake.fetchImpl, dial: { apiBase: 'http://dial.test' }, publicUrl: 'http://localhost' });
const ctx = (): Ctx => ({ db: t.db, principal: systemPrincipal(t.workspaceId), jobs: t.jobs, clock: t.clock, traceId: 'test', publicUrl: 'http://localhost' });

beforeAll(async () => {
  t = await createTestApp({ fetchImpl: fake.fetchImpl, telephony: { trustWebhookSignature: false, dial: { apiBase: 'http://dial.test' } } });
  t.clock.set(DAY);
  const acc = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex', domain: 'globex.test' } } });
  const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', title: 'VP Engineering', primaryEmail: 'ada@globex.test', phone: '(555) 010-2020', timezone: 'UTC', account: { id: acc.json.data.id } } } });
  prospectId = p.json.data.id;
});
afterAll(() => t.close());

describe('pure helpers', () => {
  it('folds the opening line and voicemail rule into one Dial instruction', () => {
    const s = dialInstruction({ systemPrompt: 'Book a meeting.', firstMessage: 'Hi Ada, got thirty seconds?', onMachine: 'hangup' });
    expect(s).toBe('Book a meeting.\n\nOpen the call with exactly this line, then listen: "Hi Ada, got thirty seconds?"\n\nIf you reach voicemail or an answering machine, hang up without leaving a message.');
    expect(dialInstruction({ onMachine: 'leave_message', voicemailMessage: 'Call us back.' })).toContain('leave this message and hang up: "Call us back."');
  });
  it('maps Dial call objects onto outcomes', () => {
    expect(dialCallState({ id: 'c', status: { state: 'Queued' } })).toMatchObject({ status: 'queued', outcome: null });
    expect(dialCallState({ id: 'c', status: { state: 'Ringing' } })).toMatchObject({ status: 'ringing' });
    expect(dialCallState({ id: 'c', status: { state: 'In-Progress' } })).toMatchObject({ status: 'in_progress' });
    expect(dialCallState({ id: 'c', status: { state: 'Terminated', terminationType: 'completed' }, duration: 30, createdAt: '2026-03-03T15:00:05Z', transcriptTurns: [{ speaker: 'user', text: 'hi', startMs: 1000, endMs: 1500 }] })).toMatchObject({ status: 'ended', outcome: 'answered', durationSeconds: 30, costUsd: null, transcript: [{ role: 'user', text: 'hi', startedAt: '2026-03-03T15:00:06.000Z' }] });
    expect(dialCallState({ id: 'c', status: { state: 'Terminated', terminationType: 'completed' }, duration: 0 }).outcome).toBe('no_answer');
    expect(dialCallState({ id: 'c', status: { state: 'Terminated', terminationType: 'no-answer' } }).outcome).toBe('no_answer');
    expect(dialCallState({ id: 'c', status: { state: 'Terminated', terminationType: 'busy' } })).toMatchObject({ outcome: 'failed', endReason: 'busy' });
    expect(dialCallState({ id: 'c', status: { state: 'Terminated', terminationType: 'failed' }, failureReason: 'self_hosted_unreachable' }).endReason).toBe('failed: self_hosted_unreachable');
  });
});

describe('connect Dial', () => {
  it('rejects a bad key, stores a good one encrypted, keeps only numbers that can call, becomes the dialer', async () => {
    const bad = await t.request('/v1/workspace/telephony/dial', { method: 'PUT', json: { data: { apiKey: 'sk_live_badkey' } } });
    expect(bad.status).toBe(422);
    const ok = await t.request('/v1/workspace/telephony/dial', { method: 'PUT', json: { data: { apiKey: 'sk_live_dialgood' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ provider: 'dial', status: 'connected', keySource: 'workspace', keyLast4: 'good', fromNumbers: ['+16815550100'], balanceUsd: 2, limits: { maxConcurrentCalls: 2, maxCallDurationSeconds: 300 }, record: false });
    expect(ok.json.data.settings).toMatchObject({ maxDurationSeconds: 120, dailySpendCapUsd: 20, language: 'en-US', fromNumber: '+16815550100', maxAllowedSeconds: 600, minSeconds: 60 });
    expect(JSON.stringify(ok.json)).not.toContain('dialgood');
    const dialer = await t.request('/v1/workspace/dialer');
    expect(dialer.json.data).toMatchObject({ provider: 'dial', twilio: { status: 'disconnected' }, speko: { status: 'disconnected' }, dial: { status: 'connected' } });
    const bal = await t.request('/v1/workspace/telephony/dial/balance');
    expect(bal.json.data).toMatchObject({ provider: 'dial', connected: true, balanceUsd: 2, spentTodayUsd: 0, dailySpendCapUsd: 20 });
    const active = await t.request('/v1/workspace/dialer/balance');
    expect(active.json.data).toMatchObject({ provider: 'dial', connected: true, balanceUsd: 2 });
    const nums = await t.request('/v1/workspace/telephony/dial/numbers');
    expect(nums.json.data).toMatchObject([{ e164: '+16815550100', callingEnabled: true, isDefault: true }, { e164: '+16815550199', callingEnabled: false, isDefault: false }]);
  });
  it('clamps the duration floor to 60 and the ceiling to 600', async () => {
    const r = await t.request('/v1/workspace/telephony/dial', { method: 'PATCH', json: { data: { maxDurationSeconds: 5000, voice: 'male' } } });
    expect(r.json.data.settings).toMatchObject({ maxDurationSeconds: 600, voice: 'male' });
    await t.request('/v1/workspace/telephony/dial', { method: 'PATCH', json: { data: { maxDurationSeconds: 90, voice: null } } });
  });
});

describe('AI call lifecycle on Dial', () => {
  let callId: string;
  let taskId: string;
  it('places a call with one folded instruction, an idempotency key and the 60 s floor; a 2xx means queued', async () => {
    const task = await t.request('/v1/tasks', { method: 'POST', json: { data: { action: 'call', dueAt: DAY.toISOString(), ownerId: t.ownerId, prospectId, note: 'Intro call' } } });
    taskId = task.json.data.id;
    t.jobs.clear();
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { taskId, maxDurationSeconds: 30 } } });
    expect(r.status).toBe(202);
    expect(r.json.data).toMatchObject({ status: 'queued', maxDurationSeconds: 60, timezone: 'UTC', call: { status: 'queued', provider: 'dial', mode: 'ai', to: '+15550102020', from: '+16815550100', source: 'sequence', taskId, providerSessionId: 'call_1' } });
    callId = r.json.data.call.id;
    const { body, headers } = fake.placed.at(-1)!;
    expect(body).toMatchObject({ to: '+15550102020', fromNumber: '+16815550100', maxCallDurationSeconds: 60, language: 'en-US' });
    expect(body.outboundInstruction).toContain('VP Engineering at Globex');
    expect(body.outboundInstruction).toContain("Open the call with exactly this line, then listen: \"Hi Ada, this is Olive Owner's assistant at Acme. Do you have thirty seconds?\"");
    expect(body.outboundInstruction).not.toContain('{{');
    expect(body.systemPrompt).toBeUndefined();
    expect(headers['idempotency-key']).toBe(`cooks-${callId}`);
    expect(t.jobs.sent.map((j) => j.name)).toEqual(['telephony.ai_poll']);
  });
  it('polls to the end, stores outcome and transcript (no cost, no recording), logs the disposition and completes the task', async () => {
    let r = await pollAiCall(ctx(), callId, deps(), { attempt: 1 });
    expect(r).toMatchObject({ done: false, status: 'ringing' });
    r = await pollAiCall(ctx(), callId, deps(), { attempt: 2 });
    expect(r).toMatchObject({ done: false, status: 'in_progress' });
    t.jobs.clear();
    r = await pollAiCall(ctx(), callId, deps(), { attempt: 3 });
    expect(r).toMatchObject({ done: true, status: 'completed', outcome: 'answered' });
    const [c] = await t.db.select().from(calls).where(eq(calls.id, callId));
    expect(c).toMatchObject({ status: 'completed', outcome: 'answered', durationSeconds: 41, costUsd: null, summary: null, transcriptStatus: 'ready', coachingStatus: 'queued', recordingUrl: null, endReason: 'completed', provider: 'dial' });
    expect(c!.transcript).toHaveLength(2);
    expect(c!.loggedAt).toBeTruthy();
    const [tr] = await t.db.select().from(callTranscripts).where(eq(callTranscripts.callId, callId));
    expect(tr!.provider).toBe('dial');
    expect((tr!.segments as any[]).map((s) => s.speaker)).toEqual(['rep', 'prospect']);
    const [task] = await t.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.completed).toBe(true);
    expect(t.jobs.sent.map((j) => j.name)).toContain('ai.coach_call');
    const tx = await t.request(`/v1/calls/${callId}/transcript`);
    expect(tx.json.data).toMatchObject({ provider: 'dial', outcome: 'answered', costUsd: null, recordingUrl: null });
    expect(tx.json.data.transcript[1]).toMatchObject({ role: 'user', text: 'Sure, Thursday works.' });
    expect((await t.app.request(`/v1/calls/${callId}/recording`, { headers: { authorization: `Bearer ${t.token}` } })).status).toBe(404);
  });
  it('hangup stops the call and the next poll records it as canceled', async () => {
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId, firstMessage: 'Quick one, {{ prospect.firstName }}' } } });
    expect(r.status).toBe(202);
    expect(fake.placed.at(-1)!.body.outboundInstruction).toContain('Quick one, Ada');
    const id = r.json.data.call.id;
    const h = await t.request(`/v1/calls/${id}/actions/hangup`, { method: 'POST' });
    expect(h.json.data).toMatchObject({ ended: true });
    const done = await pollAiCall(ctx(), id, deps());
    expect(done).toMatchObject({ done: true, status: 'failed', outcome: 'failed' });
    const [c] = await t.db.select().from(calls).where(eq(calls.id, id));
    expect(c!.endReason).toBe('canceled');
  });
  it("a prospect's own call script beats the workspace default; an explicit script beats both", async () => {
    const cur = await t.request(`/v1/prospects/${prospectId}?includeCRMCustomFields=true`);
    const script = { firstMessage: 'Hi, is this {{ prospect.firstName }} at the flower shop?', systemPrompt: 'You are Sam, ordering a bouquet.' };
    await t.request(`/v1/prospects/${prospectId}`, { method: 'PATCH', json: { data: { crmCustomFields: { ...cur.json.data.crmCustomFields, aiCallScript: script } } } });
    expect((await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId } } })).status).toBe(202);
    const own = fake.placed.at(-1)!.body.outboundInstruction;
    expect(own).toContain('You are Sam, ordering a bouquet.');
    expect(own).toContain('Hi, is this Ada at the flower shop?');
    expect(own).not.toContain("Olive Owner's assistant");
    expect((await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId, firstMessage: 'Override line' } } })).status).toBe(202);
    const explicit = fake.placed.at(-1)!.body.outboundInstruction;
    expect(explicit).toContain('Override line');
    expect(explicit).toContain('You are Sam, ordering a bouquet.');
    await t.request(`/v1/prospects/${prospectId}`, { method: 'PATCH', json: { data: { crmCustomFields: cur.json.data.crmCustomFields } } });
  });
  it('surfaces Dial error codes with a rep-facing message and marks the call failed', async () => {
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { to: '+15550009999' } } });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/balance is too low/);
    expect(r.json.error.details).toMatchObject({ code: 'insufficient_credit', provider: 'dial' });
    const [failed] = await t.db.select().from(calls).where(eq(calls.toNumber, '+15550009999'));
    expect(failed).toMatchObject({ status: 'failed', provider: 'dial' });
    expect(failed!.notes).toMatch(/^Dial: /);
  });
  it('disconnecting Dial clears the dialer choice', async () => {
    expect((await t.request('/v1/workspace/telephony/dial', { method: 'DELETE' })).status).toBe(204);
    expect((await t.request('/v1/workspace/dialer')).json.data).toMatchObject({ provider: null, dial: { status: 'disconnected' } });
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId } } });
    expect(r.status).toBe(422);
    expect(r.json.error.details.code).toBe('NO_AI_DIALER');
  });
});
