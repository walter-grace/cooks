// Stand-in for Twilio Voice + an OpenAI-compatible speech-to-text server, for local QA.
// Usage: node scripts/qa/mock-twilio.mjs [port=18100] [cooksBase=http://localhost:8080]
// Run the API/worker with TWILIO_API_BASE=http://127.0.0.1:18100 and TRANSCRIBE_API_BASE=http://127.0.0.1:18100/v1
// Accepts any Account SID with auth token "qa-auth-token". Calls.create auto-plays the call back into Cooks:
// rep answers → fetches the bridge TwiML → prospect rings/answers/completes → recording callback.
// Parallel dialer legs (AsyncAmd=true) play a scenario chosen by the last digit of the number (see playProspectLeg).
// With SPEECH_PROVIDER=mock on the API, answered legs also fork synthetic audio + a scripted transcript to the speech gate.
import http from 'node:http';
import { createHmac } from 'node:crypto';
const port = Number(process.argv[2] ?? 18100);
const cooks = (process.argv[3] ?? 'http://localhost:8080').replace(/\/+$/, '');
const calls = new Map();
let n = 0;
// SIDs must never repeat across mock restarts: Cooks dedupes carrier callbacks by SID and would ignore a replay.
const RUN = Date.now().toString(36).slice(-5);
const newSid = () => `CAmock${RUN}x${++n}`;

function stereoWav(seconds = 6, rate = 8000) {
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const l = t < seconds / 2 ? Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000) : 0;
    const r = t >= seconds / 2 ? Math.round(Math.sin(2 * Math.PI * 300 * t) * 8000) : 0;
    data.writeInt16LE(l, i * 4);
    data.writeInt16LE(r, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const AUTH_TOKEN = 'qa-auth-token';
const sign = (url, params) => createHmac('sha1', AUTH_TOKEN).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
const post = async (url, params) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(url, params) }, body: new URLSearchParams(params).toString() });
  if (!res.ok) console.log(`mock-twilio: callback ${new URL(url).pathname} → ${res.status}`);
  return res;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- media streams (speech gate) */
// μ-law encoder for the synthetic line audio we fork to Cooks' speech gate.
function mulaw(sample) {
  const BIAS = 0x84, CLIP = 32635;
  let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1);
  return ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff;
}
// One 20 ms frame (160 samples at 8 kHz): silence, "speech" (band-limited noise with a vowel-ish hum) or a 1 kHz beep.
function frame(kind, i) {
  const b = Buffer.alloc(160);
  for (let n = 0; n < 160; n++) {
    const t = (i * 160 + n) / 8000;
    let v = 0;
    if (kind === 'speech') v = 6000 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) + (Math.random() - 0.5) * 5000;
    else if (kind === 'beep') v = 9000 * Math.sin(2 * Math.PI * 1000 * t);
    else v = (Math.random() - 0.5) * 60;
    b[n] = mulaw(v);
  }
  return b;
}
// What each scenario sounds like after pickup: [fromMs, toMs, kind] segments, plus the words the mock recognizer "hears" (atMs relative to pickup).
const SOUND = {
  human: { segs: [[0, 300, 'silence'], [300, 900, 'speech'], [900, 60000, 'silence']], script: [{ atMs: 520, text: 'Hello' }, { atMs: 820, text: 'Hello?', final: true }] },
  'human-slow': { segs: [[0, 400, 'silence'], [400, 1300, 'speech'], [1300, 60000, 'silence']], script: [{ atMs: 700, text: 'Yeah this is' }, { atMs: 1250, text: 'Yeah, this is Sam.', final: true }] },
  machine: { segs: [[0, 300, 'silence'], [300, 6500, 'speech'], [6500, 6900, 'beep'], [6900, 60000, 'silence']], script: [{ atMs: 700, text: 'Hi you' }, { atMs: 1000, text: "Hi, you've reached Dana" }, { atMs: 1600, text: "Hi, you've reached Dana's phone, please leave a message", final: false }] },
};
const parseStream = (twiml) => {
  const m = /<Stream url="([^"]+)"[^>]*>([\s\S]*?)<\/Stream>/.exec(twiml);
  if (!m) return null;
  const params = {};
  for (const pm of m[2].matchAll(/<Parameter name="([^"]+)" value="([^"]*)"\/>/g)) params[pm[1]] = pm[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  return { url: m[1].replace(/&amp;/g, '&'), params };
};
// Fork a leg's audio to the speech gate the way Twilio Media Streams does: connected → start → 20 ms media frames → stop.
async function streamLeg(sid, spec, scenario, leg) {
  const sound = SOUND[scenario] ?? SOUND.human;
  const ws = new WebSocket(spec.url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('stream connect failed')); });
  const streamSid = `MZ${sid.slice(2)}`;
  let seq = 0;
  const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ ...o, streamSid, sequenceNumber: String(++seq) }));
  send({ event: 'connected', protocol: 'Call', version: '1.0.0' });
  send({ event: 'start', start: { streamSid, callSid: sid, accountSid: 'ACmock', tracks: ['inbound'], mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 }, customParameters: { ...spec.params, qaScript: JSON.stringify(sound.script) } } });
  leg.stream = ws;
  const started = Date.now();
  let i = 0;
  ws.onclose = () => { leg.stream = null; console.log(`mock-twilio: ${sid} stream closed by Cooks after ${Date.now() - started} ms`); };
  while (ws.readyState === WebSocket.OPEN && leg.state !== 'ended') {
    const ms = i * 20;
    const kind = sound.segs.find(([a, b]) => ms >= a && ms < b)?.[2] ?? 'silence';
    send({ event: 'media', media: { track: 'inbound', chunk: String(i + 1), timestamp: String(ms), payload: frame(kind, i).toString('base64') } });
    i += 1;
    // pace at real time so Cooks' latency numbers mean something
    const ahead = started + (i + 1) * 20 - Date.now();
    if (ahead > 0) await sleep(ahead);
  }
  if (ws.readyState === WebSocket.OPEN) { send({ event: 'stop', stop: { accountSid: 'ACmock', callSid: sid } }); ws.close(); }
}

async function playCall(sid, p) {
  const wsCall = new URL(p.Url);
  const status = (leg, s, extra = {}) => post(`${cooks}/telephony/status?${new URLSearchParams({ ws: wsCall.searchParams.get('ws'), call: wsCall.searchParams.get('call'), leg })}`, { CallSid: sid, CallStatus: s, ...extra });
  await sleep(800);
  await status('rep', 'ringing');
  await sleep(800);
  await status('rep', 'in-progress');
  const twiml = await (await post(p.Url, { CallSid: sid, CallStatus: 'in-progress' })).text();
  const m = twiml.match(/<Number statusCallback="([^"]+)"[^>]*>([^<]+)<\/Number>/);
  const rec = twiml.match(/recordingStatusCallback="([^"]+)"/);
  if (!m) return console.log('mock-twilio: no <Dial> in TwiML, hanging up');
  const prospectCb = m[1].replace(/&amp;/g, '&');
  await sleep(500);
  await post(prospectCb, { CallSid: `${sid}p`, CallStatus: 'ringing' });
  await sleep(1200);
  await post(prospectCb, { CallSid: `${sid}p`, CallStatus: 'in-progress' });
  await sleep(2500);
  await post(prospectCb, { CallSid: `${sid}p`, CallStatus: 'completed', CallDuration: '47' });
  await status('rep', 'completed', { CallDuration: '52' });
  if (rec) {
    await sleep(700);
    await post(rec[1].replace(/&amp;/g, '&'), { RecordingSid: `RE${sid.slice(2)}`, RecordingUrl: `http://127.0.0.1:${port}/rec`, RecordingDuration: '6', RecordingStatus: 'completed', RecordingChannels: '2' });
  }
  console.log(`mock-twilio: call ${sid} to ${m[2]} completed`);
}

/* ---------------------------------------------------------------- parallel dialer */
// Scenario is picked by the last digit of the dialed number:
//   …1 human (answers fast)   …2 answering machine   …3 no answer   …4 busy   …5 human (answers slowly)   other: human
const legs = new Map(); // sid → { kind, params, state, statusCb, amdCb, voiceUrl, conference }
const conferences = new Map(); // CF sid → { sid, name, statusCb, participants: Map<callSid,label>, seq }
let confN = 0;
const parseConference = (twiml) => {
  const m = /<Conference([^>]*)>([^<]+)<\/Conference>/.exec(twiml);
  if (!m) return null;
  const attr = (k) => (new RegExp(`${k}="([^"]*)"`).exec(m[1]) ?? [])[1]?.replace(/&amp;/g, '&');
  return { name: m[2], statusCb: attr('statusCallback'), label: attr('participantLabel'), startOnEnter: attr('startConferenceOnEnter') !== 'false', endOnExit: attr('endConferenceOnExit') === 'true' };
};
const confFor = (name, statusCb) => {
  for (const c of conferences.values()) if (c.name === name) return c;
  const c = { sid: `CFmock${++confN}`, name, statusCb, participants: new Map(), seq: 0, started: false };
  conferences.set(c.sid, c);
  return c;
};
const confEvent = (c, event, extra = {}) => (c.statusCb ? post(c.statusCb, { ConferenceSid: c.sid, FriendlyName: c.name, StatusCallbackEvent: event, SequenceNumber: String(++c.seq), ...extra }) : Promise.resolve());
async function joinConference(sid, twiml) {
  const spec = parseConference(twiml);
  if (!spec) return;
  const c = confFor(spec.name, spec.statusCb);
  const leg = legs.get(sid);
  leg.conference = c.sid;
  leg.state = 'in-conference';
  if (spec.startOnEnter && !c.started) {
    c.started = true;
    await confEvent(c, 'conference-start');
  }
  c.participants.set(sid, spec.label ?? '');
  await confEvent(c, 'participant-join', { CallSid: sid, ParticipantLabel: spec.label ?? '' });
  console.log(`mock-twilio: ${spec.label ?? sid} joined ${c.name}`);
}
async function leaveConference(sid) {
  const leg = legs.get(sid);
  const c = leg?.conference ? conferences.get(leg.conference) : null;
  if (!c || !c.participants.has(sid)) return;
  const label = c.participants.get(sid);
  c.participants.delete(sid);
  await confEvent(c, 'participant-leave', { CallSid: sid, ParticipantLabel: label });
  if (label === 'rep') await endConference(c);
}
async function endConference(c) {
  if (c.ended) return;
  c.ended = true;
  for (const [sid] of [...c.participants]) {
    c.participants.delete(sid);
    const leg = legs.get(sid);
    if (leg && leg.state !== 'ended') await hangupLeg(sid, 'completed');
  }
  await confEvent(c, 'conference-end');
  console.log(`mock-twilio: conference ${c.name} ended`);
}
async function hangupLeg(sid, status, extra = {}) {
  const l0 = legs.get(sid);
  if (l0?.stream && l0.stream.readyState === WebSocket.OPEN) { l0.stream.close(); l0.stream = null; }
  const leg = legs.get(sid);
  if (!leg || leg.state === 'ended') return;
  const was = leg.state;
  leg.state = 'ended';
  console.log(`mock-twilio: ${sid} hangup (${status}) from state ${was}`);
  if (was === 'in-conference') await leaveConference(sid);
  const dur = leg.answeredAt ? String(Math.max(1, Math.round((Date.now() - leg.answeredAt) / 1000))) : '0';
  if (leg.statusCb) await post(leg.statusCb, { CallSid: sid, CallStatus: status, CallDuration: dur, ...extra });
}
async function updateLeg(sid, leg, p) {
  if (p.Status === 'canceled') return hangupLeg(sid, leg.answeredAt ? 'completed' : 'canceled');
  if (p.Status === 'completed') return hangupLeg(sid, 'completed');
  if (p.Twiml) {
    if (/<Conference/.test(p.Twiml)) return joinConference(sid, p.Twiml);
    if (/<Hangup/.test(p.Twiml)) {
      await sleep(/<Say>/.test(p.Twiml) ? 1500 : 100);
      return hangupLeg(sid, 'completed');
    }
  }
}
async function playRepLeg(sid, p) {
  legs.set(sid, { kind: 'rep', params: p, state: 'ringing', statusCb: p.StatusCallback });
  await sleep(600);
  await post(p.StatusCallback, { CallSid: sid, CallStatus: 'ringing' });
  await sleep(900);
  const leg = legs.get(sid);
  if (leg.state === 'ended') return;
  leg.state = 'answered';
  leg.answeredAt = Date.now();
  await post(p.StatusCallback, { CallSid: sid, CallStatus: 'in-progress' });
  const twiml = await (await post(p.Url, { CallSid: sid, CallStatus: 'in-progress' })).text();
  if (/<Conference/.test(twiml)) await joinConference(sid, twiml);
  else await hangupLeg(sid, 'completed');
}
async function playProspectLeg(sid, p) {
  const digit = p.To.slice(-1);
  const scenario = { 1: 'human', 2: 'machine', 3: 'no-answer', 4: 'busy', 5: 'human-slow' }[digit] ?? 'human';
  legs.set(sid, { kind: 'prospect', params: p, state: 'ringing', statusCb: p.StatusCallback, amdCb: p.AsyncAmdStatusCallback });
  console.log(`mock-twilio: ${sid} → ${p.To} (${scenario})`);
  await sleep(500);
  await post(p.StatusCallback, { CallSid: sid, CallStatus: 'ringing' });
  const leg = legs.get(sid);
  if (scenario === 'no-answer') {
    await sleep(Math.min(Number(p.Timeout ?? 25), 8) * 1000);
    return hangupLeg(sid, 'no-answer');
  }
  if (scenario === 'busy') {
    await sleep(1200);
    return hangupLeg(sid, 'busy');
  }
  await sleep(scenario === 'human-slow' ? 4500 : 1800);
  if (leg.state === 'ended') return;
  leg.state = 'answered';
  leg.answeredAt = Date.now();
  await post(p.StatusCallback, { CallSid: sid, CallStatus: 'in-progress' });
  const twiml = await (await post(p.Url, { CallSid: sid, CallStatus: 'in-progress' })).text();
  if (!/<Pause/.test(twiml)) {
    // Cooks hung up at answer (race already over)
    await sleep(/<Say>/.test(twiml) ? 1500 : 200);
    return hangupLeg(sid, 'completed');
  }
  // Speech gate: when the hold TwiML forks audio to Cooks, stream the scenario's sound in real time.
  const stream = parseStream(twiml);
  if (stream) streamLeg(sid, stream, scenario, leg).catch((e) => console.log('mock-twilio: media stream failed', e.message));
  // Carrier AMD verdict latency: real Twilio needs ~2.4 s of speech plus a pause, so a person's "Hello?" takes ~3 s to call.
  await sleep(scenario === 'machine' ? 2600 : 3000);
  if (leg.state === 'ended') return;
  await post(p.AsyncAmdStatusCallback, { CallSid: sid, AnsweredBy: scenario === 'machine' ? 'machine_start' : 'human', MachineDetectionDuration: scenario === 'machine' ? '2600' : '3000' });
  // A connected human talks for up to 45 s unless the rep hangs up first; the hold TwiML otherwise expires.
  await sleep(45_000);
  if (legs.get(sid)?.state !== 'ended') await hangupLeg(sid, 'completed');
}

const transcripts = { rep: [{ start: 0, end: 1.2, text: 'Hi Ada, this is Dana from Cooks. Do you have a minute?' }, { start: 1.8, end: 2.6, text: 'What does your outreach stack look like today?' }, { start: 4.1, end: 5.2, text: 'Makes sense. Would Thursday at ten work for a short demo?' }], prospect: [{ start: 1.2, end: 1.7, text: 'Sure, go ahead.' }, { start: 2.7, end: 4.0, text: 'Mostly spreadsheets, honestly it is a mess. Can you show me?' }, { start: 5.3, end: 6.0, text: 'Thursday works.' }] };

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://x`);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const auth = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
    console.log('mock-twilio:', req.method, url.pathname);
    const json = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    // speech-to-text (no auth)
    if (url.pathname === '/v1/audio/transcriptions') {
      const name = /filename="([^"]+)"/.exec(body.toString('latin1'))?.[1] ?? '';
      return json({ segments: name.startsWith('prospect') ? transcripts.prospect : transcripts.rep });
    }
    if (url.pathname === '/rec') { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(stereoWav()); }
    if (!auth.endsWith(':qa-auth-token')) return json({ code: 20003, message: 'Authenticate' }, 401);
    if (/^\/2010-04-01\/Accounts\/[^/]+\.json$/.test(url.pathname)) return json({ sid: 'ACmock', friendly_name: 'Cooks QA', status: 'active' });
    if (url.pathname.endsWith('/IncomingPhoneNumbers.json') && req.method === 'POST') {
      const p = Object.fromEntries(new URLSearchParams(body.toString()));
      return json({ sid: `PN${Date.now()}`, phone_number: p.PhoneNumber, friendly_name: p.FriendlyName }, 201);
    }
    if (url.pathname.endsWith('/IncomingPhoneNumbers.json')) return json({ incoming_phone_numbers: [{ phone_number: '+15550001111' }, { phone_number: '+15550002222' }] });
    if (/\/AvailablePhoneNumbers\/[A-Z]{2}\/Local\.json$/.test(url.pathname)) {
      const area = url.searchParams.get('AreaCode') ?? '555';
      return json({ available_phone_numbers: ['0142', '0187', '0199'].map((x) => ({ phone_number: `+1${area}555${x}`, friendly_name: `(${area}) 555-${x}`, locality: 'Mock City', region: 'CA', capabilities: { voice: true, SMS: true, MMS: false } })) });
    }
    if (url.pathname.endsWith('/Calls.json')) {
      const p = Object.fromEntries(new URLSearchParams(body.toString()));
      const sid = newSid();
      calls.set(sid, p);
      if (p.AsyncAmd === 'true') playProspectLeg(sid, p).catch((e) => console.log('mock-twilio: prospect leg failed', e.message));
      else if ((p.Url ?? '').includes('/telephony/parallel/rep/voice')) playRepLeg(sid, p).catch((e) => console.log('mock-twilio: rep leg failed', e.message));
      else playCall(sid, p).catch((e) => console.log('mock-twilio: playback failed', e.message));
      return json({ sid, status: 'queued' }, 201);
    }
    // Parallel dialer: call updates (redirect into the conference, cancel, complete), recordings, conference end.
    let m = /\/Calls\/(CA\w+)\/Recordings(?:\/[\w.]+)?\.json$/.exec(url.pathname);
    if (m) return json({ sid: `REmock${m[1]}`, status: 'in-progress' }, 201);
    m = /\/Calls\/(CA\w+)\.json$/.exec(url.pathname);
    if (m && req.method === 'POST') {
      const p = Object.fromEntries(new URLSearchParams(body.toString()));
      const leg = legs.get(m[1]);
      if (!leg) return json({ code: 20404, message: 'not found' }, 404);
      updateLeg(m[1], leg, p).catch((e) => console.log('mock-twilio: update failed', e.message));
      return json({ sid: m[1], status: p.Status ?? 'in-progress' });
    }
    m = /\/Conferences\/(CF\w+)\.json$/.exec(url.pathname);
    if (m) {
      const conf = conferences.get(m[1]);
      if (conf) endConference(conf).catch(() => undefined);
      return json({ sid: m[1], status: 'completed' });
    }
    if (/\/Recordings\/RE\w+\.wav$/.test(url.pathname)) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(stereoWav()); }
    if (/\/Recordings\/RE\w+\.mp3$/.test(url.pathname)) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(stereoWav()); }
    json({ message: `unhandled ${url.pathname}` }, 404);
  })
  .listen(port, () => console.log(`mock twilio + stt on :${port} → ${cooks}`));
