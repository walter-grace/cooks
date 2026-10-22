/**
 * Speko (api.speko.dev): AI-voiced outbound calls. Fetch-based client, no SDK. The API key is
 * held in memory only and never appears in errors, logs or responses.
 */
import { DialerError, type CallOutcome, type CallScript, type DialerProvider, type PlaceCallInput, type PlaceCallResult, type ProviderCallState, type RecordingRef, type TranscriptEntry } from './types.js';

export interface SpekoClientOpts {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export const SPEKO_DEFAULT_API_BASE = 'https://api.speko.dev';

/** Rep-facing explanations for the codes Speko documents. Anything else falls back to Speko's own message. */
export const SPEKO_ERROR_MESSAGES: Record<string, string> = {
  INSUFFICIENT_CREDITS: 'Your Speko balance is too low for this. Add credits at platform.speko.ai and try again.',
  PHONE_NUMBER_KYB_ACCESS_SUSPENDED: 'Speko has suspended phone access for your organization until business verification (KYB) is complete. Finish verification in the Speko dashboard.',
  PHONE_NUMBER_CONSENT_REQUIRED: 'This Speko number needs the calling consent and declaration on file before it can place calls. Complete that step in the Speko dashboard.',
  PHONE_NUMBER_PROVISIONING_CREDITS_REQUIRED: 'Buying a number needs credits on your Speko balance for the setup fee and the first month. Add credits and try again.',
  PHONE_NUMBER_PRICE_CONFIRMATION_REQUIRED: 'This number costs more than the standard price. Confirm the quoted setup and monthly price to buy it.',
  PHONE_NUMBER_PRICE_NOT_SUPPORTED: 'Speko cannot sell this number: it is premium-rate, outside the US and Canada, or no longer available.',
  PHONE_NUMBER_PRICE_REQUIRES_DASHBOARD: 'This number must be bought from the Speko dashboard.',
  PHONE_NUMBER_NOT_FOUND: 'Speko does not know this phone number. Pick one of your Speko numbers as the caller id.',
  MISSING_TEMPLATE_VARIABLES: 'The call script references a {{variable}} that has no value.',
  RING_TIMEOUT_OUT_OF_RANGE: 'Ring timeout must be between 20 and 45 seconds.',
  UNAUTHORIZED: 'Speko rejected the API key. Check it under Settings → Dialer.',
  authentication_failed: 'Speko rejected the API key. Check it under Settings → Dialer.',
};

type Json = Record<string, unknown>;

export interface SpekoPhoneNumber {
  id: string;
  e164: string;
  label?: string | null;
  direction?: string;
  source?: string;
  setupStatus?: { status: string; outboundReady?: boolean; issues?: string[] };
  nextChargeAt?: string | null;
  suspensionReason?: string | null;
}
export interface SpekoAvailableNumber {
  e164: string;
  friendlyName: string;
  monthlyCostUsd: number;
  upfrontCostUsd: number;
  aboveStandardPrice?: boolean;
  features?: string[];
  region?: string | null;
}

export class SpekoClient {
  private base: string;
  private f: typeof fetch;
  constructor(
    private apiKey: string,
    opts: SpekoClientOpts = {},
  ) {
    this.base = (opts.apiBase ?? SPEKO_DEFAULT_API_BASE).replace(/\/+$/, '');
    this.f = opts.fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, opts: { allow404?: boolean } = {}): Promise<{ status: number; json: T }> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
    } catch (e) {
      throw new DialerError('speko', 'NETWORK', `Could not reach Speko: ${(e as Error).message}`, 503, true);
    }
    const text = await res.text().catch(() => '');
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { error: text.slice(0, 200) };
    }
    if (res.ok || (opts.allow404 && res.status === 404)) return { status: res.status, json: json as T };
    // Speko uses `{ error: "msg", code: "X" }` on most endpoints and `{ error: { code, message } }` on a few.
    const nested = typeof json.error === 'object' && json.error ? (json.error as Json) : null;
    const code = String(json.code ?? nested?.code ?? (res.status === 401 ? 'UNAUTHORIZED' : `HTTP_${res.status}`));
    const upstream = typeof json.error === 'string' ? json.error : typeof nested?.message === 'string' ? nested.message : typeof json.message === 'string' ? json.message : `Speko ${res.status}`;
    const friendly = SPEKO_ERROR_MESSAGES[code] ?? upstream;
    const retryable = json.retryable === true || res.status === 429 || res.status >= 500;
    const details: Json = {};
    for (const k of ['feeUsd', 'requiredUsd', 'availableUsd', 'hint', 'docs_url']) if (json[k] !== undefined) details[k] = json[k];
    throw new DialerError('speko', code, friendly, res.status, retryable, { upstream, ...details });
  }

  /** Cheapest authenticated read; proves the key works. */
  async verify(): Promise<{ balanceUsd: number | null }> {
    return this.balance();
  }

  /** Prepaid balance. Tries the credits endpoint first, then the usage summary which carries `balanceUsd` too. */
  async balance(): Promise<{ balanceUsd: number | null; currency: string; updatedAt?: string | null }> {
    const a = await this.req<Json>('GET', '/v1/credits/balance', undefined, { allow404: true });
    if (a.status !== 404 && typeof a.json.balanceUsd === 'number') return { balanceUsd: a.json.balanceUsd, currency: String(a.json.currency ?? 'USD'), updatedAt: (a.json.updatedAt as string) ?? null };
    const b = await this.req<Json>('GET', '/v1/usage', undefined, { allow404: true });
    if (b.status !== 404 && typeof b.json.balanceUsd === 'number') return { balanceUsd: b.json.balanceUsd, currency: String(b.json.currency ?? 'USD'), updatedAt: null };
    // Neither endpoint available: fall back to a phone-number list purely as an auth check.
    await this.req('GET', '/v1/phone-numbers');
    return { balanceUsd: null, currency: 'USD', updatedAt: null };
  }

  async placeCall(body: Json): Promise<{ sessionId: string; status: string; from?: string; to?: string }> {
    const r = await this.req<{ sessionId: string; status: string; from?: string; to?: string }>('POST', '/v1/sessions/phone', body);
    return r.json;
  }
  async getCall(id: string): Promise<Json> {
    return (await this.req<Json>('GET', `/v1/calls/${encodeURIComponent(id)}`)).json;
  }
  async endCall(id: string): Promise<{ ok: boolean; status: string }> {
    return (await this.req<{ ok: boolean; status: string }>('POST', `/v1/calls/${encodeURIComponent(id)}/end`)).json;
  }
  async recordingUrl(id: string): Promise<string | null> {
    const r = await this.req<{ url?: string }>('GET', `/v1/calls/${encodeURIComponent(id)}/recording`, undefined, { allow404: true });
    return r.status === 404 ? null : (r.json.url ?? null);
  }
  async listNumbers(): Promise<SpekoPhoneNumber[]> {
    const r = await this.req<SpekoPhoneNumber[] | { data?: SpekoPhoneNumber[] }>('GET', '/v1/phone-numbers');
    return Array.isArray(r.json) ? r.json : (r.json.data ?? []);
  }
  async searchNumbers(q: { country?: string; areaCode?: string; numberType?: string; locality?: string; state?: string; limit?: number }): Promise<SpekoAvailableNumber[]> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const r = await this.req<SpekoAvailableNumber[] | { data?: SpekoAvailableNumber[] }>('GET', `/v1/phone-numbers/available${qs.size ? `?${qs}` : ''}`);
    return Array.isArray(r.json) ? r.json : (r.json.data ?? []);
  }
  /** PAID. Callers must have shown the price and received an explicit confirmation. */
  async buyNumber(body: { e164: string; direction?: 'inbound' | 'outbound' | 'both'; label?: string; expectedUpfrontCostUsd?: number; expectedMonthlyCostUsd?: number }): Promise<SpekoPhoneNumber> {
    return (await this.req<SpekoPhoneNumber>('POST', '/v1/phone-numbers', body)).json;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

/** Map Speko's call detail (with its embedded report) onto the provider-neutral state. */
export function spekoCallState(detail: Json): ProviderCallState {
  const raw = (str(detail.status) ?? '').toLowerCase();
  const report = (detail.report ?? null) as Json | null;
  const endedAt = str(detail.ended_at) ?? str(detail.endedAt);
  const endReason = str(detail.end_reason) ?? str(detail.endReason) ?? str((detail.pipeline_config as Json | undefined)?.endReason);
  const ended = !!endedAt || ['ended', 'completed', 'failed', 'finalized', 'finished', 'canceled', 'cancelled'].includes(raw) || raw.startsWith('ended');
  const status: ProviderCallState['status'] = ended ? 'ended' : ['active', 'in_progress', 'in-progress', 'answered', 'connected'].includes(raw) ? 'in_progress' : ['ringing', 'dialing', 'dialing-stub'].includes(raw) ? 'ringing' : 'queued';
  const entries = ((report?.transcript as Json | undefined)?.entries ?? (detail.transcript as Json | undefined)?.entries ?? []) as Json[];
  const transcript: TranscriptEntry[] = entries.map((e, i) => ({
    index: num(e.index) ?? i,
    role: e.source === 'agent' ? 'agent' : e.source === 'system' ? 'system' : 'user',
    text: str(e.text) ?? '',
    startedAt: str(e.started_at) ?? str(e.startedAt) ?? '',
    endedAt: str(e.ended_at) ?? str(e.endedAt) ?? null,
  }));
  const durationSeconds = num(detail.duration_seconds) ?? (num(detail.recording_duration_ms) !== null ? Math.round(num(detail.recording_duration_ms)! / 1000) : null);
  const costMicro = num(report?.cost_micro_usd);
  let outcome: CallOutcome | null = null;
  if (ended) {
    const contact = str(report?.contact);
    const voicemail = report?.voicemail as Json | null | undefined;
    const vmDetected = voicemail?.detected === true || report?.outcome === 'voicemail' || endReason === 'voicemail_reached' || endReason === 'machine_unavailable';
    if (vmDetected) outcome = 'voicemail';
    else if (contact === 'connected') outcome = 'answered';
    else if (contact === 'no_answer' || contact === 'no_response' || endReason === 'sip_no_answer') outcome = 'no_answer';
    else if (contact === 'not_connected' || endReason === 'sip_busy' || raw === 'failed') outcome = 'failed';
    else outcome = transcript.some((t) => t.role === 'user') || (durationSeconds ?? 0) > 0 ? 'answered' : 'no_answer';
  }
  return {
    status,
    outcome,
    contact: str(report?.contact),
    durationSeconds,
    costUsd: costMicro !== null ? Math.round(costMicro) / 1_000_000 : null,
    transcript,
    summary: str(report?.summary),
    endReason,
    endedAt,
    recordingStatus: str(detail.recording_status),
    raw: detail,
  };
}

export class SpekoProvider implements DialerProvider {
  readonly kind = 'speko' as const;
  constructor(public client: SpekoClient) {}

  async placeCall(i: PlaceCallInput): Promise<PlaceCallResult> {
    const s: CallScript = i.script ?? {};
    const body: Json = {
      to: i.to,
      ...(i.from ? { from: i.from } : {}),
      ...(s.agentId ? { agentId: s.agentId } : { intent: { language: s.language ?? 'en-US', optimizeFor: 'balanced' } }),
      ...(s.systemPrompt ? { systemPrompt: s.systemPrompt } : {}),
      ...(s.firstMessage ? { firstMessage: s.firstMessage } : {}),
      ...(s.voice ? { voice: s.voice } : {}),
      maxDurationSeconds: i.maxDurationSeconds,
      telephony: { amd: { mode: 'agent' } },
      turnHandling: { onMachine: s.onMachine ?? 'leave_message', ...(s.voicemailMessage ? { voicemailMessage: s.voicemailMessage } : {}) },
      metadata: { cooksCallId: i.callId, ...(i.prospectId ? { prospectId: i.prospectId } : {}), ...(i.metadata ?? {}) },
      webhookTags: { source: 'cooks' },
    };
    const r = await this.client.placeCall(body);
    if (!r.sessionId) throw new DialerError('speko', 'NO_SESSION_ID', 'Speko accepted the call but returned no session id', 502, true);
    return { providerCallId: r.sessionId, status: 'queued', raw: r };
  }
  async getCall(id: string): Promise<ProviderCallState> {
    return spekoCallState(await this.client.getCall(id));
  }
  async getRecording(id: string): Promise<RecordingRef | null> {
    const url = await this.client.recordingUrl(id);
    return url ? { url, expiresAt: new Date(Date.now() + 4 * 60_000) } : null;
  }
  async hangup(id: string): Promise<void> {
    await this.client.endCall(id);
  }
}
