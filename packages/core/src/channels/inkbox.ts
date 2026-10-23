/**
 * Inkbox (inkbox.ai) client over fetch. Email, SMS/MMS, iMessage, hosted calls, identities,
 * opt-in registry and webhook subscriptions. The API key lives in memory only and never appears
 * in errors, logs or responses. Paths follow https://inkbox.ai/api/openapi.json.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const INKBOX_DEFAULT_API_BASE = 'https://inkbox.ai';

export interface InkboxClientOpts {
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, unknown>;

export class InkboxError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryable = false,
    public details?: Json,
  ) {
    super(message);
    this.name = 'InkboxError';
  }
}

/** Rep-facing explanations for the codes Inkbox documents. */
export const INKBOX_ERROR_MESSAGES: Record<string, string> = {
  recipient_not_opted_in: 'This US number has not texted START to one of your Inkbox numbers yet, so Inkbox will not deliver SMS to it (TCPA).',
  recipient_opted_out: 'This number texted STOP. Inkbox refuses texts to it from every sender in your organization.',
  sender_sms_pending: 'The Inkbox number is still being provisioned for SMS (usually 10–15 minutes after creation).',
  message_blocked_spam_filter: 'Inkbox\'s spam filter blocked this message. Rewrite it with less promotional language and fewer links.',
  invalid_receiver_number: 'That phone number is not a valid mobile destination.',
  customer_campaign_required: 'Writing opt-ins through the API needs your own 10DLC campaign on Inkbox.',
  hosted_agent_at_capacity: 'Inkbox hosted call agents are at capacity right now. Try again in a few minutes.',
  idempotency_key_reused: 'A different message was already sent with this idempotency key.',
  UNAUTHORIZED: 'Inkbox rejected the API key. Check it under Settings → Channels.',
};

export interface InkboxIdentity {
  id: string;
  agent_handle: string;
  display_name?: string | null;
  description?: string | null;
  status?: string;
  imessage_enabled?: boolean;
  email_address?: string | null;
  signing_key_configured?: boolean;
  mailbox?: { id: string; email_address: string; sending_domain?: string } | null;
  phone_number?: { id: string; number: string; country?: string; state?: string; status?: string; sms_status?: string | null } | null;
  imessage_number?: { id: string; number: string; type?: string; line_role?: string } | null;
}

export interface InkboxSentEmail {
  id: string;
  mailbox_id: string;
  thread_id?: string | null;
  message_id?: string | null;
  status: string;
  created_at: string;
}

export interface InkboxText {
  id: string;
  direction: 'inbound' | 'outbound';
  local_phone_number: string;
  remote_phone_number?: string | null;
  text?: string | null;
  type?: 'sms' | 'mms';
  media?: unknown[] | null;
  delivery_status?: string | null;
  error_code?: string | null;
  error_detail?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  conversation_id?: string | null;
  sender_phone_number?: string | null;
  is_blocked?: boolean;
  created_at: string;
}

export interface InkboxImessage {
  id: string;
  conversation_id: string;
  reply_to_message_id?: string | null;
  thread_id?: string | null;
  direction: 'inbound' | 'outbound';
  remote_number?: string | null;
  sender_number?: string | null;
  content?: string | null;
  service?: 'imessage' | 'sms' | 'rcs';
  status?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  media?: unknown[] | null;
  created_at: string;
}

export interface InkboxCall {
  id: string;
  local_phone_number?: string | null;
  remote_phone_number: string;
  direction: 'outbound' | 'inbound';
  status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'failed' | 'canceled';
  mode?: string;
  on_voicemail?: string | null;
  reason?: string | null;
  hangup_reason?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  created_at?: string;
  duration_seconds?: number | null;
  post_call_action_items?: Array<{ id: string; seq: number; action: string; details?: string | null; status?: string }>;
  rate_limit?: Json;
}

export interface InkboxTranscriptEntry {
  id?: string;
  seq?: number;
  ts_ms?: number;
  party: 'local' | 'remote';
  phone_number?: string | null;
  text: string;
  marker?: string;
}

export class InkboxClient {
  private base: string;
  private f: typeof fetch;
  constructor(
    private apiKey: string,
    opts: InkboxClientOpts = {},
  ) {
    this.base = (opts.apiBase ?? INKBOX_DEFAULT_API_BASE).replace(/\/+$/, '');
    this.f = opts.fetchImpl ?? fetch;
  }

  private async req<T>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, opts: { allow404?: boolean } = {}): Promise<{ status: number; json: T }> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { 'x-api-key': this.apiKey, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new InkboxError(503, 'NETWORK', `Could not reach Inkbox: ${(e as Error).message}`, true);
    }
    const text = await res.text().catch(() => '');
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = { message: text.slice(0, 200) };
    }
    if (res.ok || (opts.allow404 && res.status === 404)) return { status: res.status, json: json as T };
    // Inkbox errors: `{ detail: { code, message } }`, `{ detail: "..." }`, or `{ error, code }`.
    const detail = json.detail;
    const d = typeof detail === 'object' && detail ? (detail as Json) : null;
    const code = String(d?.code ?? json.code ?? (res.status === 401 ? 'UNAUTHORIZED' : res.status === 403 ? 'FORBIDDEN' : `HTTP_${res.status}`));
    const upstream = typeof d?.message === 'string' ? d.message : typeof detail === 'string' ? detail : typeof json.error === 'string' ? json.error : typeof json.message === 'string' ? json.message : `Inkbox ${res.status}`;
    const retryable = res.status === 429 || res.status === 503 || res.status >= 500;
    throw new InkboxError(res.status, code, INKBOX_ERROR_MESSAGES[code] ?? upstream, retryable, { upstream, retryAfter: res.headers.get('retry-after') ?? undefined });
  }

  /** Auth check: the key's own identity (agent keys) or the identity list (admin keys). */
  async verify(): Promise<{ scoped: boolean; identities: InkboxIdentity[] }> {
    const self = await this.req<InkboxIdentity | Json>('GET', '/api/v1/identities/self', undefined, {}, { allow404: true });
    if (self.status !== 404 && (self.json as InkboxIdentity).id && (self.json as InkboxIdentity).agent_handle) return { scoped: true, identities: [self.json as InkboxIdentity] };
    return { scoped: false, identities: await this.listIdentities() };
  }
  async listIdentities(): Promise<InkboxIdentity[]> {
    const r = await this.req<InkboxIdentity[] | { items?: InkboxIdentity[]; identities?: InkboxIdentity[] }>('GET', '/api/v1/identities/');
    return Array.isArray(r.json) ? r.json : (r.json.items ?? r.json.identities ?? []);
  }
  async getIdentity(handle: string): Promise<InkboxIdentity> {
    return (await this.req<InkboxIdentity>('GET', `/api/v1/identities/${encodeURIComponent(handle)}`)).json;
  }

  /** Email through an identity mailbox. `inReplyTo` threads onto an existing conversation. */
  async sendEmail(fromAddress: string, m: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text?: string; html?: string; inReplyTo?: string | null; threadId?: string | null; replyTo?: string | null; idempotencyKey?: string }): Promise<InkboxSentEmail> {
    const body = { recipients: { to: m.to, cc: m.cc ?? null, bcc: m.bcc ?? null }, subject: m.subject, body_text: m.text ?? null, body_html: m.html ?? null, in_reply_to_message_id: m.inReplyTo ?? null, thread_id: m.threadId ?? null, reply_to: m.replyTo ?? null, track_opens: false };
    return (await this.req<InkboxSentEmail>('POST', `/api/v1/mail/mailboxes/${encodeURIComponent(fromAddress)}/messages`, body, { 'idempotency-key': m.idempotencyKey ?? randomUUID(), prefer: 'idempotency-replay' })).json;
  }

  /** SMS/MMS from a dedicated number. Consent and contact rules are enforced by Inkbox at send time (403). */
  async sendText(phoneNumberId: string, m: { to?: string; conversationId?: string; text?: string; mediaUrls?: string[]; idempotencyKey?: string }): Promise<InkboxText> {
    const body = m.conversationId ? { conversation_id: m.conversationId, text: m.text ?? null, media_urls: m.mediaUrls ?? null } : { to: m.to, text: m.text ?? null, media_urls: m.mediaUrls ?? null };
    return (await this.req<InkboxText>('POST', `/api/v1/phone/numbers/${encodeURIComponent(phoneNumberId)}/texts`, body, { 'idempotency-key': m.idempotencyKey ?? randomUUID(), prefer: 'idempotency-replay' })).json;
  }

  async sendImessage(identityId: string, m: { to?: string; conversationId?: string; replyToMessageId?: string; text?: string; mediaUrls?: string[]; sendStyle?: string; idempotencyKey?: string }): Promise<{ message: InkboxImessage }> {
    const body = m.conversationId ? { conversation_id: m.conversationId, reply_to_message_id: m.replyToMessageId ?? null, text: m.text ?? null, media_urls: m.mediaUrls ?? null, send_style: m.sendStyle ?? null } : { to: m.to, text: m.text ?? null, media_urls: m.mediaUrls ?? null, send_style: m.sendStyle ?? null };
    const r = (await this.req<{ message?: InkboxImessage } & Json>('POST', `/api/v1/imessage/messages?agent_identity_id=${encodeURIComponent(identityId)}`, body, { 'idempotency-key': m.idempotencyKey ?? randomUUID(), prefer: 'idempotency-replay' })).json;
    if (r.message) return { message: r.message };
    // group / slim response shapes
    return { message: { id: String(r.message_id ?? ''), conversation_id: String(r.conversation_id ?? ''), direction: 'outbound', remote_number: typeof r.recipient === 'string' ? r.recipient : null, content: m.text ?? null, status: String(r.status ?? 'pending'), created_at: new Date().toISOString() } };
  }

  /** `"iMessage" | "SMS" | "RCS"` for a number. */
  async messagingCapability(number: string): Promise<string | null> {
    const r = await this.req<string | Json>('GET', `/api/v1/imessage/check-messaging-capability?number=${encodeURIComponent(number)}`, undefined, {}, { allow404: true });
    return typeof r.json === 'string' ? r.json : null;
  }

  /** SMS consent for a recipient under this organization (404 = no record). */
  async smsOptIn(number: string): Promise<{ status: 'opted_in' | 'opted_out'; source?: string } | null> {
    const r = await this.req<{ status: 'opted_in' | 'opted_out'; source?: string }>('GET', `/api/v1/phone/sms-opt-ins/${encodeURIComponent(number)}`, undefined, {}, { allow404: true });
    return r.status === 404 ? null : r.json;
  }
  async smsOptOut(number: string): Promise<void> {
    await this.req('POST', `/api/v1/phone/sms-opt-ins/${encodeURIComponent(number)}/opt-out`, {});
  }

  /** Outbound phone contact rules for an identity (blocks win). */
  async phoneContactRules(handle: string): Promise<Array<{ id: string; action: 'allow' | 'block'; direction: 'inbound' | 'outbound' | 'both'; match_type: string; match_target: string; status?: string }>> {
    const r = await this.req<unknown[] | { items?: unknown[] }>('GET', `/api/v1/identities/${encodeURIComponent(handle)}/phone-contact-rules`, undefined, {}, { allow404: true });
    const list = Array.isArray(r.json) ? r.json : ((r.json as { items?: unknown[] }).items ?? []);
    return list as never;
  }

  /** Hosted outbound call with a task brief. A 200 means the call is queued or dialing, not answered. */
  async placeCall(m: { fromNumber?: string | null; toNumber: string; identityId?: string | null; reason: string; onVoicemail?: 'leave_message' | 'hang_up' | 'ignore'; voicemailMessage?: string | null; authorityMode?: 'contact_scoped' | 'yolo'; idempotencyKey?: string }): Promise<InkboxCall | { call_id: string; state: string }> {
    const body: Json = { origination: 'dedicated_number', from_number: m.fromNumber ?? null, to_number: m.toNumber, agent_identity_id: m.identityId ?? null, mode: 'hosted_agent', hosted_agent_authority_mode: m.authorityMode ?? 'contact_scoped', reason: m.reason, on_voicemail: m.onVoicemail ?? 'leave_message', voicemail_message: m.voicemailMessage ?? null };
    return (await this.req<InkboxCall | { call_id: string; state: string }>('POST', '/api/v1/phone/place-call', body, { 'idempotency-key': m.idempotencyKey ?? randomUUID() })).json;
  }
  async getCall(id: string): Promise<InkboxCall> {
    return (await this.req<InkboxCall>('GET', `/api/v1/phone/calls/${encodeURIComponent(id)}`)).json;
  }
  async hangupCall(id: string): Promise<void> {
    await this.req('POST', `/api/v1/phone/calls/${encodeURIComponent(id)}/hangup`, {});
  }
  async callTranscript(id: string): Promise<InkboxTranscriptEntry[]> {
    const r = await this.req<InkboxTranscriptEntry[] | { items?: InkboxTranscriptEntry[]; entries?: InkboxTranscriptEntry[] }>('GET', `/api/v1/phone/calls/${encodeURIComponent(id)}/transcripts`, undefined, {}, { allow404: true });
    if (r.status === 404) return [];
    return Array.isArray(r.json) ? r.json : (r.json.items ?? r.json.entries ?? []);
  }

  /** Subscribe one identity to events. `signing_key` comes back only the first time an identity gets one. */
  async createSubscription(m: { identityId: string; url: string; eventTypes: string[]; authToken?: string | null }): Promise<{ id: string; signing_key?: string | null; status?: string }> {
    return (await this.req<{ id: string; signing_key?: string | null; status?: string }>('POST', '/api/v1/webhooks/subscriptions', { agent_identity_id: m.identityId, url: m.url, event_types: m.eventTypes, auth_token: m.authToken ?? null })).json;
  }
  async listSubscriptions(): Promise<Array<{ id: string; agent_identity_id?: string | null; url: string; event_types: string[]; status?: string }>> {
    const r = await this.req<{ subscriptions?: unknown[] } | unknown[]>('GET', '/api/v1/webhooks/subscriptions');
    return (Array.isArray(r.json) ? r.json : (r.json.subscriptions ?? [])) as never;
  }
  async deleteSubscription(id: string): Promise<void> {
    await this.req('DELETE', `/api/v1/webhooks/subscriptions/${encodeURIComponent(id)}`, undefined, {}, { allow404: true });
  }
  /** Create (or rotate) the identity signing key; returned once. */
  async createSigningKey(handle: string): Promise<{ signing_key?: string | null }> {
    return (await this.req<{ signing_key?: string | null }>('POST', `/api/v1/identities/${encodeURIComponent(handle)}/signing-key`, {})).json;
  }
}

/** `X-Inkbox-Signature: sha256=<hex HMAC-SHA256(signing_key, "<request_id>.<timestamp>.<raw body>")>`, 5-minute window. */
export function verifyInkboxSignature(signingKey: string, headers: { requestId?: string | null; timestamp?: string | null; signature?: string | null }, rawBody: string, now = new Date(), toleranceSeconds = 300): boolean {
  if (!headers.requestId || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > toleranceSeconds) return false;
  const expected = createHmac('sha256', signingKey).update(`${headers.requestId}.${headers.timestamp}.${rawBody}`).digest('hex');
  const got = headers.signature.replace(/^sha256=/i, '').trim().toLowerCase();
  if (got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expected, 'hex'));
}

/** Constant-time check of the subscription bearer token. */
export function verifyInkboxBearer(expected: string, header: string | null | undefined): boolean {
  const got = (header ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** STOP-family keywords (CTIA): the recipient revokes SMS consent. */
export const STOP_KEYWORDS = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt out)\b/i;
export const START_KEYWORDS = /^\s*(start|unstop|subscribe|yes|resume)\b/i;
