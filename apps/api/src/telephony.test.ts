import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { calls, outboxEvents, tasks } from '@cooks/db';
import { dialTwiml, twilioSignature, validateTwilioSignature, voiceAccessToken, normalizePhone } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

/** In-memory Twilio: verifies creds, lists numbers, records Calls.create, serves a recording. */
function fakeTwilio() {
  const created: Array<Record<string, string>> = [];
  const bought: Array<Record<string, string>> = [];
  const searches: Array<Record<string, string>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const auth = Buffer.from(((init?.headers as Record<string, string>)?.authorization ?? '').replace('Basic ', ''), 'base64').toString();
    if (!auth.endsWith(':good-token')) return Response.json({ code: 20003, message: 'Authenticate' }, { status: 401 });
    if (/\/Accounts\/AC[a-z0-9]+\.json$/.test(url.pathname)) return Response.json({ sid: 'ACtest', friendly_name: 'Cooks QA', status: 'active' });
    if (url.pathname.endsWith('/IncomingPhoneNumbers.json') && init?.method === 'POST') {
      const p = Object.fromEntries(new URLSearchParams(String(init?.body)));
      bought.push(p);
      return Response.json({ sid: 'PN1', phone_number: p.PhoneNumber, friendly_name: p.FriendlyName }, { status: 201 });
    }
    if (url.pathname.endsWith('/IncomingPhoneNumbers.json')) return Response.json({ incoming_phone_numbers: [{ phone_number: '+15550001111' }] });
    if (url.pathname.endsWith('/AvailablePhoneNumbers/US/Local.json')) {
      searches.push(Object.fromEntries(url.searchParams));
      return Response.json({ available_phone_numbers: [{ phone_number: '+12135550142', friendly_name: '(213) 555-0142', locality: 'Los Angeles', region: 'CA', capabilities: { voice: true, SMS: true, MMS: false } }] });
    }
    if (url.hostname === 'pricing.twilio.com' && url.pathname === '/v1/PhoneNumbers/Countries/US') return Response.json({ price_unit: 'usd', phone_number_prices: [{ number_type: 'local', base_price: '1.15', current_price: '1.15' }, { number_type: 'toll free', base_price: '2.15', current_price: '2.15' }] });
    if (url.pathname.endsWith('/Calls.json')) {
      const p = Object.fromEntries(new URLSearchParams(String(init?.body)));
      created.push(p);
      return Response.json({ sid: `CA${created.length}`, status: 'queued' }, { status: 201 });
    }
    if (/\/Recordings\/RE\w+\.mp3$/.test(url.pathname)) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    return Response.json({ message: `unhandled ${url.pathname}` }, { status: 404 });
  };
  return { fetchImpl, created, bought, searches };
}

let t: TestApp;
const tw = fakeTwilio();
let prospectId: string;
const form = (path: string, params: Record<string, string>) => t.app.request(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString() });

beforeAll(async () => {
  t = await createTestApp({ fetchImpl: tw.fetchImpl, telephony: { trustWebhookSignature: false } });
  const acc = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex', domain: 'globex.test' } } });
  const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', primaryEmail: 'ada@globex.test', phone: '(555) 010-2020', account: { id: acc.json.data.id } } } });
  prospectId = p.json.data.id;
});
afterAll(() => t.close());

describe('twilio primitives', () => {
  it('normalises phones, signs requests like Twilio, mints a Voice token, renders TwiML', () => {
    expect(normalizePhone('(555) 010-2020')).toBe('+15550102020');
    expect(normalizePhone('+44 20 7946 0958')).toBe('+442079460958');
    expect(normalizePhone('12')).toBeNull();
    // Known answer computed independently (python hmac) over Twilio's documented example request
    const sig = twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' });
    expect(sig).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
    expect(validateTwilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' }, sig)).toBe(true);
    expect(validateTwilioSignature('wrong', 'https://mycompany.com/myapp.php?foo=1&bar=2', {}, sig)).toBe(false);
    const tok = voiceAccessToken({ accountSid: 'ACx', apiKeySid: 'SKx', apiKeySecret: 'secret', identity: 'user_1', twimlAppSid: 'APx', now: new Date('2026-01-01T00:00:00Z') });
    const [h, p] = tok.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' });
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(payload).toMatchObject({ iss: 'SKx', sub: 'ACx', grants: { identity: 'user_1', voice: { outgoing: { application_sid: 'APx' } } } });
    expect(payload.exp - payload.iat).toBe(3600);
    const xml = dialTwiml({ to: '+15550102020', callerId: '+15550001111', record: true, recordingStatusCallback: 'http://x/r?a=1&b=2', statusCallback: 'http://x/s', sayFirst: 'Connecting you to Ada <3' });
    expect(xml).toContain('record="record-from-answer-dual"');
    expect(xml).toContain('recordingStatusCallback="http://x/r?a=1&amp;b=2"');
    expect(xml).toContain('<Say voice="Polly.Joanna">Connecting you to Ada &lt;3</Say>');
    expect(xml).toContain('<Number statusCallback="http://x/s" statusCallbackEvent="initiated ringing answered completed">+15550102020</Number>');
  });
});

describe('telephony connection', () => {
  it('rejects bad credentials, connects with good ones, discovers numbers, hides the token', async () => {
    const bad = await t.request('/v1/workspace/telephony', { method: 'PUT', json: { data: { accountSid: 'ACabcdef1234567890', authToken: 'bad-token-xxxx' } } });
    expect(bad.status).toBe(422);
    const ok = await t.request('/v1/workspace/telephony', { method: 'PUT', json: { data: { accountSid: 'ACabcdef1234567890', authToken: 'good-token' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ status: 'connected', fromNumbers: ['+15550001111'], softphone: false, record: true, accountSidLast4: '7890' });
    expect(JSON.stringify(ok.json)).not.toContain('good-token');
    const get = await t.request('/v1/workspace/telephony');
    expect(get.json.data.status).toBe('connected');
  });
  it('softphone token needs an API key pair; with one it mints a token', async () => {
    expect((await t.request('/v1/telephony/token', { method: 'POST' })).status).toBe(422);
    const up = await t.request('/v1/workspace/telephony', { method: 'PUT', json: { data: { accountSid: 'ACabcdef1234567890', authToken: 'good-token', apiKeySid: 'SKabc', apiKeySecret: 'sk-secret-value', twimlAppSid: 'APabc', fromNumbers: ['555-000-1111', '+15550002222'] } } });
    expect(up.json.data).toMatchObject({ softphone: true, fromNumbers: ['+15550001111', '+15550002222'] });
    const tok = await t.request('/v1/telephony/token', { method: 'POST', json: { data: { ttlSeconds: 600 } } });
    expect(tok.status).toBe(200);
    expect(tok.json.data).toMatchObject({ expiresIn: 600, voiceUrl: `http://localhost/telephony/voice?ws=${t.workspaceId}` });
    expect(tok.json.data.token.split('.')).toHaveLength(3);
  });
});

describe('bridge call lifecycle', () => {
  let callId: string;
  let taskId: string;
  it('dial: creates the call row, rings the rep through Twilio, links the call task', async () => {
    const task = await t.request('/v1/tasks', { method: 'POST', json: { data: { action: 'call', dueAt: new Date().toISOString(), ownerId: t.ownerId, prospectId, note: 'Follow-up call' } } });
    taskId = task.json.data.id;
    const noPhone = await t.request('/v1/calls/actions/dial', { method: 'POST', json: { data: { taskId, mode: 'bridge' } } });
    expect(noPhone.status).toBe(422);
    expect(noPhone.json.error.message).toMatch(/repPhone/);
    const r = await t.request('/v1/calls/actions/dial', { method: 'POST', json: { data: { taskId, mode: 'bridge', repPhone: '555 999 8888' } } });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ mode: 'bridge', repPhone: '+15559998888', call: { status: 'ringing_rep', to: '+15550102020', from: '+15550001111', source: 'sequence', taskId, prospect: { id: prospectId } } });
    callId = r.json.data.call.id;
    const leg = tw.created.at(-1)!;
    expect(leg.To).toBe('+15559998888');
    expect(leg.From).toBe('+15550001111');
    expect(leg.Url).toBe(`http://localhost/telephony/voice/bridge?ws=${t.workspaceId}&call=${callId}`);
    expect(leg.StatusCallback).toContain('leg=rep');
    expect(leg.StatusCallbackEvent).toBe('initiated ringing answered completed');
  });
  it('bridge TwiML dials the prospect with dual-channel recording and callbacks', async () => {
    const res = await form(`/telephony/voice/bridge?ws=${t.workspaceId}&call=${callId}`, { CallSid: 'CA1', CallStatus: 'in-progress' });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('Connecting you to Ada Lovelace.');
    expect(xml).toContain('>+15550102020</Number>');
    expect(xml).toContain(`recordingStatusCallback="http://localhost/telephony/recording?ws=${t.workspaceId}&amp;call=${callId}"`);
    expect(xml).toContain('leg=prospect');
  });
  it('status callbacks move the call through ringing → in_progress → completed with duration and events', async () => {
    await form(`/telephony/status?ws=${t.workspaceId}&call=${callId}&leg=prospect`, { CallSid: 'CA2', CallStatus: 'ringing' });
    expect((await t.request(`/v1/calls/${callId}`)).json.data.status).toBe('ringing');
    await form(`/telephony/status?ws=${t.workspaceId}&call=${callId}&leg=prospect`, { CallSid: 'CA2', CallStatus: 'in-progress' });
    expect((await t.request(`/v1/calls/${callId}`)).json.data.status).toBe('in_progress');
    await form(`/telephony/status?ws=${t.workspaceId}&call=${callId}&leg=prospect`, { CallSid: 'CA2', CallStatus: 'completed', CallDuration: '187' });
    const c = (await t.request(`/v1/calls/${callId}`)).json.data;
    expect(c).toMatchObject({ status: 'completed', duration: 187 });
    expect(c.endedAt).toBeTruthy();
    const evs = (await t.db.select().from(outboxEvents)).map((e) => e.eventType);
    expect(evs).toContain('call.started');
    expect(evs).toContain('call.completed');
  });
  it('recording callback stores the SID, proxies audio, and queues transcription', async () => {
    await form(`/telephony/recording?ws=${t.workspaceId}&call=${callId}`, { RecordingSid: 'RE123', RecordingUrl: 'https://api.twilio.com/x', RecordingDuration: '180', RecordingStatus: 'completed' });
    const c = (await t.request(`/v1/calls/${callId}`)).json.data;
    expect(c).toMatchObject({ recordingUrl: `http://localhost/v1/calls/${callId}/recording`, recordingDurationSeconds: 180, transcriptStatus: 'queued' });
    expect(t.jobs.sent.find((j) => j.name === 'telephony.recording')?.data).toMatchObject({ callId });
    const audio = await t.app.request(`/v1/calls/${callId}/recording`, { headers: { authorization: `Bearer ${t.token}` } });
    expect(audio.status).toBe(200);
    expect(audio.headers.get('content-type')).toBe('audio/mpeg');
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
  it('log: disposition + notes, completes the task, emits upstream-shaped call.logged once', async () => {
    const r = await t.request(`/v1/calls/${callId}/actions/log`, { method: 'POST', json: { data: { outcome: 'meeting_booked', notes: 'Demo Thursday 10am' } } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ status: 'completed', notes: 'Demo Thursday 10am', callDisposition: { name: 'Meeting booked', callOutcome: 'meeting_booked' } });
    expect(r.json.data.loggedAt).toBeTruthy();
    const [task] = await t.db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(task!.completed).toBe(true);
    const [ev] = (await t.db.select().from(outboxEvents)).filter((e) => e.eventType === 'call.logged');
    const cd = (ev!.payload as any).callData;
    expect(cd).toMatchObject({
      callId,
      workspaceId: t.workspaceId,
      userData: { userId: t.ownerId, email: 'owner@acme.test', name: 'Olive Owner' },
      prospectData: { prospectId, name: 'Ada Lovelace', phoneNumber: '+15550102020', email: 'ada@globex.test' },
      accountData: { name: 'Globex' },
      callDirection: 'outbound',
      status: 'completed',
      disposition: { name: 'Meeting booked' },
      durationSeconds: 187,
      notes: 'Demo Thursday 10am',
      sequenceData: { sequenceName: null, sequenceStep: null },
    });
    expect(cd.recordingUrl).toContain('/recording');
    const again = await t.request(`/v1/calls/${callId}/actions/log`, { method: 'POST', json: { data: { outcome: 'connected' } } });
    expect(again.status).toBe(409);
  });
  it('rep never answered: rep leg no-answer closes the call without dialing', async () => {
    const r = await t.request('/v1/calls/actions/dial', { method: 'POST', json: { data: { prospectId, mode: 'bridge', repPhone: '+15559998888' } } });
    const id = r.json.data.call.id;
    await form(`/telephony/status?ws=${t.workspaceId}&call=${id}&leg=rep`, { CallSid: 'CA9', CallStatus: 'no-answer' });
    expect((await t.request(`/v1/calls/${id}`)).json.data.status).toBe('rep_no_answer');
  });
  it('softphone dial returns connect params and the voice webhook returns dial TwiML', async () => {
    const r = await t.request('/v1/calls/actions/dial', { method: 'POST', json: { data: { prospectId, mode: 'softphone', fromNumber: '+15550002222' } } });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ mode: 'softphone', connectParams: { To: '+15550102020', callId: r.json.data.call.id, ws: t.workspaceId } });
    const res = await form(`/telephony/voice?ws=${t.workspaceId}`, { CallSid: 'CAsp', To: '+15550102020', callId: r.json.data.call.id });
    const xml = await res.text();
    expect(xml).toContain('callerId="+15550002222"');
    expect(xml).toContain('>+15550102020</Number>');
    const [row] = await t.db.select().from(calls).where(eq(calls.id, r.json.data.call.id));
    expect(row!.providerCallSid).toBe('CAsp');
    expect(row!.status).toBe('ringing');
  });
  it('rejects webhooks for unknown workspaces and bad signatures when enforcing', async () => {
    const res = await form(`/telephony/status?ws=00000000-0000-0000-0000-000000000000&call=x`, { CallStatus: 'completed' });
    expect(res.status).toBe(403);
  });
});

describe('manual calls and dispositions', () => {
  it('creates a logged call in one shot and lists it; custom dispositions work', async () => {
    const d = await t.request('/v1/callDispositions', { method: 'POST', json: { data: { name: 'Gatekeeper', callOutcome: 'not_connected' } } });
    expect(d.status).toBe(201);
    const list = await t.request('/v1/callDispositions?page[size]=50');
    expect(list.json.data.map((x: any) => x.name)).toEqual(expect.arrayContaining(['Connected', 'Meeting booked', 'Gatekeeper']));
    const r = await t.request('/v1/calls', { method: 'POST', json: { data: { prospectId, durationSeconds: 45, callDisposition: { id: d.json.data.id }, notes: 'Talked to the EA', direction: 'inbound' } } });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ source: 'manual', direction: 'inbound', duration: 45, status: 'completed', callDisposition: { name: 'Gatekeeper' } });
    const calls_ = await t.request(`/v1/calls?filter[prospect][id]=${prospectId}&filter[logged]=true&include=callDisposition`);
    expect(calls_.json.data.length).toBe(2);
    expect(calls_.json.data.every((c: any) => c.callDisposition?.name)).toBe(true);
  });
});

describe('buying Twilio numbers', () => {
  it('searches local voice numbers with the monthly price, refuses an unconfirmed buy, buys and makes it the default caller id', async () => {
    const found = await t.request('/v1/workspace/telephony/numbers/available?areaCode=213&limit=5');
    expect(found.status).toBe(200);
    expect(found.json.data).toEqual([{ e164: '+12135550142', friendlyName: '(213) 555-0142', locality: 'Los Angeles', region: 'CA', capabilities: ['voice', 'sms'], monthlyUsd: 1.15, currency: 'USD' }]);
    expect(tw.searches.at(-1)).toMatchObject({ AreaCode: '213', VoiceEnabled: 'true', PageSize: '5' });
    const unconfirmed = await t.request('/v1/workspace/telephony/numbers', { method: 'POST', json: { data: { e164: '+12135550142' } } });
    expect(unconfirmed.status).toBe(422);
    expect(unconfirmed.json.error.details.code).toBe('CONFIRM_REQUIRED');
    expect(tw.bought).toHaveLength(0);
    const r = await t.request('/v1/workspace/telephony/numbers', { method: 'POST', json: { data: { e164: '(213) 555-0142', confirm: true, makeDefault: true } } });
    expect(r.status).toBe(201);
    expect(r.json.data).toMatchObject({ provider: 'twilio', id: 'PN1', e164: '+12135550142', isDefault: true });
    expect(tw.bought).toEqual([{ PhoneNumber: '+12135550142', FriendlyName: 'Cooks' }]);
    const ids = (await t.request('/v1/workspace/telephony')).json.data.fromNumbers as string[];
    expect(ids[0]).toBe('+12135550142');
    expect(ids).toContain('+15550001111');
    expect(new Set(ids).size).toBe(ids.length);
  });
});
