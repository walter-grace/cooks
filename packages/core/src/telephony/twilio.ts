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
