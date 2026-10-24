/**
 * Minimal Twilio Voice client over fetch. No SDK: three REST calls, request signature
 * validation and the Voice access-token JWT are all small enough to own.
 * `apiBase` is injectable so tests and QA point at scripts/qa/mock-twilio.mjs.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export interface TwilioAuth {
  accountSid: string;
  authToken: string;
}

export interface TwilioClientOpts {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export class TwilioError extends Error {
  constructor(
    public status: number,
    public code: number | null,
    message: string,
  ) {
    super(message);
  }
}

/** Twilio answering-machine detection tuning (see docs/dialer.md, "Parallel dialing"). */
export interface AmdOptions {
  mode?: 'Enable' | 'DetectMessageEnd';
  /** Seconds Twilio keeps analysing before giving up with `unknown` (3–59). */
  timeoutSeconds?: number;
  /** Speech longer than this is a machine greeting (1000–6000 ms). */
  speechThresholdMs?: number;
  /** Silence after speech that ends a human greeting (500–5000 ms). */
  speechEndThresholdMs?: number;
  /** Initial silence that counts as a machine (2000–10000 ms). */
  silenceTimeoutMs?: number;
}

export class TwilioClient {
  private base: string;
  private f: typeof fetch;
  constructor(
    private auth: TwilioAuth,
    opts: TwilioClientOpts = {},
  ) {
    this.base = (opts.apiBase ?? 'https://api.twilio.com').replace(/\/+$/, '');
    this.f = opts.fetchImpl ?? fetch;
  }
  private headers(extra: Record<string, string> = {}) {
    return { authorization: `Basic ${Buffer.from(`${this.auth.accountSid}:${this.auth.authToken}`).toString('base64')}`, accept: 'application/json', ...extra };
  }
  private async form<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') body.set(k, v);
    const res = await this.f(`${this.base}/2010-04-01/Accounts/${this.auth.accountSid}${path}`, { method: 'POST', headers: this.headers({ 'content-type': 'application/x-www-form-urlencoded' }), body: body.toString() });
    const json = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
    if (!res.ok) throw new TwilioError(res.status, json.code ?? null, json.message ?? `Twilio ${res.status}`);
    return json as T;
  }
  /** Verifies credentials; returns the friendly name. */
  async account(): Promise<{ sid: string; friendlyName: string; status: string }> {
    const res = await this.f(`${this.base}/2010-04-01/Accounts/${this.auth.accountSid}.json`, { headers: this.headers() });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; friendly_name?: string; status?: string; message?: string; code?: number };
    if (!res.ok) throw new TwilioError(res.status, json.code ?? null, json.message ?? `Twilio ${res.status}`);
    return { sid: json.sid ?? this.auth.accountSid, friendlyName: json.friendly_name ?? '', status: json.status ?? 'unknown' };
  }
  /** Numbers owned by the account, for the "from" picker. */
  async incomingNumbers(): Promise<string[]> {
    const res = await this.f(`${this.base}/2010-04-01/Accounts/${this.auth.accountSid}/IncomingPhoneNumbers.json?PageSize=100`, { headers: this.headers() });
    if (!res.ok) return [];
    const json = (await res.json().catch(() => ({}))) as { incoming_phone_numbers?: Array<{ phone_number: string }> };
    return (json.incoming_phone_numbers ?? []).map((n) => n.phone_number);
  }
  /** Outbound call leg. `url` returns TwiML when the callee answers. */
  createCall(p: { to: string; from: string; url: string; statusCallback: string; machineDetection?: boolean; timeoutSeconds?: number }): Promise<{ sid: string; status: string }> {
    return this.form('/Calls.json', {
      To: p.to,
      From: p.from,
      Url: p.url,
      Method: 'POST',
      StatusCallback: p.statusCallback,
      StatusCallbackMethod: 'POST',
      StatusCallbackEvent: 'initiated ringing answered completed',
      MachineDetection: p.machineDetection ? 'Enable' : undefined,
      Timeout: String(p.timeoutSeconds ?? 25),
    });
  }
  /** One call leg's current state (status, duration), for the provider abstraction. */
  async call(sid: string): Promise<{ sid: string; status: string; duration: number | null; answeredBy: string | null }> {
    const res = await this.f(`${this.base}/2010-04-01/Accounts/${this.auth.accountSid}/Calls/${sid}.json`, { headers: this.headers() });
    const json = (await res.json().catch(() => ({}))) as { sid?: string; status?: string; duration?: string | null; answered_by?: string | null; message?: string; code?: number };
    if (!res.ok) throw new TwilioError(res.status, json.code ?? null, json.message ?? `Twilio ${res.status}`);
    return { sid: json.sid ?? sid, status: json.status ?? 'unknown', duration: json.duration ? Number(json.duration) : null, answeredBy: json.answered_by ?? null };
  }
  /** End a live leg. */
  hangup(sid: string): Promise<{ sid: string; status: string }> {
    return this.form(`/Calls/${sid}.json`, { Status: 'completed' });
  }
  /** Cancel a leg that is still queued or ringing (Twilio rejects `canceled` once answered). */
  cancel(sid: string): Promise<{ sid: string; status: string }> {
    return this.form(`/Calls/${sid}.json`, { Status: 'canceled' });
  }
  /** Redirect a live leg to new TwiML (inline) or a URL. */
  redirect(sid: string, p: { twiml?: string; url?: string }): Promise<{ sid: string; status: string }> {
    return this.form(`/Calls/${sid}.json`, p.twiml ? { Twiml: p.twiml } : { Url: p.url, Method: 'POST' });
  }
  /**
   * Outbound leg with asynchronous answering-machine detection. The call connects to `url`
   * immediately; the verdict (`AnsweredBy`) is posted to `amdCallback` a few seconds later.
   */
  createAmdCall(p: { to: string; from: string; url: string; statusCallback: string; amdCallback: string; timeoutSeconds: number; amd: AmdOptions }): Promise<{ sid: string; status: string }> {
    return this.form('/Calls.json', {
      To: p.to,
      From: p.from,
      Url: p.url,
      Method: 'POST',
      StatusCallback: p.statusCallback,
      StatusCallbackMethod: 'POST',
      StatusCallbackEvent: 'initiated ringing answered completed',
      Timeout: String(p.timeoutSeconds),
      MachineDetection: p.amd.mode ?? 'Enable',
      AsyncAmd: 'true',
      AsyncAmdStatusCallback: p.amdCallback,
      AsyncAmdStatusCallbackMethod: 'POST',
      MachineDetectionTimeout: String(p.amd.timeoutSeconds ?? 5),
      MachineDetectionSpeechThreshold: p.amd.speechThresholdMs !== undefined ? String(p.amd.speechThresholdMs) : undefined,
      MachineDetectionSpeechEndThreshold: p.amd.speechEndThresholdMs !== undefined ? String(p.amd.speechEndThresholdMs) : undefined,
      MachineDetectionSilenceTimeout: p.amd.silenceTimeoutMs !== undefined ? String(p.amd.silenceTimeoutMs) : undefined,
    });
  }
  /** Start recording a live call (dual channel: this leg left, the other party right). */
  startRecording(callSid: string, p: { statusCallback: string }): Promise<{ sid: string; status: string }> {
    return this.form(`/Calls/${callSid}/Recordings.json`, { RecordingChannels: 'dual', RecordingStatusCallback: p.statusCallback, RecordingStatusCallbackEvent: 'completed', RecordingTrack: 'both' });
  }
  stopRecording(callSid: string, recordingSid = 'Twilio.CURRENT'): Promise<{ sid: string; status: string }> {
    return this.form(`/Calls/${callSid}/Recordings/${recordingSid}.json`, { Status: 'stopped' });
  }
  /** End a conference and every participant in it. */
  endConference(conferenceSid: string): Promise<{ sid: string; status: string }> {
    return this.form(`/Conferences/${conferenceSid}.json`, { Status: 'completed' });
  }
  /** Download a recording as WAV (dual channel when recorded that way). */
  async recordingWav(recordingSid: string): Promise<Buffer> {
    const res = await this.f(`${this.base}/2010-04-01/Accounts/${this.auth.accountSid}/Recordings/${recordingSid}.wav?RequestedChannels=2`, { headers: this.headers({ accept: 'audio/wav' }) });
    if (!res.ok) throw new TwilioError(res.status, null, `recording download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
  /** Stream a recording for playback in the UI. */
  async recordingStream(recordingSid: string, format: 'mp3' | 'wav' = 'mp3'): Promise<Response> {
    return this.f(`${this.base}/2010-04-01/Accounts/${this.auth.accountSid}/Recordings/${recordingSid}.${format}`, { headers: this.headers({ accept: format === 'mp3' ? 'audio/mpeg' : 'audio/wav' }) });
  }
  async deleteRecording(recordingSid: string): Promise<void> {
    await this.f(`${this.base}/2010-04-01/Accounts/${this.auth.accountSid}/Recordings/${recordingSid}.json`, { method: 'DELETE', headers: this.headers() });
  }
}

/**
 * Twilio request signature: base64(HMAC-SHA1(authToken, url + concat(sorted(key+value)))).
 * `url` must be the public URL Twilio called, including query string.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function validateTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | null | undefined): boolean {
  if (!header) return false;
  const candidates = [url];
  // Behind proxies the scheme or a trailing slash can differ; try the common variants.
  if (url.startsWith('http://')) candidates.push(`https://${url.slice(7)}`);
  for (const u of candidates) {
    const expected = twilioSignature(authToken, u, params);
    const a = Buffer.from(expected);
    const b = Buffer.from(header);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** Voice SDK access token (HS256 JWT) for a browser softphone. Valid for `ttlSeconds` (max 24 h). */
export function voiceAccessToken(p: { accountSid: string; apiKeySid: string; apiKeySecret: string; identity: string; twimlAppSid: string; ttlSeconds?: number; now?: Date; allowIncoming?: boolean }): string {
  const now = Math.floor((p.now ?? new Date()).getTime() / 1000);
  const ttl = Math.min(Math.max(p.ttlSeconds ?? 3600, 60), 86_400);
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const header = b64({ typ: 'JWT', alg: 'HS256', cty: 'twilio-fpa;v=1' });
  const payload = b64({
    jti: `${p.apiKeySid}-${now}-${randomUUID().slice(0, 8)}`,
    iss: p.apiKeySid,
    sub: p.accountSid,
    iat: now,
    nbf: now,
    exp: now + ttl,
    grants: { identity: p.identity, voice: { incoming: { allow: p.allowIncoming ?? true }, outgoing: { application_sid: p.twimlAppSid } } },
  });
  const sig = createHmac('sha256', p.apiKeySecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

/* ---------- TwiML ---------- */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface DialTwimlOpts {
  to: string;
  callerId: string;
  record: boolean;
  recordingStatusCallback: string;
  statusCallback: string;
  timeLimitSeconds?: number;
  /** Bridge mode: a short whisper before connecting the prospect. */
  sayFirst?: string;
}

/** `<Dial>` the prospect from the rep leg (bridge) or browser leg (softphone), dual-channel recorded. */
export function dialTwiml(o: DialTwimlOpts): string {
  const rec = o.record ? ` record="record-from-answer-dual" recordingStatusCallback="${esc(o.recordingStatusCallback)}" recordingStatusCallbackEvent="completed"` : '';
  const say = o.sayFirst ? `<Say voice="Polly.Joanna">${esc(o.sayFirst)}</Say>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${say}<Dial callerId="${esc(o.callerId)}" answerOnBridge="true" timeLimit="${o.timeLimitSeconds ?? 3600}"${rec}><Number statusCallback="${esc(o.statusCallback)}" statusCallbackEvent="initiated ringing answered completed">${esc(o.to)}</Number></Dial></Response>`;
}

export interface ConferenceTwimlOpts {
  name: string;
  /** The rep starts the room and ends it when they leave; prospects join silently and never start it. */
  role: 'rep' | 'prospect';
  statusCallback?: string;
  label?: string;
  /** Seconds the leg may stay bridged (default 4 hours). */
  timeLimitSeconds?: number;
}

/** `<Dial><Conference>` with no beep, no announcement and no hold music. */
export function conferenceTwiml(o: ConferenceTwimlOpts): string {
  const rep = o.role === 'rep';
  const cb = o.statusCallback ? ` statusCallback="${esc(o.statusCallback)}" statusCallbackMethod="POST" statusCallbackEvent="start end join leave"` : '';
  const label = o.label ? ` participantLabel="${esc(o.label)}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeLimit="${o.timeLimitSeconds ?? 14_400}"><Conference beep="false" startConferenceOnEnter="${rep}" endConferenceOnExit="${rep}" waitUrl=""${cb}${label}>${esc(o.name)}</Conference></Dial></Response>`;
}

/** Silent hold while async AMD decides; falls through to a hangup so a lost callback never strands the callee. */
export const pauseTwiml = (seconds: number) => `<?xml version="1.0" encoding="UTF-8"?><Response><Pause length="${Math.max(1, Math.min(600, Math.round(seconds)))}"/><Hangup/></Response>`;

export interface StreamSpec {
  /** wss:// endpoint that receives the Media Stream (ws:// only for local mocks). */
  url: string;
  /** Delivered back in the `start` message as customParameters. */
  params: Record<string, string>;
  name?: string;
}

/**
 * Hold in silence while forking the callee's audio to our speech gate (`<Start><Stream>` returns
 * immediately, so the <Pause> still times the hold). Only the inbound track: we never hear ourselves.
 */
export function holdWithStreamTwiml(seconds: number, stream: StreamSpec): string {
  const params = Object.entries(stream.params)
    .map(([k, v]) => `<Parameter name="${esc(k)}" value="${esc(v)}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Start><Stream url="${esc(stream.url)}" name="${esc(stream.name ?? 'gate')}" track="inbound_track">${params}</Stream></Start><Pause length="${Math.max(1, Math.min(600, Math.round(seconds)))}"/><Hangup/></Response>`;
}

export const hangupTwiml = (message?: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Say>${esc(message)}</Say>` : ''}<Hangup/></Response>`;

/** E.164-ish normaliser: strips punctuation, assumes `defaultCountry` (+1) for 10-digit numbers. */
export function normalizePhone(raw: string | null | undefined, defaultCountry = '+1'): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (!digits) return null;
  if (digits.startsWith('+')) return digits.length >= 8 ? digits : null;
  if (digits.length === 10) return `${defaultCountry}${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits.length >= 8 ? `+${digits}` : null;
}
