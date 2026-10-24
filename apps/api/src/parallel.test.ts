import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { calls, dialEvents, dialLines, dialSessions, outboxEvents, prospects, tasks } from '@cooks/db';
import { conferenceTwiml, createGateSocket, mintStreamToken, pauseTwiml, pcm16ToMulaw, twilioSignature } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

/**
 * In-memory Twilio for the parallel dialer. Records every REST call so tests can assert what the
 * carrier was told: Calls.json (dial), Calls/{sid}.json (redirect / cancel / complete),
 * Calls/{sid}/Recordings.json (start / stop), Conferences/{sid}.json (end).
 */
function fakeTwilio() {
  const created: Array<Record<string, string> & { sid: string }> = [];
  const updates: Array<{ sid: string; params: Record<string, string> }> = [];
  const recordings: Array<{ callSid: string; params: Record<string, string>; path: string }> = [];
  const conferences: Array<{ sid: string; params: Record<string, string> }> = [];
  /** SIDs that should 404 on update (already ended on the carrier side). */
  const gone = new Set<string>();
  let seq = 0;
  /** Jev (OpenRouter decisions) requests, answered with `jevAnswer`. */
  const jev: Array<Record<string, unknown>> = [];
  const state = { jevAnswer: 'human' as 'human' | 'voicemail' | 'ivr' | 'unclear' };
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'openrouter.ai') {
      jev.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ model: 'typesafe/jev-1.14', answers: { answered_by: { type: 'choice', choice: state.jevAnswer, confidence: 0.88, probabilities: { [state.jevAnswer]: 0.88 } } }, usage: { input_tokens: 420, output_tokens: 8, cost: 0.00002 } });
    }
    const auth = Buffer.from(((init?.headers as Record<string, string>)?.authorization ?? '').replace('Basic ', ''), 'base64').toString();
    if (!auth.endsWith(':good-token')) return Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 });
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    if (/\/Accounts\/AC[a-z0-9]+\.json$/.test(url.pathname)) return Response.json({ sid: 'ACtest', friendly_name: 'Cooks QA', status: 'active' });
    if (url.pathname.endsWith('/IncomingPhoneNumbers.json')) return Response.json({ incoming_phone_numbers: [{ phone_number: '+15550001111' }] });
    if (url.pathname.endsWith('/Calls.json')) {
      const sid = `CA${String(++seq).padStart(3, '0')}`;
      created.push({ ...body, sid });
      return Response.json({ sid, status: 'queued' }, { status: 201 });
    }
    let m = /\/Calls\/(CA\w+)\/Recordings(?:\/([\w.]+))?\.json$/.exec(url.pathname);
    if (m) {
      recordings.push({ callSid: m[1]!, params: body, path: m[2] ?? 'new' });
      return Response.json({ sid: `RE${recordings.length}`, status: body.Status ?? 'in-progress' }, { status: 201 });
    }
    m = /\/Calls\/(CA\w+)\.json$/.exec(url.pathname);
    if (m) {
      updates.push({ sid: m[1]!, params: body });
      if (gone.has(m[1]!)) return Response.json({ code: 20404, message: 'not found' }, { status: 404 });
      return Response.json({ sid: m[1], status: body.Status ?? 'in-progress' });
    }
    m = /\/Conferences\/(CF\w+)\.json$/.exec(url.pathname);
    if (m) {
      conferences.push({ sid: m[1]!, params: body });
      return Response.json({ sid: m[1], status: 'completed' });
    }
    return Response.json({ message: `unhandled ${url.pathname}` }, { status: 404 });
  };
  return { fetchImpl, created, updates, recordings, conferences, gone, jev, state, reset: () => (created.length = updates.length = recordings.length = conferences.length = jev.length = 0) };
}

let t: TestApp;
const tw = fakeTwilio();
const ids: Record<string, string> = {} as Record<string, string>;
const form = (path: string, params: Record<string, string>) => t.app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });
const session = async (id: string) => (await t.request(`/v1/dialSessions/${id}`)).json.data;
const lineBy = (s: any, pid: string | undefined, batch?: number) => s.lines.find((l: any) => l.prospect?.id === pid && (batch === undefined || l.batch === batch));
const sidOf = async (lineId: string) => (await t.db.select().from(dialLines).where(eq(dialLines.id, lineId)))[0]!.providerCallSid!;
const webhook = (kind: string, sid: string, lineId: string) => `/telephony/parallel/prospect/${kind}?ws=${t.workspaceId}&session=${sid}&line=${lineId}`;

beforeAll(async () => {
  t = await createTestApp({ fetchImpl: tw.fetchImpl, telephony: { trustWebhookSignature: false, speech: { provider: 'mock', jev: { apiKey: 'or-test-key' } } } });
  t.clock.set(new Date('2026-03-03T16:00:00Z')); // 11:00 New York, inside calling hours everywhere in the US
  const acc = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex', domain: 'globex.test' } } });
  const mk = async (first: string, phone: string | null, extra: Record<string, unknown> = {}) => {
    const r = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: first, lastName: 'Test', primaryEmail: `${first.toLowerCase()}@globex.test`, phone, timezone: 'America/New_York', account: { id: acc.json.data.id }, ...extra } } });
    return r.json.data.id as string;
  };
  ids.ada = await mk('Ada', '+15550100001');
  ids.bob = await mk('Bob', '+15550100002');
  ids.cy = await mk('Cy', '+15550100003');
  ids.dee = await mk('Dee', '+15550100004');
  ids.eve = await mk('Eve', '+15550100005');
  ids.fay = await mk('Fay', '+15550100006');
  ids.gus = await mk('Gus', null);
  ids.dnc = await mk('Dan', '+15550100009');
  await t.db.update(prospects).set({ doNotContact: true }).where(eq(prospects.id, ids.dnc));
  await t.request('/v1/workspace/telephony', { method: 'PUT', json: { data: { accountSid: 'ACabcdef1234567890', authToken: 'good-token', apiKeySid: 'SKabc', apiKeySecret: 'sk-secret-value', twimlAppSid: 'APabc' } } });
});
afterAll(() => t.close());

describe('twiml', () => {
  it('conference TwiML has no beep, no hold music; rep starts and ends the room, prospects never do', () => {
    const rep = conferenceTwiml({ name: 'cooks-1', role: 'rep', statusCallback: 'http://x/c?a=1&b=2', label: 'rep' });
    expect(rep).toContain('<Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="" statusCallback="http://x/c?a=1&amp;b=2" statusCallbackMethod="POST" statusCallbackEvent="start end join leave" participantLabel="rep">cooks-1</Conference>');
    const p = conferenceTwiml({ name: 'cooks-1', role: 'prospect' });
    expect(p).toContain('startConferenceOnEnter="false" endConferenceOnExit="false"');
    expect(p).not.toContain('<Say');
    expect(pauseTwiml(15)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="15"/><Hangup/></Response>');
  });
});

describe('compliance gate', () => {
  it('refuses to start until an admin confirms a mode; non-admins cannot confirm', async () => {
    const r = await t.request('/v1/dialSessions', { method: 'POST', json: { data: { repMode: 'browser' } } });
    expect(r.status).toBe(422);
    expect(r.json.error.details.code).toBe('COMPLIANCE_UNCONFIRMED');
    const login = await t.request('/auth/login', { token: null, method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: 'rep@acme.test', password: t.password }).toString() });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const repTok = (await t.request('/auth/session-token', { token: null, method: 'POST', json: {}, headers: { cookie } })).json.access_token as string;
    const asRep = await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', token: repTok, json: { data: { complianceMode: 'b2b', confirm: true } } });
    expect(asRep.status).toBe(403);
    const consumerNoMsg = await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { complianceMode: 'consumer', confirm: true } } });
    expect(consumerNoMsg.status).toBe(422);
    expect(consumerNoMsg.json.error.details.code).toBe('ABANDON_MESSAGE_REQUIRED');
    const ok = await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { complianceMode: 'b2b', confirm: true, maxLines: 3 } } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ complianceMode: 'b2b', confirmed: true, confirmedBy: 'api-key', maxLines: 3, maxAllowedLines: 6, onUnknown: 'hangup' });
    const get = await t.request('/v1/workspace/dialer/compliance');
    expect(get.json.data.abandonment).toMatchObject({ windowDays: 30, humansAnswered: 0, dropped: 0, ratePct: null, safeHarborMaxPct: 3 });
  });
});

describe('phone-mode rep, consumer compliance, abandonment', () => {
  let sid: string;
  it('consumer mode needs the message, caps at two lines, and plays the message to a dropped human', async () => {
    const set = await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { complianceMode: 'consumer', abandonedCallMessage: 'This was Acme calling. Reach us at 555 000 1111.', confirm: true, maxLines: 5 } } });
    expect(set.status).toBe(200);
    expect(set.json.data).toMatchObject({ complianceMode: 'consumer', confirmed: true, maxLines: 2, maxAllowedLines: 2 });
    tw.reset();
    const r = await t.request('/v1/dialSessions', { method: 'POST', json: { data: { repMode: 'phone', repPhone: '555 999 8888', maxLines: 4, prospectIds: [ids.ada, ids.bob, ids.cy] } } });
    expect(r.status).toBe(201);
    sid = r.json.data.id;
    expect(r.json.data).toMatchObject({ status: 'waiting_rep', repMode: 'phone', repPhone: '+15559998888', maxLines: 2, complianceMode: 'consumer' });
    expect(r.json.data.connectParams).toBeUndefined();
    // rep leg was dialed first
    expect(tw.created).toHaveLength(1);
    expect(tw.created[0]).toMatchObject({ To: '+15559998888', From: '+15550001111' });
    expect(tw.created[0]!.Url).toBe(`http://localhost/telephony/parallel/rep/voice?ws=${t.workspaceId}&session=${sid}`);
    expect(tw.created[0]!.MachineDetection).toBeUndefined();
    ids.repSid = tw.created[0]!.sid;
    const voice = await form(`/telephony/parallel/rep/voice?ws=${t.workspaceId}&session=${sid}`, { CallSid: ids.repSid, CallStatus: 'in-progress' });
    expect(await voice.text()).toContain(`participantLabel="rep">cooks-${sid}</Conference>`);
    expect((await session(sid)).status).toBe('ready');
    tw.reset();
    const d = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    expect(d.json.data.lines.filter((l: any) => l.status === 'dialing')).toHaveLength(2);
    const ada = lineBy(d.json.data, ids.ada, 1);
    const bob = lineBy(d.json.data, ids.bob, 1);
    const [adaSid, bobSid] = await Promise.all([sidOf(ada.id), sidOf(bob.id)]);
    await form(webhook('voice', sid, bob.id), { CallSid: bobSid, CallStatus: 'in-progress' });
    await form(webhook('amd', sid, ada.id), { CallSid: adaSid, AnsweredBy: 'human' });
    // Bob had already picked up when Ada won: he stays on silent hold until his verdict, nothing is sent to his leg yet.
    expect(tw.updates.filter((u) => u.sid === bobSid)).toHaveLength(0);
    expect(lineBy(await session(sid), ids.bob, 1).status).toBe('answered');
    // ...a person: he hears the notice, is hung up, and gets a callback task.
    await form(webhook('amd', sid, bob.id), { CallSid: bobSid, AnsweredBy: 'human' });
    const drop = tw.updates.find((u) => u.sid === bobSid)!;
    expect(drop.params.Twiml).toContain('<Say>This was Acme calling. Reach us at 555 000 1111.</Say><Hangup/>');
    const mid = await session(sid);
    expect(lineBy(mid, ids.bob, 1)).toMatchObject({ status: 'dropped', endReason: 'second_human' });
    expect(lineBy(mid, ids.bob, 1).callbackTaskId).toBeTruthy();
    const stats = (await t.request('/v1/workspace/dialer/compliance')).json.data.abandonment;
    expect(stats).toMatchObject({ humansAnswered: 2, dropped: 1, ratePct: 50 });
  });
  it('at or above the 3% safe harbor, consumer sessions fall back to one line per batch', async () => {
    const s = await session(sid);
    const ada = lineBy(s, ids.ada, 1);
    await form(webhook('status', sid, ada.id), { CallSid: await sidOf(ada.id), CallStatus: 'completed', CallDuration: '30' });
    expect((await session(sid)).status).toBe('wrapping');
    tw.reset();
    const d = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    expect(d.status).toBe(200);
    expect(d.json.data.lines.filter((l: any) => l.batch === 2)).toHaveLength(1);
    expect(tw.created).toHaveLength(1);
  });
  it('the rep hanging up their phone ends the session', async () => {
    tw.reset();
    await form(`/telephony/parallel/rep/status?ws=${t.workspaceId}&session=${sid}`, { CallSid: ids.repSid!, CallStatus: 'completed', CallDuration: '400' });
    const s = await session(sid);
    expect(s).toMatchObject({ status: 'ended', endReason: 'rep_left' });
    expect(lineBy(s, ids.cy, 2).status).toBe('canceled');
    // no conference sid was learned (no conference callbacks in this flow), so the rep leg is hung up directly
    expect(tw.updates.find((u) => u.sid === ids.repSid)?.params).toEqual({ Status: 'completed' });
    const replay = await form(`/telephony/parallel/rep/status?ws=${t.workspaceId}&session=${sid}`, { CallSid: ids.repSid!, CallStatus: 'completed', CallDuration: '400' });
    expect(replay.status).toBe(204);
  });
});

describe('session lifecycle: browser rep, three lines, first human wins', () => {
  let sid: string;
  it('starts in browser mode with connectParams, queues and preflights prospects', async () => {
    await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { complianceMode: 'b2b', confirm: true, maxLines: 3 } } });
    const r = await t.request('/v1/dialSessions', { method: 'POST', json: { data: { repMode: 'browser', prospectIds: [ids.ada, ids.bob, ids.cy, ids.gus, ids.dnc] } } });
    expect(r.status).toBe(201);
    sid = r.json.data.id;
    expect(r.json.data).toMatchObject({ status: 'waiting_rep', repMode: 'browser', fromNumber: '+15550001111', maxLines: 3, complianceMode: 'b2b', connectParams: { kind: 'parallel', sessionId: sid, ws: t.workspaceId } });
    expect(r.json.data.conferenceName).toBe(`cooks-${sid}`);
    const byP: Record<string, any> = Object.fromEntries(r.json.data.lines.map((l: any) => [l.prospect.id, l]));
    expect(byP[ids.ada!].status).toBe('queued');
    expect(byP[ids.gus!]).toMatchObject({ status: 'skipped', skipReason: 'no_phone' });
    expect(byP[ids.dnc!]).toMatchObject({ status: 'skipped', skipReason: 'do_not_call' });
    expect(r.json.data.stats).toMatchObject({ queued: 3, skipped: 2 });
    const dup = await t.request('/v1/dialSessions', { method: 'POST', json: { data: { repMode: 'browser' } } });
    expect(dup.status).toBe(409);
  });
  it('refuses to dial before the rep is in the room; the browser leg joins through the TwiML App voice URL', async () => {
    const early = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    expect(early.status).toBe(422);
    expect(early.json.error.details.code).toBe('REP_NOT_JOINED');
    const res = await form(`/telephony/voice?ws=${t.workspaceId}`, { CallSid: 'CArep', kind: 'parallel', sessionId: sid });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain(`participantLabel="rep">cooks-${sid}</Conference>`);
    expect(xml).toContain('beep="false"');
    expect(xml).toContain(`statusCallback="http://localhost/telephony/parallel/conference?ws=${t.workspaceId}&amp;session=${sid}"`);
    await form(`/telephony/parallel/conference?ws=${t.workspaceId}&session=${sid}`, { ConferenceSid: 'CF1', FriendlyName: `cooks-${sid}`, StatusCallbackEvent: 'conference-start', SequenceNumber: '1' });
    await form(`/telephony/parallel/conference?ws=${t.workspaceId}&session=${sid}`, { ConferenceSid: 'CF1', CallSid: 'CArep', ParticipantLabel: 'rep', StatusCallbackEvent: 'participant-join', SequenceNumber: '2' });
    const s = await session(sid);
    expect(s.status).toBe('ready');
    expect(s.repJoinedAt).toBeTruthy();
    const [row] = await t.db.select().from(dialSessions).where(eq(dialSessions.id, sid));
    expect(row).toMatchObject({ repCallSid: 'CArep', conferenceSid: 'CF1' });
  });
  it('dials a batch of three with async AMD and the right callbacks', async () => {
    tw.reset();
    const r = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'dialing', batch: 1 });
    expect(r.json.data.lines.filter((l: any) => l.status === 'dialing')).toHaveLength(3);
    expect(tw.created).toHaveLength(3);
    const leg = tw.created.find((c) => c.To === '+15550100001')!;
    const lineId = lineBy(r.json.data, ids.ada).id;
    expect(leg).toMatchObject({ From: '+15550001111', MachineDetection: 'Enable', AsyncAmd: 'true', MachineDetectionTimeout: '5', MachineDetectionSpeechThreshold: '2400', MachineDetectionSpeechEndThreshold: '1200', MachineDetectionSilenceTimeout: '3000', Timeout: '25', StatusCallbackEvent: 'initiated ringing answered completed' });
    expect(leg.Url).toBe(`http://localhost/telephony/parallel/prospect/voice?ws=${t.workspaceId}&session=${sid}&line=${lineId}`);
    expect(leg.AsyncAmdStatusCallback).toBe(`http://localhost/telephony/parallel/prospect/amd?ws=${t.workspaceId}&session=${sid}&line=${lineId}`);
    expect(leg.StatusCallback).toContain('/telephony/parallel/prospect/status?');
    const again = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    expect(again.status).toBe(409);
    expect(again.json.error.details.code).toBe('BATCH_IN_PROGRESS');
    // every line has a call row in the calls list
    const cs = await t.request('/v1/calls?page[size]=50');
    const lineCallIds = r.json.data.lines.filter((l: any) => l.status === 'dialing').map((l: any) => l.callId);
    expect(cs.json.data.filter((c: any) => lineCallIds.includes(c.id) && c.mode === 'parallel' && c.status === 'ringing')).toHaveLength(3);
  });
  it('an answered leg is held in silence while AMD runs', async () => {
    const s = await session(sid);
    const ada = lineBy(s, ids.ada);
    await form(webhook('status', sid, ada.id), { CallSid: await sidOf(ada.id), CallStatus: 'ringing' });
    expect(lineBy(await session(sid), ids.ada).status).toBe('ringing');
    const res = await form(webhook('voice', sid, ada.id), { CallSid: await sidOf(ada.id), CallStatus: 'in-progress' });
    const xml = await res.text();
    // silent hold, plus the callee's audio forked to the speech gate with a signed token (no query string: Twilio forbids it)
    expect(xml).toContain('<Pause length="15"/><Hangup/>');
    expect(xml).toContain('<Start><Stream url="ws://localhost/telephony/parallel/stream" name="gate" track="inbound_track">');
    expect(xml).toContain(`<Parameter name="ws" value="${t.workspaceId}"/><Parameter name="session" value="${sid}"/><Parameter name="line" value="${ada.id}"/><Parameter name="token" value="`);
    expect(xml).toContain('<Parameter name="keywords" value="Ada|Test"/>');
    expect(lineBy(await session(sid), ids.ada).status).toBe('answered');
  });
  it('RACE: two humans at once → exactly one connects, the other is dropped with a callback task, the third sibling is canceled', async () => {
    tw.reset();
    const s = await session(sid);
    const ada = lineBy(s, ids.ada);
    const bob = lineBy(s, ids.bob);
    const cy = lineBy(s, ids.cy);
    const [adaSid, bobSid, cySid] = await Promise.all([sidOf(ada.id), sidOf(bob.id), sidOf(cy.id)]);
    await form(webhook('voice', sid, bob.id), { CallSid: bobSid, CallStatus: 'in-progress' });
    const [r1, r2] = await Promise.all([form(webhook('amd', sid, ada.id), { CallSid: adaSid, AnsweredBy: 'human', MachineDetectionDuration: '1800' }), form(webhook('amd', sid, bob.id), { CallSid: bobSid, AnsweredBy: 'human', MachineDetectionDuration: '2100' })]);
    expect(r1.status).toBe(204);
    expect(r2.status).toBe(204);
    const after = await session(sid);
    const statuses = [lineBy(after, ids.ada).status, lineBy(after, ids.bob).status].sort();
    expect(statuses).toEqual(['connected', 'dropped']);
    expect(after.status).toBe('connected');
    const winner = after.lines.find((l: any) => l.status === 'connected');
    const loser = after.lines.find((l: any) => l.status === 'dropped');
    expect(after.connectedLineId).toBe(winner.id);
    expect(lineBy(after, ids.cy)).toMatchObject({ status: 'canceled', endReason: 'sibling_connected' });
    // carrier: winner redirected into the conference with no beep; loser and sibling hung up
    const winnerSid = winner.id === ada.id ? adaSid : bobSid;
    const loserSid = winner.id === ada.id ? bobSid : adaSid;
    const join = tw.updates.find((u) => u.sid === winnerSid && u.params.Twiml);
    expect(join!.params.Twiml).toContain(`startConferenceOnEnter="false" endConferenceOnExit="false" waitUrl=""`);
    expect(join!.params.Twiml).toContain(`participantLabel="line:${winner.id}">cooks-${sid}</Conference>`);
    expect(join!.params.Twiml).toContain('beep="false"');
    expect(tw.updates.find((u) => u.sid === loserSid)?.params).toEqual({ Status: 'completed' });
    expect(tw.updates.find((u) => u.sid === cySid)?.params).toEqual({ Status: 'canceled' });
    expect(tw.updates.filter((u) => u.params.Twiml)).toHaveLength(1); // only one leg ever joins
    // recording started on the rep leg, dual channel, pointed at the winner's call
    expect(tw.recordings).toHaveLength(1);
    expect(tw.recordings[0]).toMatchObject({ callSid: 'CArep', params: { RecordingChannels: 'dual' } });
    expect(tw.recordings[0]!.params.RecordingStatusCallback).toBe(`http://localhost/telephony/recording?ws=${t.workspaceId}&call=${winner.callId}`);
    // dropped human → high-priority callback task for the rep, due in 15 minutes
    expect(loser.callbackTaskId).toBeTruthy();
    const [task] = await t.db.select().from(tasks).where(eq(tasks.id, loser.callbackTaskId));
    expect(task).toMatchObject({ prospectId: loser.prospect.id, action: 'call', priority: 'high', ownerId: t.ownerId });
    expect(task!.note).toMatch(/another call connected first/);
    expect(task!.dueAt.getTime() - t.clock.now().getTime()).toBe(15 * 60_000);
    const [loserCall] = await t.db.select().from(calls).where(eq(calls.id, loser.callId));
    expect(loserCall).toMatchObject({ status: 'abandoned', amdResult: 'human', outcome: null });
    const [winnerCall] = await t.db.select().from(calls).where(eq(calls.id, winner.callId));
    expect(winnerCall).toMatchObject({ status: 'in_progress', amdResult: 'human' });
    expect((await t.db.select().from(outboxEvents)).some((e) => e.eventType === 'call.started' && (e.payload as any).callId === winner.callId)).toBe(true);
    ids.winnerLine = winner.id;
    ids.winnerCall = winner.callId;
    ids.winnerSid = winnerSid;
  });
  it('IDEMPOTENT: replaying the same AMD and status callbacks changes nothing', async () => {
    const before = { updates: tw.updates.length, tasks: (await t.db.select().from(tasks)).length, events: (await t.db.select().from(dialEvents)).length };
    const after = await session(sid);
    const loser = after.lines.find((l: any) => l.status === 'dropped');
    const loserSid = await sidOf(loser.id);
    const r = await form(webhook('amd', sid, loser.id), { CallSid: loserSid, AnsweredBy: 'human' });
    expect(r.status).toBe(204);
    await form(webhook('amd', sid, ids.winnerLine!), { CallSid: ids.winnerSid!, AnsweredBy: 'human' });
    expect(tw.updates.length).toBe(before.updates);
    expect((await t.db.select().from(tasks)).length).toBe(before.tasks);
    expect((await t.db.select().from(dialEvents)).length).toBe(before.events);
    expect((await session(sid)).status).toBe('connected');
  });
  it('a canceled sibling that still answers is hung up at once; an answered sibling waits for its verdict and a machine is just voicemail', async () => {
    const s = await session(sid);
    const cy = lineBy(s, ids.cy);
    // Twilio could still deliver in-progress for a leg we just canceled; its AMD must not matter.
    const res = await form(webhook('voice', sid, cy.id), { CallSid: await sidOf(cy.id), CallStatus: 'in-progress' });
    const xml = await res.text();
    expect(xml).not.toContain('<Pause');
    expect(xml).not.toContain('<Conference');
    expect((await session(sid)).status).toBe('connected');
    // A sibling answered before the win and turning out to be a machine: voicemail, no callback task, no abandonment.
    const tasksBefore = (await t.db.select().from(tasks)).length;
    const r = await t.request(`/v1/dialSessions/${sid}/actions/queue`, { method: 'POST', json: { data: { prospectIds: [ids.dee] } } });
    expect(r.status).toBe(200);
    expect(lineBy(r.json.data, ids.dee).status).toBe('queued');
    expect((await t.db.select().from(tasks)).length).toBe(tasksBefore);
  });
  it('rep can hang up the live line; the status callback closes it, stops the recording and the session is ready again', async () => {
    tw.reset();
    const h = await t.request(`/v1/dialSessions/${sid}/actions/hangup`, { method: 'POST' });
    expect(h.status).toBe(200);
    expect(tw.updates.find((u) => u.sid === ids.winnerSid)?.params).toEqual({ Status: 'completed' });
    const blocked = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.details.code).toBe('LINE_CONNECTED');
    await form(webhook('status', sid, ids.winnerLine!), { CallSid: ids.winnerSid!, CallStatus: 'completed', CallDuration: '142' });
    const s = await session(sid);
    expect(s.status).toBe('wrapping');
    expect(s.lines.find((l: any) => l.id === ids.winnerLine)).toMatchObject({ status: 'completed', durationSeconds: 142 });
    expect(tw.recordings.find((r) => r.callSid === 'CArep' && r.path === 'RE1')?.params).toEqual({ Status: 'stopped' });
    const c = (await t.request(`/v1/calls/${ids.winnerCall}`)).json.data;
    expect(c).toMatchObject({ status: 'completed', duration: 142, outcome: 'answered', mode: 'parallel' });
    const log = await t.request(`/v1/calls/${ids.winnerCall}/actions/log`, { method: 'POST', json: { data: { outcome: 'meeting_booked', notes: 'Demo Friday' } } });
    expect(log.status).toBe(200);
  });
  it('VOICEMAIL: machine verdicts hang up, never join, and auto-log as No answer; no-answer/busy legs auto-log too', async () => {
    tw.reset();
    const r = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST', json: { data: { prospectIds: [ids.dee, ids.eve, ids.fay] } } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'dialing', batch: 2, connectedLineId: null });
    const s = r.json.data;
    const dee = lineBy(s, ids.dee, 2);
    const eve = lineBy(s, ids.eve, 2);
    const fay = lineBy(s, ids.fay, 2);
    const [deeSid, eveSid, faySid] = await Promise.all([sidOf(dee.id), sidOf(eve.id), sidOf(fay.id)]);
    await form(webhook('voice', sid, dee.id), { CallSid: deeSid, CallStatus: 'in-progress' });
    await form(webhook('amd', sid, dee.id), { CallSid: deeSid, AnsweredBy: 'machine_start', MachineDetectionDuration: '3100' });
    await form(webhook('status', sid, eve.id), { CallSid: eveSid, CallStatus: 'no-answer' });
    await form(webhook('status', sid, fay.id), { CallSid: faySid, CallStatus: 'busy' });
    const after = await session(sid);
    expect(lineBy(after, ids.dee, 2)).toMatchObject({ status: 'voicemail', answeredBy: 'machine_start' });
    expect(lineBy(after, ids.eve, 2).status).toBe('no_answer');
    expect(lineBy(after, ids.fay, 2).status).toBe('busy');
    expect(tw.updates.find((u) => u.sid === deeSid)?.params).toEqual({ Status: 'completed' });
    expect(tw.updates.some((u) => u.params.Twiml)).toBe(false);
    expect(tw.recordings).toHaveLength(0);
    expect(after.status).toBe('ready'); // batch settled, nobody connected
    const vm = (await t.request(`/v1/calls/${dee.callId}?include=callDisposition`)).json.data;
    expect(vm).toMatchObject({ status: 'voicemail', outcome: 'voicemail', amdResult: 'machine_start', callDisposition: { name: 'No answer' } });
    expect(vm.loggedAt).toBeTruthy();
    const na = (await t.request(`/v1/calls/${eve.callId}?include=callDisposition`)).json.data;
    expect(na).toMatchObject({ outcome: 'no_answer', callDisposition: { name: 'No answer' } });
    const busy = (await t.request(`/v1/calls/${fay.callId}?include=callDisposition`)).json.data;
    expect(busy.callDisposition.name).toBe('Busy');
  });
  it('unknown verdicts hang up by default; fax is a failure', async () => {
    tw.reset();
    const r = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST', json: { data: { prospectIds: [ids.ada, ids.bob], lines: 2 } } });
    const ada = lineBy(r.json.data, ids.ada, 3);
    const bob = lineBy(r.json.data, ids.bob, 3);
    await form(webhook('amd', sid, ada.id), { CallSid: await sidOf(ada.id), AnsweredBy: 'unknown' });
    await form(webhook('amd', sid, bob.id), { CallSid: await sidOf(bob.id), AnsweredBy: 'fax' });
    const after = await session(sid);
    expect(lineBy(after, ids.ada, 3)).toMatchObject({ status: 'no_answer', answeredBy: 'unknown' });
    expect(lineBy(after, ids.bob, 3)).toMatchObject({ status: 'failed', answeredBy: 'fax' });
    expect(after.status).toBe('ready');
  });
  it('auto-dial rings the next batch by itself when a batch settles with no connect', async () => {
    tw.reset();
    await t.request(`/v1/dialSessions/${sid}`, { method: 'PATCH', json: { data: { autoDial: true, maxLines: 2 } } });
    const r = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST', json: { data: { prospectIds: [ids.cy, ids.dee, ids.eve] } } });
    expect(r.json.data.batch).toBe(4);
    const cy = lineBy(r.json.data, ids.cy, 4);
    const dee = lineBy(r.json.data, ids.dee, 4);
    expect(tw.created).toHaveLength(2);
    await form(webhook('status', sid, cy.id), { CallSid: await sidOf(cy.id), CallStatus: 'no-answer' });
    expect((await session(sid)).status).toBe('dialing');
    await form(webhook('status', sid, dee.id), { CallSid: await sidOf(dee.id), CallStatus: 'failed' });
    const after = await session(sid);
    expect(after.batch).toBe(5);
    expect(after.status).toBe('dialing');
    expect(lineBy(after, ids.eve, 5).status).toBe('dialing');
    expect(tw.created).toHaveLength(3);
  });
  it('ending the session hangs up every live leg, closes the room and skips the queue', async () => {
    tw.reset();
    await t.request(`/v1/dialSessions/${sid}/actions/queue`, { method: 'POST', json: { data: { prospectIds: [ids.fay] } } });
    const r = await t.request(`/v1/dialSessions/${sid}/actions/end`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'ended', endReason: 'ended_by_rep' });
    expect(lineBy(r.json.data, ids.eve, 5)).toMatchObject({ status: 'canceled', endReason: 'ended_by_rep' });
    expect(r.json.data.lines.filter((l: any) => l.skipReason === 'session_ended')).toHaveLength(1);
    expect(tw.conferences).toEqual([{ sid: 'CF1', params: { Status: 'completed' } }]);
    expect(tw.updates.some((u) => u.params.Status === 'canceled')).toBe(true);
    const again = await t.request(`/v1/dialSessions/${sid}/actions/end`, { method: 'POST' });
    expect(again.json.data.status).toBe('ended');
    expect((await t.request('/v1/dialSessions/current')).json.data).toBeNull();
    const list = await t.request('/v1/dialSessions');
    expect(list.json.data.map((s: any) => s.id)).toContain(sid);
    expect(r.json.data.stats).toMatchObject({ dropped: 1, voicemail: 1, connected: 1 });
  });
});

describe('carrier edge cases', () => {
  it('hangupLeg treats an already-ended leg as success and falls back from canceled to completed', async () => {
    await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { complianceMode: 'b2b', confirm: true } } });
    const r = await t.request('/v1/dialSessions', { method: 'POST', json: { data: { repMode: 'browser', prospectIds: [ids.ada, ids.bob] } } });
    const sid = r.json.data.id;
    await form(`/telephony/voice?ws=${t.workspaceId}`, { CallSid: 'CArep2', kind: 'parallel', sessionId: sid });
    tw.reset();
    const d = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    const ada = lineBy(d.json.data, ids.ada!, 1);
    const bob = lineBy(d.json.data, ids.bob!, 1);
    const bobSid = await sidOf(bob.id);
    tw.gone.add(bobSid);
    await form(webhook('amd', sid, ada.id), { CallSid: await sidOf(ada.id), AnsweredBy: 'human' });
    const s = await session(sid);
    expect(s.status).toBe('connected');
    expect(lineBy(s, ids.bob!, 1).status).toBe('canceled');
    // canceled was tried, 404 → treated as gone (no second attempt needed)
    expect(tw.updates.filter((u) => u.sid === bobSid).map((u) => u.params.Status)).toEqual(['canceled']);
    tw.gone.delete(bobSid);
    await t.request(`/v1/dialSessions/${sid}/actions/end`, { method: 'POST' });
  });
});

describe('answered sibling at win time', () => {
  it('waits for the verdict: a machine is voicemail (no callback task), a person is dropped with a callback', async () => {
    const r = await t.request('/v1/dialSessions', { method: 'POST', json: { data: { repMode: 'browser', maxLines: 3, prospectIds: [ids.ada, ids.bob, ids.cy] } } });
    expect(r.status).toBe(201);
    const sid = r.json.data.id;
    await form(`/telephony/voice?ws=${t.workspaceId}`, { CallSid: 'CArep3', kind: 'parallel', sessionId: sid });
    tw.reset();
    const d = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    const ada = lineBy(d.json.data, ids.ada, 1);
    const bob = lineBy(d.json.data, ids.bob, 1);
    const cy = lineBy(d.json.data, ids.cy, 1);
    const [adaSid, bobSid, cySid] = await Promise.all([sidOf(ada.id), sidOf(bob.id), sidOf(cy.id)]);
    // all three pick up; only Ada's verdict is in
    for (const [l, cs] of [[ada, adaSid], [bob, bobSid], [cy, cySid]] as const) await form(webhook('voice', sid, l.id), { CallSid: cs, CallStatus: 'in-progress' });
    const tasksBefore = (await t.db.select().from(tasks)).length;
    await form(webhook('amd', sid, ada.id), { CallSid: adaSid, AnsweredBy: 'human' });
    let s = await session(sid);
    expect(s.status).toBe('connected');
    expect(lineBy(s, ids.bob, 1).status).toBe('answered');
    expect(lineBy(s, ids.cy, 1).status).toBe('answered');
    expect(tw.updates.filter((u) => u.sid === bobSid || u.sid === cySid)).toHaveLength(0);
    // Bob is a machine → voicemail, logged as No answer, no callback; Cy is a person → dropped + callback
    await form(webhook('amd', sid, bob.id), { CallSid: bobSid, AnsweredBy: 'machine_start' });
    await form(webhook('amd', sid, cy.id), { CallSid: cySid, AnsweredBy: 'human' });
    s = await session(sid);
    expect(lineBy(s, ids.bob, 1)).toMatchObject({ status: 'voicemail', callbackTaskId: null });
    expect(lineBy(s, ids.cy, 1)).toMatchObject({ status: 'dropped', endReason: 'second_human' });
    expect(lineBy(s, ids.cy, 1).callbackTaskId).toBeTruthy();
    expect((await t.db.select().from(tasks)).length).toBe(tasksBefore + 1);
    expect(tw.updates.find((u) => u.sid === bobSid)?.params).toEqual({ Status: 'completed' });
    expect(tw.updates.find((u) => u.sid === cySid)?.params).toEqual({ Status: 'completed' }); // B2B: silent drop
    expect(s.stats).toMatchObject({ connected: 1, voicemail: 1, dropped: 1 });
    await t.request(`/v1/dialSessions/${sid}/actions/end`, { method: 'POST' });
  });
});

/* ------------------------------------------------------------- speech gate (fast pickup) */
type Kind = 'silence' | 'speech';
function mulawFrame(kind: Kind, i: number): string {
  const b = new Uint8Array(160);
  for (let n = 0; n < 160; n++) {
    const tt = (i * 160 + n) / 8000;
    const v = kind === 'speech' ? 6000 * Math.sin(2 * Math.PI * 180 * tt) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * tt)) + Math.sin(tt * 7919) * 2500 : Math.sin(tt * 104729) * 30;
    b[n] = pcm16ToMulaw(v);
  }
  return Buffer.from(b).toString('base64');
}
/** Drive a gate socket like Twilio would: start (with the TwiML's parameters) then 20 ms frames until it closes. */
async function streamTo(sock: ReturnType<typeof createGateSocket>, params: Record<string, string>, segs: Array<[number, Kind]>, script: Array<{ atMs: number; text: string; final?: boolean }>, closed: () => boolean) {
  await sock.message(JSON.stringify({ event: 'connected', protocol: 'Call', version: '1.0.0' }));
  await sock.message(JSON.stringify({ event: 'start', streamSid: 'MZ1', start: { callSid: 'CAx', customParameters: { ...params, qaScript: JSON.stringify(script) }, mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } } }));
  let i = 0;
  let sent = 0;
  for (const [ms, kind] of segs) {
    for (let k = 0; k < ms / 20 && !closed(); k++) {
      await sock.message(JSON.stringify({ event: 'media', media: { track: 'inbound', chunk: String(i + 1), timestamp: String(i * 20), payload: mulawFrame(kind, i++) } }));
      sent += 20;
    }
  }
  // the socket closes the instant a verdict exists; wait for the verdict's DB work too
  await Promise.race([sock.done, new Promise((r) => setTimeout(r, 3000))]);
  return sent;
}
const streamParams = (xml: string) => Object.fromEntries([...xml.matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)].map((m) => [m[1]!, m[2]!.replace(/&amp;/g, '&')]));
const socketFor = () => {
  let closed = false;
  const sock = createGateSocket({ db: t.db, jobs: t.jobs, clock: t.clock, publicUrl: 'http://localhost', dialer: (t as any).dialerDeps ?? { kek: t.kek, fetchImpl: tw.fetchImpl, speech: { provider: 'mock', jev: { apiKey: 'or-test-key' } }, publicUrl: 'http://localhost' }, fetchImpl: tw.fetchImpl, close: () => void (closed = true) });
  return { sock, closed: () => closed };
};

describe('speech gate: hear the pickup, connect before AMD', () => {
  let sid: string;
  let xmlAda = '';
  it('opens a session and holds the first answered leg with its audio forked to the gate', async () => {
    await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { complianceMode: 'b2b', confirm: true, maxLines: 3, speechGate: { enabled: true, judge: 'rules' } } } });
    const get = await t.request('/v1/workspace/dialer/compliance');
    expect(get.json.data.speechGate).toMatchObject({ enabled: true, judge: 'rules', maxMs: 6000 });
    expect(get.json.data.speech).toEqual({ provider: 'mock', jevAvailable: true });
    tw.reset();
    const r = await t.request('/v1/dialSessions', { method: 'POST', json: { data: { repMode: 'phone', repPhone: '+15559998888', prospectIds: [ids.ada, ids.bob, ids.cy] } } });
    sid = r.json.data.id;
    const repSid = tw.created[0]!.sid;
    await form(`/telephony/parallel/rep/voice?ws=${t.workspaceId}&session=${sid}`, { CallSid: repSid, CallStatus: 'in-progress' });
    await form(`/telephony/parallel/conference?ws=${t.workspaceId}&session=${sid}`, { StatusCallbackEvent: 'participant-join', ConferenceSid: 'CFs', CallSid: repSid, ParticipantLabel: 'rep' });
    expect((await session(sid)).status).toBe('ready');
    await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST' });
    const s = await session(sid);
    const ada = lineBy(s, ids.ada);
    xmlAda = await (await form(webhook('voice', sid, ada.id), { CallSid: await sidOf(ada.id), CallStatus: 'in-progress' })).text();
    expect(xmlAda).toContain('<Start><Stream url="ws://localhost/telephony/parallel/stream"');
  });
  it('rejects a socket whose start message carries a bad or foreign token', async () => {
    const p = streamParams(xmlAda);
    const bad = socketFor();
    await bad.sock.message(JSON.stringify({ event: 'start', start: { customParameters: { ...p, token: `${p.token!.split('.')[0]}.tampered` } } }));
    expect(bad.closed()).toBe(true);
    expect(bad.sock.authenticated).toBe(false);
    const foreign = socketFor();
    const other = mintStreamToken(t.kek, { ws: t.workspaceId, session: p.session!, line: '00000000-0000-0000-0000-000000000001', exp: Math.floor(t.clock.now().getTime() / 1000) + 60 });
    await foreign.sock.message(JSON.stringify({ event: 'start', start: { customParameters: { ...p, token: other } } }));
    expect(foreign.closed()).toBe(true);
  });
  it('"Hello?" → the line is connected by what was heard, in about a second; the later AMD callback is a no-op', async () => {
    const s = await session(sid);
    const ada = lineBy(s, ids.ada);
    const adaSid = await sidOf(ada.id);
    const g = socketFor();
    const sentMs = await streamTo(g.sock, streamParams(xmlAda), [[300, 'silence'], [600, 'speech'], [2000, 'silence']], [{ atMs: 520, text: 'Hello' }, { atMs: 820, text: 'Hello?', final: true }], g.closed);
    expect(g.closed()).toBe(true); // the gate hangs up its own ears after the verdict
    expect(sentMs).toBeLessThan(1500);
    const after = await session(sid);
    const line = lineBy(after, ids.ada);
    expect(line).toMatchObject({ status: 'connected', answeredBy: 'human', verdictSource: 'speech' });
    expect(line.speech).toMatchObject({ text: 'Hello?', provider: 'mock', judge: 'rules' });
    expect(line.speech.latencyMs).toBeLessThan(1500);
    expect(after.status).toBe('connected');
    expect(tw.updates.filter((u) => u.sid === adaSid && u.params.Twiml)).toHaveLength(1);
    // siblings still ringing were canceled
    expect(lineBy(after, ids.bob)).toMatchObject({ status: 'canceled', endReason: 'sibling_connected' });
    // Twilio's AMD arrives three seconds later and changes nothing
    const updates = tw.updates.length;
    expect((await form(webhook('amd', sid, ada.id), { CallSid: adaSid, AnsweredBy: 'human', MachineDetectionDuration: '3000' })).status).toBe(204);
    const again = lineBy(await session(sid), ids.ada);
    expect(again).toMatchObject({ status: 'connected', verdictSource: 'speech' });
    expect(tw.updates.length).toBe(updates);
    const [call] = await t.db.select().from(calls).where(eq(calls.id, line.callId));
    expect(call).toMatchObject({ status: 'in_progress', amdResult: 'human' });
    const ev = await t.db.select().from(dialEvents).where(and(eq(dialEvents.sessionId, sid), eq(dialEvents.kind, 'prospect.speech')));
    expect(ev).toHaveLength(1);
    expect((ev[0]!.payload as any).text).toBe('Hello?');
  });
  it('a voicemail greeting on the next batch is dropped on its first phrase and logged, never connected', async () => {
    // wrap the live call and dial again
    const s0 = await session(sid);
    const ada = lineBy(s0, ids.ada);
    await form(webhook('status', sid, ada.id), { CallSid: await sidOf(ada.id), CallStatus: 'completed', CallDuration: '40' });
    await t.request(`/v1/calls/${ada.callId}/actions/log`, { method: 'POST', json: { data: { outcome: 'connected' } } });
    tw.reset();
    const d = await t.request(`/v1/dialSessions/${sid}/actions/dial`, { method: 'POST', json: { data: { prospectIds: [ids.dee, ids.eve] } } });
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    const s = await session(sid);
    expect(s, 'session readable after second dial').toBeTruthy();
    const dee = lineBy(s, ids.dee, s.batch);
    const deeSid = await sidOf(dee.id);
    const xml = await (await form(webhook('voice', sid, dee.id), { CallSid: deeSid, CallStatus: 'in-progress' })).text();
    const g = socketFor();
    const sentMs = await streamTo(g.sock, streamParams(xml), [[300, 'silence'], [6000, 'speech']], [{ atMs: 700, text: 'Hi you' }, { atMs: 1000, text: "Hi, you've reached Dee" }], g.closed);
    expect(sentMs).toBeLessThanOrEqual(1100);
    const after = await session(sid);
    const line = lineBy(after, ids.dee, s.batch);
    expect(line).toMatchObject({ status: 'voicemail', answeredBy: 'machine_speech', verdictSource: 'speech' });
    expect(line.speech).toMatchObject({ reason: "phrase:you've reached" });
    expect(tw.updates.find((u) => u.sid === deeSid)?.params).toEqual({ Status: 'completed' });
    const [call] = await t.db.select().from(calls).where(eq(calls.id, line.callId));
    expect(call).toMatchObject({ status: 'voicemail', outcome: 'voicemail' });
    // eve is still ringing: the race is open for her
    expect(lineBy(after, ids.eve, s.batch).status).toBe('dialing');
  });
  it('an unclear pickup goes to Jev when the workspace asks for it; its answer settles the line', async () => {
    await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { speechGate: { judge: 'jev' } } } });
    const s = await session(sid);
    const eve = lineBy(s, ids.eve, s.batch);
    const eveSid = await sidOf(eve.id);
    const xml = await (await form(webhook('voice', sid, eve.id), { CallSid: eveSid, CallStatus: 'in-progress' })).text();
    tw.state.jevAnswer = 'human';
    const g = socketFor();
    await streamTo(g.sock, streamParams(xml), [[300, 'silence'], [500, 'speech'], [1500, 'silence']], [{ atMs: 700, text: 'Eve Test', final: true }], g.closed);
    expect(tw.jev).toHaveLength(1);
    expect(tw.jev[0]).toMatchObject({ model: 'typesafe/jev-1.14' });
    expect((tw.jev[0] as any).state.transcript).toBe('Eve Test');
    const line = lineBy(await session(sid), ids.eve, s.batch);
    expect(line).toMatchObject({ status: 'connected', verdictSource: 'speech' });
    expect(line.speech).toMatchObject({ judge: 'jev', reason: 'jev:human', costUsd: 0.00002 });
    await t.request(`/v1/dialSessions/${sid}/actions/end`, { method: 'POST' });
  });
  it('with the gate turned off the hold is a plain pause and sockets are refused', async () => {
    await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { speechGate: { enabled: false } } } });
    tw.reset();
    const r = await t.request('/v1/dialSessions', { method: 'POST', json: { data: { repMode: 'phone', repPhone: '+15559998888', prospectIds: [ids.fay] } } });
    const id = r.json.data.id;
    const repSid = tw.created[0]!.sid;
    await form(`/telephony/parallel/rep/voice?ws=${t.workspaceId}&session=${id}`, { CallSid: repSid, CallStatus: 'in-progress' });
    await form(`/telephony/parallel/conference?ws=${t.workspaceId}&session=${id}`, { StatusCallbackEvent: 'participant-join', ConferenceSid: 'CFt', CallSid: repSid, ParticipantLabel: 'rep' });
    await t.request(`/v1/dialSessions/${id}/actions/dial`, { method: 'POST' });
    const fay = lineBy(await session(id), ids.fay);
    const xml = await (await form(webhook('voice', id, fay.id), { CallSid: await sidOf(fay.id), CallStatus: 'in-progress' })).text();
    expect(xml).toBe(pauseTwiml(15));
    const g = socketFor();
    const tok = mintStreamToken(t.kek, { ws: t.workspaceId, session: id, line: fay.id, exp: Math.floor(t.clock.now().getTime() / 1000) + 60 });
    await g.sock.message(JSON.stringify({ event: 'start', start: { customParameters: { ws: t.workspaceId, session: id, line: fay.id, token: tok } } }));
    expect(g.closed()).toBe(true);
    await t.request(`/v1/dialSessions/${id}/actions/end`, { method: 'POST' });
    await t.request('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { speechGate: { enabled: true, judge: 'rules' } } } });
  });
});

describe('webhook security', () => {
  it('parallel webhooks reject unknown workspaces and bad signatures', async () => {
    expect((await form(`/telephony/parallel/prospect/amd?ws=00000000-0000-0000-0000-000000000000&session=x&line=y`, { AnsweredBy: 'human' })).status).toBe(403);
    const secure = await createTestApp({ fetchImpl: tw.fetchImpl, telephony: { trustWebhookSignature: true } as never });
    try {
      await secure.request('/v1/workspace/telephony', { method: 'PUT', json: { data: { accountSid: 'ACabcdef1234567890', authToken: 'good-token' } } });
      const url = `http://localhost/telephony/parallel/conference?ws=${secure.workspaceId}&session=none`;
      const params = { StatusCallbackEvent: 'conference-end', ConferenceSid: 'CFx' };
      const bad = await secure.app.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' }, body: new URLSearchParams(params).toString() });
      expect(bad.status).toBe(403);
      const good = await secure.app.request(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature('good-token', url, params) }, body: new URLSearchParams(params).toString() });
      expect(good.status).toBe(204); // signature accepted; unknown session is swallowed
    } finally {
      await secure.close();
    }
  });
});
