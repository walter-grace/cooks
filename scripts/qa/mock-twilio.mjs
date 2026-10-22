// Stand-in for Twilio Voice + an OpenAI-compatible speech-to-text server, for local QA.
// Usage: node scripts/qa/mock-twilio.mjs [port=18100] [cooksBase=http://localhost:8080]
// Run the API/worker with TWILIO_API_BASE=http://127.0.0.1:18100 and TRANSCRIBE_API_BASE=http://127.0.0.1:18100/v1
// Accepts any Account SID with auth token "qa-auth-token". Calls.create auto-plays the call back into Cooks:
// rep answers → fetches the bridge TwiML → prospect rings/answers/completes → recording callback.
import http from 'node:http';
import { createHmac } from 'node:crypto';
const port = Number(process.argv[2] ?? 18100);
const cooks = (process.argv[3] ?? 'http://localhost:8080').replace(/\/+$/, '');
const calls = new Map();
let n = 0;

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
const post = (url, params) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sign(url, params) }, body: new URLSearchParams(params).toString() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    if (url.pathname.endsWith('/IncomingPhoneNumbers.json')) return json({ incoming_phone_numbers: [{ phone_number: '+15550001111' }, { phone_number: '+15550002222' }] });
    if (url.pathname.endsWith('/Calls.json')) {
      const p = Object.fromEntries(new URLSearchParams(body.toString()));
      const sid = `CAmock${++n}`;
      calls.set(sid, p);
      playCall(sid, p).catch((e) => console.log('mock-twilio: playback failed', e.message));
      return json({ sid, status: 'queued' }, 201);
    }
    if (/\/Recordings\/RE\w+\.wav$/.test(url.pathname)) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(stereoWav()); }
    if (/\/Recordings\/RE\w+\.mp3$/.test(url.pathname)) { res.writeHead(200, { 'content-type': 'audio/wav' }); return res.end(stereoWav()); }
    json({ message: `unhandled ${url.pathname}` }, 404);
  })
  .listen(port, () => console.log(`mock twilio + stt on :${port} → ${cooks}`));
