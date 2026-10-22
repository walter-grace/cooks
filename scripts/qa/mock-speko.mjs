// Stand-in for the Speko API (api.speko.dev) for local QA. No real calls are placed.
// Usage: node scripts/qa/mock-speko.mjs [port=18200] [cooksBase=http://localhost:8080]
// Run the API/worker with SPEKO_API_BASE=http://127.0.0.1:18200 and connect with API key "sk_live_qa".
// Each placed session auto-plays: dialing (2 s) → active (6 s) → ended with a report, transcript,
// cost and a recording, then POSTs a call.status webhook to Cooks (unsigned unless WEBHOOK_SECRET is set).
import http from 'node:http';
import { createHmac } from 'node:crypto';
const port = Number(process.argv[2] ?? 18200);
const cooks = (process.argv[3] ?? 'http://localhost:8080').replace(/\/+$/, '');
const secret = process.env.WEBHOOK_SECRET ?? '';
const KEY = 'sk_live_qa';
const sessions = new Map();
let n = 0;
let balance = 42.5;
const numbers = [{ id: 'pn1', e164: '+15550004444', label: 'Cooks QA', direction: 'both', source: 'managed', setupStatus: { status: 'ready', outboundReady: true, inboundReady: true, agentReady: true, forwardingRequired: false, forwardingSipUri: '', sipConnectionReady: true, issues: [] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), organizationId: 'org_qa' }];

function wav(seconds = 4, rate = 8000) {
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 330 * i) / rate) * 6000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transcript = (first) => [
  { id: 't1', index: 0, source: 'agent', text: first || 'Hi Ada, this is the assistant from Cooks. Do you have thirty seconds?', started_at: new Date(Date.now() + 1000).toISOString(), ended_at: new Date(Date.now() + 4000).toISOString(), metadata: {} },
  { id: 't2', index: 1, source: 'user', text: 'Sure, go ahead.', started_at: new Date(Date.now() + 4500).toISOString(), ended_at: new Date(Date.now() + 5500).toISOString(), metadata: {} },
  { id: 't3', index: 2, source: 'agent', text: 'Would Thursday at ten work for a short conversation with the team?', started_at: new Date(Date.now() + 6000).toISOString(), ended_at: new Date(Date.now() + 9000).toISOString(), metadata: {} },
  { id: 't4', index: 3, source: 'user', text: 'Thursday works. Send me an invite.', started_at: new Date(Date.now() + 9500).toISOString(), ended_at: new Date(Date.now() + 11000).toISOString(), metadata: {} },
];

async function play(id) {
  const s = sessions.get(id);
  await sleep(2000);
  if (!s.ended) s.status = 'active';
  await sleep(6000);
  end(id, 'remote_hangup');
  const ws = s.body?.metadata?.workspaceId;
  if (!ws) return;
  const body = JSON.stringify({ type: 'call.status', call_id: id, event_type: 'call.hangup', status: 'ended', failure_cause: null, metadata: s.body.metadata });
  const headers = { 'content-type': 'application/json' };
  if (secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    const idh = `msg_${id}`;
    const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
    headers['webhook-id'] = idh; headers['webhook-timestamp'] = ts; headers['webhook-signature'] = 'v1,' + createHmac('sha256', key).update(`${idh}.${ts}.${body}`).digest('base64');
  }
  await fetch(`${cooks}/telephony/speko/webhook?ws=${ws}`, { method: 'POST', headers, body }).catch(() => {});
  console.log(`mock-speko: session ${id} to ${s.body.to} ended`);
}
function end(id, reason) {
  const s = sessions.get(id);
  if (!s || s.ended) return;
  s.ended = true; s.status = 'ended'; s.ended_at = new Date().toISOString(); s.end_reason = reason;
  s.duration = Math.round((Date.now() - s.started) / 1000);
  s.cost = Math.round((s.duration / 60) * 0.18 * 1e6);
  balance = Math.round((balance - s.cost / 1e6) * 100) / 100;
}
const detail = (id) => {
  const s = sessions.get(id);
  const base = { id, call_id: id, resource_uri: `/v1/calls/${id}`, status: s.status, kind: 'phone', created_at: new Date(s.started).toISOString(), metadata: s.body.metadata ?? {} };
  if (!s.ended) return base;
  return { ...base, ended_at: s.ended_at, duration_seconds: s.duration, recording_status: 'ready', recording_duration_ms: s.duration * 1000, report: { session_id: id, summary: 'The prospect agreed to a short conversation on Thursday at ten and asked for a calendar invite.', outcome: 'scheduled', contact: 'connected', structured_data: {}, transcript: { entries: s.transcript }, cost_micro_usd: String(s.cost), cost_breakdown: [], voicemail: { detected: false, amd_verdict: 'human', delivery: null }, analysis_status: 'completed', webhook_deliveries: [] } };
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const json = (b, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    let raw = ''; for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    console.log('mock-speko:', req.method, url.pathname);
    if (url.pathname.startsWith('/rec/')) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(wav()); }
    if (req.headers.authorization !== `Bearer ${KEY}`) return json({ error: 'a Bearer authorization header is required', code: 'UNAUTHORIZED', retryable: false }, 401);
    if (url.pathname === '/v1/credits/balance') return json({ balanceUsd: balance, currency: 'USD', updatedAt: new Date().toISOString() });
    if (url.pathname === '/v1/phone-numbers' && req.method === 'GET') return json(numbers);
    if (url.pathname === '/v1/phone-numbers/available') return json([{ e164: '+14155550100', friendlyName: '(415) 555-0100', monthlyCostUsd: 2, upfrontCostUsd: 1, aboveStandardPrice: false, features: ['voice', 'sms'], region: 'CA' }, { e164: '+14155550177', friendlyName: '(415) 555-0177', monthlyCostUsd: 4.5, upfrontCostUsd: 3, aboveStandardPrice: true, features: ['voice'], region: 'CA' }]);
    if (url.pathname === '/v1/phone-numbers' && req.method === 'POST') {
      if (balance < 3) return json({ error: 'Add credits to buy a number', code: 'PHONE_NUMBER_PROVISIONING_CREDITS_REQUIRED' }, 402);
      const num = { id: `pn${numbers.length + 1}`, e164: body.e164, label: body.label ?? null, direction: body.direction ?? 'both', source: 'managed', setupStatus: { status: 'ready', outboundReady: true, inboundReady: true, agentReady: true, forwardingRequired: false, forwardingSipUri: '', sipConnectionReady: true, issues: [] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), organizationId: 'org_qa' };
      numbers.push(num); balance -= (body.expectedUpfrontCostUsd ?? 1) + (body.expectedMonthlyCostUsd ?? 2);
      return json(num);
    }
    if (url.pathname === '/v1/sessions/phone' && req.method === 'POST') {
      if (balance < 0.5) return json({ error: 'This needs at least $0.50 available. Add credits and try again.', code: 'INSUFFICIENT_CREDITS', retryable: false, availableUsd: balance }, 402);
      if (!body.to) return json({ error: 'to is required', code: 'VALIDATION' }, 400);
      const id = `sess_${Date.now().toString(36)}_${++n}`;
      sessions.set(id, { body, status: 'dialing', started: Date.now(), ended: false, transcript: transcript(body.firstMessage) });
      void play(id);
      return json({ sessionId: id, callControlId: `cc_${n}`, roomName: `room_${n}`, status: 'dialing', to: body.to, from: body.from ?? numbers[0].e164 });
    }
    const m = /^\/v1\/calls\/([^/]+)(\/[a-z]+)?$/.exec(url.pathname);
    if (m) {
      if (!sessions.has(m[1])) return json({ error: 'No session with this id in your organization', code: 'SESSION_NOT_FOUND' }, 404);
      if (m[2] === '/end') { const was = sessions.get(m[1]).ended; end(m[1], 'local_hangup'); return json(was ? { ok: true, status: 'already_ended' } : { ok: true, status: 'ending' }, was ? 200 : 202); }
      if (m[2] === '/recording') return sessions.get(m[1]).ended ? json({ url: `http://127.0.0.1:${port}/rec/${m[1]}.wav` }) : json({ error: 'no recording yet', code: 'NOT_FOUND' }, 404);
      if (!m[2]) return json(detail(m[1]));
    }
    json({ error: `unhandled ${url.pathname}`, code: 'NOT_FOUND' }, 404);
  })
  .listen(port, '127.0.0.1', () => console.log(`mock-speko listening on http://127.0.0.1:${port} (api key ${KEY}); cooks at ${cooks}`));
