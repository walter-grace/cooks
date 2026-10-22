import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { callTranscripts, calls, outboxEvents, prospects, tasks } from '@cooks/db';
import { fillScript, pollAiCall, spekoCallState, systemPrincipal, verifyStandardWebhook, withinCallHours, type Ctx } from '@cooks/core';
import { createHmac } from 'node:crypto';
import { createTestApp, type TestApp } from './test/harness.js';

/** In-memory Speko + Twilio. Speko sessions advance one state per GET: dialing → active → ended. */
function fakeProviders() {
  const placed: Array<Record<string, any>> = [];
  const sessions = new Map<string, { gets: number; ended: boolean; to: string }>();
  let n = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.authorization ?? '';
    if (url.hostname === 'speko.test') {
      if (url.pathname.startsWith('/rec/')) return new Response(new Uint8Array([7, 7, 7]), { headers: { 'content-type': 'audio/mpeg' } });
      if (auth !== 'Bearer sk_live_goodkey1') return Response.json({ error: 'authentication_failed', code: 'UNAUTHORIZED' }, { status: 401 });
      const m = init?.method ?? 'GET';
      if (url.pathname === '/v1/credits/balance') return Response.json({ balanceUsd: 42.5, currency: 'USD', updatedAt: '2026-03-01T00:00:00Z' });
      if (url.pathname === '/v1/phone-numbers' && m === 'GET') return Response.json([{ id: 'pn1', e164: '+15550001111', label: 'Main', direction: 'both', source: 'managed', setupStatus: { status: 'ready', outboundReady: true, issues: [] } }]);
      if (url.pathname === '/v1/phone-numbers/available') return Response.json([{ e164: '+14155550100', friendlyName: '(415) 555-0100', monthlyCostUsd: 2, upfrontCostUsd: 1, aboveStandardPrice: false, features: ['voice'], region: 'CA' }]);
      if (url.pathname === '/v1/phone-numbers' && m === 'POST') {
        const b = JSON.parse(String(init?.body));
        return Response.json({ id: 'pn2', e164: b.e164, label: b.label, direction: 'both', source: 'managed', setupStatus: { status: 'ready', outboundReady: true, issues: [] } });
      }
      if (url.pathname === '/v1/sessions/phone') {
        const b = JSON.parse(String(init?.body));
        placed.push(b);
        if (b.to === '+15550009999') return Response.json({ error: 'This needs at least $5.00 available', code: 'INSUFFICIENT_CREDITS', requiredUsd: 5, availableUsd: 1 }, { status: 402 });
        const id = `sess_${++n}`;
        sessions.set(id, { gets: 0, ended: false, to: b.to });
        return Response.json({ sessionId: id, callControlId: `cc_${n}`, roomName: `room_${n}`, status: 'dialing', to: b.to, from: b.from });
      }
      const call = /^\/v1\/calls\/([^/]+)(\/.*)?$/.exec(url.pathname);
      if (call) {
        const s = sessions.get(call[1]!);
        if (!s) return Response.json({ error: 'not found', code: 'SESSION_NOT_FOUND' }, { status: 404 });
        if (call[2] === '/end') {
          s.ended = true;
          return Response.json({ ok: true, status: 'ending' }, { status: 202 });
        }
        if (call[2] === '/recording') return Response.json({ url: `http://speko.test/rec/${call[1]}.mp3` });
        s.gets += 1;
        if (s.ended || s.gets >= 3)
          return Response.json({
            id: call[1],
            call_id: call[1],
            status: 'ended',
            kind: 'phone',
            created_at: '2026-03-03T15:00:05Z',
            ended_at: '2026-03-03T15:01:08Z',
            duration_seconds: 63,
            recording_status: 'ready',
            report: {
              session_id: call[1],
              summary: 'Ada agreed to a demo on Thursday at 10.',
              outcome: 'scheduled',
              contact: 'connected',
              transcript: { entries: [{ id: 't1', index: 0, source: 'agent', text: 'Hi Ada, this is Olive Owner\'s assistant at Acme.', started_at: '2026-03-03T15:00:10Z', ended_at: '2026-03-03T15:00:14Z', metadata: {} }, { id: 't2', index: 1, source: 'user', text: 'Sure, Thursday works.', started_at: '2026-03-03T15:00:15Z', ended_at: '2026-03-03T15:00:17Z', metadata: {} }] },
              cost_micro_usd: '210000',
              voicemail: { detected: false, amd_verdict: 'human', delivery: null },
              analysis_status: 'completed',
              webhook_deliveries: [],
            },
          });
        return Response.json({ id: call[1], call_id: call[1], status: s.gets === 1 ? 'dialing' : 'active', kind: 'phone', created_at: '2026-03-03T15:00:05Z' });
      }
      return Response.json({ error: `unhandled ${url.pathname}`, code: 'NOT_FOUND' }, { status: 404 });
    }
    // Twilio (just enough to connect)
    const basic = Buffer.from(auth.replace('Basic ', ''), 'base64').toString();
    if (!basic.endsWith(':good-token')) return Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 });
    if (/\/Accounts\/AC[a-z0-9]+\.json$/.test(url.pathname)) return Response.json({ sid: 'ACtest', friendly_name: 'QA', status: 'active' });
    if (url.pathname.endsWith('/IncomingPhoneNumbers.json')) return Response.json({ incoming_phone_numbers: [{ phone_number: '+15550002222' }] });
    return Response.json({ message: `unhandled ${url.pathname}` }, { status: 404 });
  };
  return { fetchImpl, placed, sessions };
}

let t: TestApp;
const fake = fakeProviders();
let prospectId: string;
const DAY = new Date('2026-03-03T15:00:00Z'); // 15:00 UTC, inside calling hours for the UTC prospect
const deps = () => ({ kek: t.kek, fetchImpl: fake.fetchImpl, speko: { apiBase: 'http://speko.test' }, publicUrl: 'http://localhost' });
const ctx = (): Ctx => ({ db: t.db, principal: systemPrincipal(t.workspaceId), jobs: t.jobs, clock: t.clock, traceId: 'test', publicUrl: 'http://localhost' });

beforeAll(async () => {
  t = await createTestApp({ fetchImpl: fake.fetchImpl, telephony: { trustWebhookSignature: false, speko: { apiBase: 'http://speko.test' } } });
  t.clock.set(DAY);
  const acc = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex', domain: 'globex.test' } } });
  const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', title: 'VP Engineering', primaryEmail: 'ada@globex.test', phone: '(555) 010-2020', timezone: 'UTC', account: { id: acc.json.data.id } } } });
  prospectId = p.json.data.id;
});
afterAll(() => t.close());

describe('pure helpers', () => {
  it('calling hours follow the prospect zone', () => {
    expect(withinCallHours(new Date('2026-03-03T15:00:00Z'), 'UTC')).toBe(true);
    expect(withinCallHours(new Date('2026-03-03T03:00:00Z'), 'UTC')).toBe(false);
    expect(withinCallHours(new Date('2026-03-03T03:00:00Z'), 'America/Los_Angeles')).toBe(true); // 19:00 PST
    expect(withinCallHours(new Date('2026-03-03T13:00:00Z'), 'Asia/Tokyo')).toBe(false); // 22:00 JST
  });
  it('fills script variables and blanks unknown ones', () => {
    expect(fillScript('Hi {{ prospect.firstName }} from {{ workspace.name }}{{ nope }}!', { 'prospect.firstName': 'Ada', 'workspace.name': 'Acme' })).toBe('Hi Ada from Acme!');
  });
  it('maps Speko call detail onto outcomes', () => {
    expect(spekoCallState({ status: 'dialing' })).toMatchObject({ status: 'ringing', outcome: null });
    expect(spekoCallState({ status: 'active' })).toMatchObject({ status: 'in_progress' });
    expect(spekoCallState({ status: 'ended', ended_at: 'x', report: { contact: 'connected', cost_micro_usd: '150000', transcript: { entries: [] } } })).toMatchObject({ status: 'ended', outcome: 'answered', costUsd: 0.15 });
    expect(spekoCallState({ status: 'ended', ended_at: 'x', report: { contact: 'connected', voicemail: { detected: true }, transcript: { entries: [] } } }).outcome).toBe('voicemail');
    expect(spekoCallState({ status: 'ended', ended_at: 'x', report: { contact: 'no_answer', transcript: { entries: [] } } }).outcome).toBe('no_answer');
    expect(spekoCallState({ status: 'ended', ended_at: 'x', report: { contact: 'not_connected', transcript: { entries: [] } } }).outcome).toBe('failed');
  });
  it('verifies Standard Webhooks signatures', () => {
    const secret = 'whsec_' + Buffer.from('top-secret').toString('base64');
    const body = '{"type":"call.status"}';
    const ts = String(Math.floor(DAY.getTime() / 1000));
    const sig = 'v1,' + createHmac('sha256', Buffer.from('top-secret')).update(`msg_1.${ts}.${body}`).digest('base64');
    expect(verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: sig }, body, DAY)).toBe(true);
    expect(verifyStandardWebhook(secret, { id: 'msg_1', timestamp: ts, signature: 'v1,AAAA' }, body, DAY)).toBe(false);
    expect(verifyStandardWebhook(secret, { id: 'msg_1', timestamp: String(Number(ts) - 900), signature: sig }, body, DAY)).toBe(false);
  });
});

describe('connect Speko', () => {
  it('rejects a bad key, stores a good one encrypted, discovers numbers, becomes the dialer', async () => {
    const bad = await t.request('/v1/workspace/telephony/speko', { method: 'PUT', json: { data: { apiKey: 'sk_live_badkey' } } });
    expect(bad.status).toBe(422);
    const ok = await t.request('/v1/workspace/telephony/speko', { method: 'PUT', json: { data: { apiKey: 'sk_live_goodkey1' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ status: 'connected', keySource: 'workspace', keyLast4: 'key1', fromNumbers: ['+15550001111'], balanceUsd: 42.5 });
    expect(ok.json.data.settings).toMatchObject({ maxDurationSeconds: 120, dailySpendCapUsd: 20, language: 'en-US', fromNumber: '+15550001111', maxAllowedSeconds: 600 });
    expect(JSON.stringify(ok.json)).not.toContain('goodkey1');
    const dialer = await t.request('/v1/workspace/dialer');
    expect(dialer.json.data).toMatchObject({ provider: 'speko', twilio: { status: 'disconnected' }, speko: { status: 'connected' } });
    const bal = await t.request('/v1/workspace/telephony/speko/balance');
    expect(bal.json.data).toMatchObject({ connected: true, balanceUsd: 42.5, spentTodayUsd: 0, dailySpendCapUsd: 20 });
  });
  it('the Twilio connection can coexist and the admin picks which one the Call button uses', async () => {
    const tw = await t.request('/v1/workspace/telephony', { method: 'PUT', json: { data: { accountSid: 'ACabcdef1234567890', authToken: 'good-token' } } });
    expect(tw.status).toBe(200);
    expect((await t.request('/v1/workspace/dialer')).json.data.provider).toBe('speko'); // first connection keeps the choice
    const pick = await t.request('/v1/workspace/dialer/provider', { method: 'PUT', json: { data: { provider: 'twilio' } } });
    expect(pick.status).toBe(200);
    expect((await t.request('/v1/workspace/dialer')).json.data).toMatchObject({ provider: 'twilio', twilio: { status: 'connected', fromNumbers: ['+15550002222'] } });
    await t.request('/v1/workspace/dialer/provider', { method: 'PUT', json: { data: { provider: 'speko' } } });
  });
});

describe('AI call lifecycle', () => {
  let callId: string;
  let taskId: string;
  it('places a call with the merged script, caps and metadata; a 2xx means queued', async () => {
    const task = await t.request('/v1/tasks', { method: 'POST', json: { data: { action: 'call', dueAt: DAY.toISOString(), ownerId: t.ownerId, prospectId, note: 'Intro call' } } });
    taskId = task.json.data.id;
    t.jobs.clear();
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { taskId, maxDurationSeconds: 900 } } });
    expect(r.status).toBe(202);
    expect(r.json.data).toMatchObject({ status: 'queued', maxDurationSeconds: 600, timezone: 'UTC', call: { status: 'queued', provider: 'speko', mode: 'ai', to: '+15550102020', from: '+15550001111', source: 'sequence', taskId, providerSessionId: 'sess_1' } });
    callId = r.json.data.call.id;
    const body = fake.placed.at(-1)!;
    expect(body).toMatchObject({ to: '+15550102020', from: '+15550001111', intent: { language: 'en-US', optimizeFor: 'balanced' }, maxDurationSeconds: 600, telephony: { amd: { mode: 'agent' } }, turnHandling: { onMachine: 'leave_message' }, metadata: { cooksCallId: callId, prospectId } });
    expect(body.firstMessage).toBe("Hi Ada, this is Olive Owner's assistant at Acme. Do you have thirty seconds?");
    expect(body.systemPrompt).toContain('VP Engineering at Globex');
    expect(body.systemPrompt).not.toContain('{{');
    expect(t.jobs.sent.map((j) => j.name)).toEqual(['telephony.ai_poll']);
  });
  it('polls until the call ends, then stores outcome, transcript, cost and recording, logs the disposition and completes the task', async () => {
    let r = await pollAiCall(ctx(), callId, deps(), { attempt: 1 });
    expect(r).toMatchObject({ done: false, status: 'ringing' });
    r = await pollAiCall(ctx(), callId, deps(), { attempt: 2 });
    expect(r).toMatchObject({ done: false, status: 'in_progress' });
    t.jobs.clear();
    r = await pollAiCall(ctx(), callId, deps(), { attempt: 3 });
    expect(r).toMatchObject({ done: true, status: 'completed', outcome: 'answered' });
    const [c] = await t.db.select().from(calls).where(eq(calls.id, callId));
    expect(c).toMatchObject({ status: 'completed', outcome: 'answered', durationSeconds: 63, costUsd: '0.2100', summary: 'Ada agreed to a demo on Thursday at 10.', transcriptStatus: 'ready', coachingStatus: 'queued', recordingUrl: `http://localhost/v1/calls/${callId}/recording` });
    expect(c!.transcript).toHaveLength(2);
    expect(c!.loggedAt).toBeTruthy();
    const [tr] = await t.db.select().from(callTranscripts).where(eq(callTranscripts.callId, callId));
    expect((tr!.segments as any[]).map((s) => s.speaker)).toEqual(['rep', 'prospect']);
    expect(tr!.stats).toMatchObject({ talkRatio: 0.67, repQuestions: 0, switches: 1, stereo: true });
    const [task] = await t.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.completed).toBe(true);
    const evs = (await t.db.select().from(outboxEvents)).map((e) => e.eventType);
    expect(evs).toEqual(expect.arrayContaining(['call.started', 'call.completed', 'call.logged']));
    expect(t.jobs.sent.map((j) => j.name)).toContain('ai.coach_call');
    const api = await t.request(`/v1/calls/${callId}?include=callDisposition`);
    expect(api.json.data).toMatchObject({ outcome: 'answered', costUsd: 0.21, callDisposition: { callOutcome: 'connected' } });
    const tx = await t.request(`/v1/calls/${callId}/transcript`);
    expect(tx.json.data).toMatchObject({ outcome: 'answered', summary: 'Ada agreed to a demo on Thursday at 10.' });
    expect(tx.json.data.transcript[1]).toMatchObject({ role: 'user', text: 'Sure, Thursday works.' });
    const rec = await t.app.request(`/v1/calls/${callId}/recording`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(rec.status).toBe(200);
    expect(rec.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await rec.arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
    // polling a finished call is a no-op
    expect((await pollAiCall(ctx(), callId, deps())).done).toBe(true);
  });
  it('hangup ends a running call and the next poll finalizes it', async () => {
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId, firstMessage: 'Quick one, {{ prospect.firstName }}' } } });
    expect(r.status).toBe(202);
    expect(fake.placed.at(-1)!.firstMessage).toBe('Quick one, Ada');
    const id = r.json.data.call.id;
    const h = await t.request(`/v1/calls/${id}/actions/hangup`, { method: 'POST' });
    expect(h.json.data).toMatchObject({ ended: true });
    expect((await pollAiCall(ctx(), id, deps())).done).toBe(true);
  });
  it('a Speko webhook for a known session just triggers a poll', async () => {
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId } } });
    const sess = r.json.data.call.providerSessionId;
    t.jobs.clear();
    const wh = await t.app.request(`/telephony/speko/webhook?ws=${t.workspaceId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call.status', call_id: sess, status: 'ended' }) });
    expect(wh.status).toBe(200);
    expect(await wh.json()).toMatchObject({ queued: true });
    expect(t.jobs.sent.at(-1)!.name).toBe('telephony.ai_poll');
    const unknown = await t.app.request(`/telephony/speko/webhook?ws=${t.workspaceId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'call.status', call_id: 'nope' }) });
    expect(await unknown.json()).toMatchObject({ ignored: 'unknown session' });
    expect((await t.app.request(`/telephony/speko/webhook?ws=00000000-0000-0000-0000-000000000000`, { method: 'POST', body: '{}' })).status).toBe(403);
  });
});

describe('safety', () => {
  it('refuses outside 08:00–21:00 local time with the next window', async () => {
    t.clock.set(new Date('2026-03-03T03:00:00Z'));
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId } } });
    expect(r.status).toBe(422);
    expect(r.json.error.details).toMatchObject({ code: 'QUIET_HOURS', timezone: 'UTC', nextWindowAt: '2026-03-03T08:00:00.000Z' });
    await t.db.update(prospects).set({ timezone: 'America/Los_Angeles' }).where(eq(prospects.id, prospectId)); // 19:00 local → allowed
    const ok = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId } } });
    expect(ok.status).toBe(202);
    expect(ok.json.data.timezone).toBe('America/Los_Angeles');
    await t.db.update(prospects).set({ timezone: 'UTC' }).where(eq(prospects.id, prospectId));
    t.clock.set(DAY);
  });
  it('refuses do-not-contact prospects and prospects with a do-not-call disposition', async () => {
    await t.db.update(prospects).set({ doNotContact: true }).where(eq(prospects.id, prospectId));
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId } } });
    expect(r.status).toBe(422);
    expect(r.json.error.details.code).toBe('DO_NOT_CALL');
    await t.db.update(prospects).set({ doNotContact: false }).where(eq(prospects.id, prospectId));
    const logged = await t.request('/v1/calls', { method: 'POST', json: { data: { prospectId, outcome: 'do_not_call', durationSeconds: 10 } } });
    expect(logged.status).toBe(201);
    const again = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId } } });
    expect(again.json.error.details.code).toBe('DO_NOT_CALL');
    await t.db.delete(calls).where(and(eq(calls.id, logged.json.data.id)));
  });
  it('enforces the daily spend cap and the hard duration ceiling', async () => {
    const low = await t.request('/v1/workspace/telephony/speko', { method: 'PATCH', json: { data: { dailySpendCapUsd: 0.1 } } });
    expect(low.json.data.settings.dailySpendCapUsd).toBe(0.1);
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId } } });
    expect(r.status).toBe(422);
    expect(r.json.error.details.code).toBe('SPEND_CAP');
    expect(r.json.error.message).toMatch(/budget/);
    const back = await t.request('/v1/workspace/telephony/speko', { method: 'PATCH', json: { data: { dailySpendCapUsd: 50, maxDurationSeconds: 5000 } } });
    expect(back.json.data.settings.maxDurationSeconds).toBe(600);
  });
  it('surfaces Speko error codes with a rep-facing message and marks the call failed', async () => {
    const r = await t.request('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { to: '+15550009999' } } });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/balance is too low/);
    expect(r.json.error.details).toMatchObject({ code: 'INSUFFICIENT_CREDITS', provider: 'speko', requiredUsd: 5, availableUsd: 1 });
    const failed = await t.db.select().from(calls).where(and(eq(calls.toNumber, '+15550009999'), eq(calls.status, 'failed')));
    expect(failed).toHaveLength(1);
    expect(failed[0]!.notes).toMatch(/balance is too low/);
  });
});

describe('numbers', () => {
  it('lists, searches with prices, and buys only with an explicit confirm', async () => {
    const list = await t.request('/v1/workspace/telephony/speko/numbers');
    expect(list.json.data[0]).toMatchObject({ e164: '+15550001111', status: 'ready', outboundReady: true, isDefault: true });
    const avail = await t.request('/v1/workspace/telephony/speko/numbers/available?areaCode=415');
    expect(avail.json.data[0]).toMatchObject({ e164: '+14155550100', monthlyCostUsd: 2, upfrontCostUsd: 1 });
    const noConfirm = await t.request('/v1/workspace/telephony/speko/numbers', { method: 'POST', json: { data: { e164: '+14155550100' } } });
    expect(noConfirm.status).toBe(422);
    expect(noConfirm.json.error.details.code).toBe('CONFIRM_REQUIRED');
    const bought = await t.request('/v1/workspace/telephony/speko/numbers', { method: 'POST', json: { data: { e164: '+14155550100', confirm: true, expectedUpfrontCostUsd: 1, expectedMonthlyCostUsd: 2 } } });
    expect(bought.status).toBe(201);
    expect(bought.json.data).toMatchObject({ e164: '+14155550100', status: 'ready' });
    expect((await t.request('/v1/workspace/dialer')).json.data.speko.fromNumbers).toContain('+14155550100');
  });
  it('disconnecting Speko falls back to Twilio as the dialer', async () => {
    expect((await t.request('/v1/workspace/telephony/speko', { method: 'DELETE' })).status).toBe(204);
    expect((await t.request('/v1/workspace/dialer')).json.data).toMatchObject({ provider: 'twilio', speko: { status: 'disconnected' } });
  });
});
