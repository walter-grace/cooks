/**
 * Dial (api.getdial.ai): phone numbers for AI agents, with AI-voiced outbound calls. Fetch-based
 * client, no SDK. The API key is held in memory only and never appears in errors, logs or responses.
 */
import { DialerError, type CallOutcome, type CallScript, type DialerProvider, type PlaceCallInput, type PlaceCallResult, type ProviderCallState, type RecordingRef, type TranscriptEntry } from './types.js';

export interface DialClientOpts {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export const DIAL_DEFAULT_API_BASE = 'https://api.getdial.ai';
/** Dial's call API takes 60 to 3600 seconds; free accounts are clamped to 300 by Dial itself. */
export const DIAL_MIN_CALL_SECONDS = 60;

/** Rep-facing explanations for the codes Dial documents. Anything else falls back to Dial's own message. */
export const DIAL_ERROR_MESSAGES: Record<string, string> = {
  insufficient_credit: 'Your Dial balance is too low for this call. Add credit at getdial.ai/dashboard/billing and try again.',
  unsupported_region: 'Dial cannot call this number: the destination is outside the regions it supports.',
  calling_disabled: 'Calling is switched off for this Dial number. Turn it on in the Dial dashboard or pick another caller id.',
  call_limit_reached: 'Dial is at its concurrent-call limit for this account (two calls on a free account). Wait for a call to end, or top up.',
  idempotency_conflict: 'Dial already holds a different call under this request key. Place the call again.',
  UNAUTHORIZED: 'Dial rejected the API key. Check it under Settings → Dialer.',
};

type Json = Record<string, unknown>;

export interface DialNumber {
  id: string;
  number: string;
  nickname?: string | null;
  capabilities?: string[];
  callingEnabled?: boolean;
  country?: string | null;
  status?: string | null;
}
export interface DialAccount {
  id: string;
  email?: string;
  role?: string;
  maxCallDurationSeconds?: number | null;
  /** Free-account guardrails; null once the account has paid. */
  limits?: { maxCallDurationSeconds?: number; maxConcurrentCalls?: number } | null;
}
export interface DialTranscriptTurn {
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}
export interface DialCall {
  id: string;
  phoneNumberId?: string;
  from?: string;
  to?: string;
  direction?: string;
  status?: { state?: string; terminationType?: string | null; label?: string; cancelRequested?: boolean; cancelPending?: boolean } | string;
  duration?: number | null;
  transcript?: string | null;
  transcriptTurns?: DialTranscriptTurn[] | null;
  voiceRuntime?: string | null;
  failureReason?: string | null;
  transferTo?: string | null;
  transferredAt?: string | null;
  createdAt?: string;
}

export class DialClient {
  private base: string;
  private f: typeof fetch;
  constructor(
    private apiKey: string,
    opts: DialClientOpts = {},
  ) {
    this.base = (opts.apiBase ?? DIAL_DEFAULT_API_BASE).replace(/\/+$/, '');
    this.f = opts.fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, opts: { idempotencyKey?: string; allow404?: boolean } = {}): Promise<{ status: number; json: T }> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.idempotencyKey ? { 'idempotency-key': opts.idempotencyKey } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
    } catch (e) {
      throw new DialerError('dial', 'NETWORK', `Could not reach Dial: ${(e as Error).message}`, 503, true);
    }
    const text = await res.text().catch(() => '');
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { error: text.slice(0, 200) };
    }
    if (res.ok || (opts.allow404 && res.status === 404)) return { status: res.status, json: json as T };
    // Dial answers `{ error: "message", code: "x" }`; validation failures nest `{ error: { code, message } }`.
    const nested = typeof json.error === 'object' && json.error ? (json.error as Json) : null;
    const code = String(json.code ?? nested?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : `HTTP_${res.status}`));
    const upstream = typeof json.error === 'string' ? json.error : typeof nested?.message === 'string' ? nested.message : typeof json.message === 'string' ? json.message : `Dial ${res.status}`;
    const friendly = DIAL_ERROR_MESSAGES[code] ?? upstream;
    const retryable = res.status === 429 || res.status >= 500;
    throw new DialerError('dial', code, friendly, res.status, retryable, { upstream });
  }

  async account(): Promise<DialAccount> {
    return (await this.req<DialAccount>('GET', '/api/v1/account')).json;
  }
  /** Proves the key works and reports the free-tier limits, if any. */
  async verify(): Promise<{ balanceUsd: number | null; limits: NonNullable<DialAccount['limits']> | null }> {
    const a = await this.account();
    const b = await this.balance().catch(() => ({ balanceUsd: null }));
    return { balanceUsd: b.balanceUsd, limits: a.limits ?? null } as { balanceUsd: number | null; limits: NonNullable<DialAccount['limits']> | null };
  }
  /** Prepaid balance from the billing endpoint (cents). */
  async balance(): Promise<{ balanceUsd: number | null; currency: string; updatedAt?: string | null }> {
    const r = await this.req<Json>('GET', '/api/v1/billing');
    const cents = typeof r.json.balanceCents === 'number' ? r.json.balanceCents : null;
    return { balanceUsd: cents === null ? null : Math.round(cents) / 100, currency: 'USD', updatedAt: null };
  }
  async listNumbers(): Promise<DialNumber[]> {
    const r = await this.req<{ numbers?: DialNumber[] } | DialNumber[]>('GET', '/api/v1/numbers');
    return Array.isArray(r.json) ? r.json : (r.json.numbers ?? []);
  }
  async placeCall(body: Json, idempotencyKey: string): Promise<DialCall> {
    const r = await this.req<{ call?: DialCall } & DialCall>('POST', '/api/v1/calls', body, { idempotencyKey });
    return r.json.call ?? r.json;
  }
  async getCall(id: string): Promise<DialCall> {
    const r = await this.req<{ call?: DialCall } & DialCall>('GET', `/api/v1/calls/${encodeURIComponent(id)}`);
    return r.json.call ?? r.json;
  }
  /** Cancels a queued or ringing call (not charged) or hangs up a live one. */
  async stopCall(id: string): Promise<DialCall> {
    const r = await this.req<{ call?: DialCall } & DialCall>('POST', `/api/v1/calls/${encodeURIComponent(id)}/stop`, {});
    return r.json.call ?? r.json;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Dial takes one prompt per call, so the opening line and the voicemail policy fold into the instruction. */
export function dialInstruction(s: CallScript): string {
  const parts = [s.systemPrompt?.trim() || 'You are a polite assistant placing a short outbound call.'];
  if (s.firstMessage?.trim()) parts.push(`Open the call with exactly this line, then listen: "${s.firstMessage.trim()}"`);
  if (s.onMachine === 'hangup') parts.push('If you reach voicemail or an answering machine, hang up without leaving a message.');
  else if (s.onMachine === 'leave_message' && s.voicemailMessage?.trim()) parts.push(`If you reach voicemail, leave this message and hang up: "${s.voicemailMessage.trim()}"`);
  return parts.join('\n\n');
}

/** Map Dial's call object onto the provider-neutral state. Dial reports no cost, summary or recording per call. */
export function dialCallState(call: DialCall): ProviderCallState {
  const st = typeof call.status === 'object' && call.status ? call.status : { state: typeof call.status === 'string' ? call.status : undefined };
  const state = (str(st.state) ?? '').toLowerCase();
  const term = str(st.terminationType)?.toLowerCase() ?? null;
  const ended = state === 'terminated';
  const status: ProviderCallState['status'] = ended ? 'ended' : state === 'in-progress' || state === 'in_progress' ? 'in_progress' : state === 'ringing' ? 'ringing' : 'queued';
  const base = call.createdAt ? new Date(call.createdAt).getTime() : 0;
  const transcript: TranscriptEntry[] = (call.transcriptTurns ?? []).map((t, i) => ({
    index: i,
    role: t.speaker === 'agent' ? 'agent' : 'user',
    text: t.text ?? '',
    startedAt: new Date(base + (num(t.startMs) ?? 0)).toISOString(),
    endedAt: new Date(base + (num(t.endMs) ?? num(t.startMs) ?? 0)).toISOString(),
  }));
  const durationSeconds = num(call.duration);
  let outcome: CallOutcome | null = null;
  if (ended) {
    if (term === 'completed') outcome = transcript.some((t) => t.role === 'user') || (durationSeconds ?? 0) > 0 ? 'answered' : 'no_answer';
    else if (term === 'no-answer') outcome = 'no_answer';
    else outcome = 'failed'; // busy, failed, canceled, blocked
  }
  const endReason = ended ? [term, str(call.failureReason)].filter(Boolean).join(': ') || 'terminated' : null;
  return {
    status,
    outcome,
    contact: ended ? (outcome === 'answered' ? 'connected' : outcome === 'no_answer' ? 'no_answer' : 'not_connected') : null,
    durationSeconds,
    costUsd: null,
    transcript,
    summary: null,
    endReason,
    endedAt: null,
    recordingStatus: 'none',
    raw: call,
  };
}

export class DialProvider implements DialerProvider {
  readonly kind = 'dial' as const;
  constructor(public client: DialClient) {}

  async placeCall(i: PlaceCallInput): Promise<PlaceCallResult> {
    const s: CallScript = i.script ?? {};
    if (!i.from) throw new DialerError('dial', 'NO_FROM_NUMBER', 'Pick a Dial number as the caller id under Settings → Dialer', 422);
    const gender = s.voice === 'male' || s.voice === 'female' ? s.voice : undefined;
    const body: Json = {
      to: i.to,
      fromNumber: i.from,
      outboundInstruction: dialInstruction(s),
      maxCallDurationSeconds: Math.min(3600, Math.max(DIAL_MIN_CALL_SECONDS, Math.round(i.maxDurationSeconds))),
      ...(s.language ? { language: s.language } : {}),
      ...(gender ? { voiceGender: gender } : {}),
    };
    const r = await this.client.placeCall(body, `cooks-${i.callId}`);
    if (!r.id) throw new DialerError('dial', 'NO_CALL_ID', 'Dial accepted the call but returned no call id', 502, true);
    return { providerCallId: r.id, status: 'queued', raw: r };
  }
  async getCall(id: string): Promise<ProviderCallState> {
    return dialCallState(await this.client.getCall(id));
  }
  async getRecording(): Promise<RecordingRef | null> {
    return null;
  }
  async hangup(id: string): Promise<void> {
    try {
      await this.client.stopCall(id);
    } catch (e) {
      if (e instanceof DialerError && (e.status === 400 || e.status === 404)) return; // already ended
      throw e;
    }
  }
}
