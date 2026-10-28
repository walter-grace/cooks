import { and, eq } from 'drizzle-orm';
import { telephonyConnections, workspaces, type ParallelDialerSettings } from '@cooks/db';
import type { Ctx } from '../context.js';
import type { SpeechConfig } from './speech/providers/types.js';
import { decrypt, encrypt } from '../crypto.js';
import { insufficientPermission, unprocessable } from '../errors.js';
import { DIAL_MIN_CALL_SECONDS, DialClient, DialProvider, DialerError, SpekoClient, SpekoProvider, type DialerKind } from '../dialer/providers/index.js';
import { TwilioClient, TwilioError, normalizePhone, type TwilioClientOpts } from './twilio.js';

export type TelephonyRow = typeof telephonyConnections.$inferSelect;

/** Server-wide Twilio credentials (TWILIO_* env). Workspaces without their own connection use these. */
export interface TwilioEnv {
  accountSid?: string;
  authToken?: string;
  fromNumber?: string;
  apiKeySid?: string;
  apiKeySecret?: string;
  twimlAppSid?: string;
}

export interface TelephonyDeps extends TwilioClientOpts {
  kek?: string;
  twilioEnv?: TwilioEnv;
  /** Speech gate: streaming recognizer + optional Jev tie-breaker (server-wide, from env). */
  speech?: SpeechConfig;
  /** Server-wide Speko key and base override (mocks). Workspaces can store their own key instead. */
  speko?: { apiKey?: string; apiBase?: string };
  /** Server-wide Dial key and base override (mocks). Workspaces can store their own key instead. */
  dial?: { apiKey?: string; apiBase?: string };
}

const NO_KEK = 'COOKS_KEK is required to store telephony credentials';
const seal = (v: string, kek?: string) => (kek ? encrypt(v, kek) : `plain:${v}`);
const open = (v: string, kek?: string) => (v.startsWith('plain:') ? v.slice(6) : kek ? decrypt(v, kek) : '');
const ENV_KEY = 'env:';

const assertAdmin = (ctx: Ctx, what: string) => {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission(`Only admins can ${what}`);
};

/** The workspace's connection row for one provider (Twilio by default). Falls back to server env for Twilio. */
export async function getTelephony(ctx: Ctx, provider: DialerKind = 'twilio', d?: TelephonyDeps): Promise<TelephonyRow | null> {
  const [row] = await ctx.db
    .select()
    .from(telephonyConnections)
    .where(and(eq(telephonyConnections.workspaceId, ctx.principal.workspaceId), eq(telephonyConnections.provider, provider)))
    .limit(1);
  if (row) return row;
  if (provider === 'twilio' && d?.twilioEnv?.accountSid && d.twilioEnv.authToken) return envTelephonyRow(ctx.principal.workspaceId, d.twilioEnv);
  return null;
}

export const ENV_ROW_ID = '00000000-0000-0000-0000-00000000e9f0';
/** Synthetic connection row built from TWILIO_* env so a cloned repo works without the settings page. */
export function envTelephonyRow(workspaceId: string, e: TwilioEnv): TelephonyRow {
  const now = new Date(0);
  return {
    id: ENV_ROW_ID,
    workspaceId,
    provider: 'twilio',
    accountSid: e.accountSid!,
    authTokenEncrypted: `plain:${e.authToken!}`,
    apiKeySid: e.apiKeySid ?? null,
    apiKeySecretEncrypted: e.apiKeySecret ? `plain:${e.apiKeySecret}` : null,
    twimlAppSid: e.twimlAppSid ?? null,
    fromNumbers: e.fromNumber ? [normalizePhone(e.fromNumber) ?? e.fromNumber] : [],
    record: true,
    transcribe: true,
    coach: true,
    settings: {},
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ Twilio */

export function serializeTelephony(row: TelephonyRow | null) {
  if (!row) return { provider: null, status: 'disconnected' as const, source: null as 'workspace' | 'server' | null, accountSid: null, fromNumbers: [] as string[], softphone: false, record: true, transcribe: true, coach: true, updatedAt: null };
  return {
    provider: row.provider,
    status: 'connected' as const,
    source: row.id === ENV_ROW_ID ? ('server' as const) : ('workspace' as const),
    accountSid: row.accountSid,
    accountSidLast4: row.accountSid.slice(-4),
    fromNumbers: row.fromNumbers,
    /** Browser calling needs an API key pair + TwiML app; bridge mode works with just the auth token. */
    softphone: !!(row.apiKeySid && row.apiKeySecretEncrypted && row.twimlAppSid),
    record: row.record,
    transcribe: row.transcribe,
    coach: row.coach,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ConnectTelephonyInput {
  accountSid: string;
  authToken: string;
  apiKeySid?: string | null;
  apiKeySecret?: string | null;
  twimlAppSid?: string | null;
  fromNumbers?: string[];
  record?: boolean;
  transcribe?: boolean;
  coach?: boolean;
}

/** Store Twilio credentials after verifying them; discovers owned numbers when none are given. */
export async function connectTelephony(ctx: Ctx, input: ConnectTelephonyInput, d: TelephonyDeps) {
  assertAdmin(ctx, 'connect telephony');
  const existingRow = await getTelephony(ctx, 'twilio');
  if (!d.kek && process.env.NODE_ENV === 'production') throw unprocessable(NO_KEK);
  const client = new TwilioClient({ accountSid: input.accountSid.trim(), authToken: input.authToken.trim() }, d);
  try {
    await client.account();
  } catch (e) {
    if (e instanceof TwilioError && (e.status === 401 || e.status === 403 || e.status === 404)) throw unprocessable('Twilio rejected the Account SID / Auth Token');
    throw e;
  }
  let numbers = (input.fromNumbers ?? []).map((n) => normalizePhone(n)).filter((n): n is string => !!n);
  if (!numbers.length) numbers = await client.incomingNumbers();
  const existing = existingRow;
  const values = {
    workspaceId: ctx.principal.workspaceId,
    provider: 'twilio',
    accountSid: input.accountSid.trim(),
    authTokenEncrypted: seal(input.authToken.trim(), d.kek),
    apiKeySid: input.apiKeySid?.trim() || null,
    apiKeySecretEncrypted: input.apiKeySecret ? seal(input.apiKeySecret.trim(), d.kek) : null,
    twimlAppSid: input.twimlAppSid?.trim() || null,
    fromNumbers: numbers,
    record: input.record ?? existing?.record ?? true,
    transcribe: input.transcribe ?? existing?.transcribe ?? true,
    coach: input.coach ?? existing?.coach ?? true,
    updatedAt: ctx.clock.now(),
  };
  const [row] = existing
    ? await ctx.db.update(telephonyConnections).set(values).where(eq(telephonyConnections.id, existing.id)).returning()
    : await ctx.db.insert(telephonyConnections).values(values).returning();
  await ensureDialerProvider(ctx, 'twilio');
  return serializeTelephony(row!);
}

export async function updateTelephonySettings(ctx: Ctx, patch: { fromNumbers?: string[]; record?: boolean; transcribe?: boolean; coach?: boolean }) {
  assertAdmin(ctx, 'change telephony settings');
  const existing = await getTelephony(ctx, 'twilio');
  if (!existing) throw unprocessable('Telephony is not connected (or comes from TWILIO_* server env; paste credentials under Settings → Dialer to change settings)');
  const [row] = await ctx.db
    .update(telephonyConnections)
    .set({ ...(patch.fromNumbers ? { fromNumbers: patch.fromNumbers.map((n) => normalizePhone(n)).filter((n): n is string => !!n) } : {}), ...(patch.record !== undefined ? { record: patch.record } : {}), ...(patch.transcribe !== undefined ? { transcribe: patch.transcribe } : {}), ...(patch.coach !== undefined ? { coach: patch.coach } : {}), updatedAt: ctx.clock.now() })
    .where(eq(telephonyConnections.id, existing.id))
    .returning();
  return serializeTelephony(row!);
}

export async function disconnectTelephony(ctx: Ctx) {
  assertAdmin(ctx, 'disconnect telephony');
  await ctx.db.delete(telephonyConnections).where(and(eq(telephonyConnections.workspaceId, ctx.principal.workspaceId), eq(telephonyConnections.provider, 'twilio')));
  await clearDialerProviderIf(ctx, 'twilio');
}

/** Decrypted credentials + client for a workspace, or null when not connected. */
export async function telephonyFor(ctx: Ctx, d: TelephonyDeps): Promise<{ row: TelephonyRow; client: TwilioClient; authToken: string; apiKey: { sid: string; secret: string } | null } | null> {
  const row = await getTelephony(ctx, 'twilio', d);
  if (!row) return null;
  const authToken = open(row.authTokenEncrypted, d.kek);
  const apiKey = row.apiKeySid && row.apiKeySecretEncrypted ? { sid: row.apiKeySid, secret: open(row.apiKeySecretEncrypted, d.kek) } : null;
  return { row, client: new TwilioClient({ accountSid: row.accountSid, authToken }, d), authToken, apiKey };
}

export async function requireTelephony(ctx: Ctx, d: TelephonyDeps) {
  const t = await telephonyFor(ctx, d);
  if (!t) throw unprocessable('Connect Twilio under Settings → Dialer first', { code: 'NO_TELEPHONY' });
  return t;
}

/* ------------------------------------------------------------------- Speko */

/** Hard ceiling on one AI call, whatever the workspace asks for. */
export const MAX_AI_CALL_SECONDS = 600;

export interface SpekoSettings {
  fromNumber?: string | null;
  systemPrompt?: string;
  firstMessage?: string;
  maxDurationSeconds?: number;
  dailySpendCapUsd?: number;
  language?: string;
  voice?: string | null;
  agentId?: string | null;
  onMachine?: 'hangup' | 'leave_message' | 'agent_decides';
  voicemailMessage?: string | null;
  /** Standard Webhooks signing secret for /telephony/speko/webhook, encrypted. Never serialized. */
  webhookSecretEncrypted?: string | null;
}

export const SPEKO_DEFAULTS: Required<Pick<SpekoSettings, 'systemPrompt' | 'firstMessage' | 'maxDurationSeconds' | 'dailySpendCapUsd' | 'language' | 'onMachine'>> = {
  systemPrompt:
    'You are {{ owner.name }}\'s assistant calling on behalf of {{ workspace.name }}. You are speaking with {{ prospect.firstName }}, {{ prospect.title }} at {{ account.name }}. Be brief and warm. Say you are an AI assistant if asked. Goal: find out whether they are open to a 15 minute conversation with {{ owner.name }} this week, and if so, which day works. If they are not interested, thank them and end the call. Never promise pricing or discounts.',
  firstMessage: 'Hi {{ prospect.firstName }}, this is {{ owner.name }}\'s assistant at {{ workspace.name }}. Do you have thirty seconds?',
  maxDurationSeconds: 120,
  dailySpendCapUsd: 20,
  language: 'en-US',
  onMachine: 'leave_message',
};

export function spekoSettingsOf(row: TelephonyRow | null): Required<Omit<SpekoSettings, 'fromNumber' | 'voice' | 'agentId' | 'voicemailMessage' | 'webhookSecretEncrypted'>> & SpekoSettings {
  const s = (row?.settings ?? {}) as SpekoSettings;
  return { ...SPEKO_DEFAULTS, ...s, maxDurationSeconds: Math.min(s.maxDurationSeconds ?? SPEKO_DEFAULTS.maxDurationSeconds, MAX_AI_CALL_SECONDS) };
}

export function serializeSpeko(row: TelephonyRow | null, serverKey: boolean) {
  if (!row) return { provider: 'speko' as const, status: 'disconnected' as const, keySource: null as 'workspace' | 'server' | null, keyLast4: null as string | null, fromNumbers: [] as string[], settings: { ...SPEKO_DEFAULTS, fromNumber: null }, webhookConfigured: false, serverKeyAvailable: serverKey, record: true, transcribe: true, coach: true, updatedAt: null as string | null };
  const s = spekoSettingsOf(row);
  const { webhookSecretEncrypted, ...settings } = s;
  return {
    provider: 'speko' as const,
    status: 'connected' as const,
    keySource: row.authTokenEncrypted === ENV_KEY ? ('server' as const) : ('workspace' as const),
    keyLast4: row.accountSid.length >= 4 && row.authTokenEncrypted !== ENV_KEY ? row.accountSid.slice(-4) : null,
    fromNumbers: row.fromNumbers,
    settings: { ...settings, fromNumber: s.fromNumber ?? row.fromNumbers[0] ?? null, maxAllowedSeconds: MAX_AI_CALL_SECONDS },
    webhookConfigured: !!webhookSecretEncrypted,
    serverKeyAvailable: serverKey,
    record: row.record,
    transcribe: row.transcribe,
    coach: row.coach,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ConnectSpekoInput extends Omit<SpekoSettings, 'webhookSecretEncrypted'> {
  /** Omit to use the server's SPEKO_API_KEY. */
  apiKey?: string | null;
  webhookSecret?: string | null;
  coach?: boolean;
}

const spekoClient = (key: string, d: TelephonyDeps) => new SpekoClient(key, { apiBase: d.speko?.apiBase, fetchImpl: d.fetchImpl });

/** Store a Speko key after verifying it and discover the organization's numbers. */
export async function connectSpeko(ctx: Ctx, input: ConnectSpekoInput, d: TelephonyDeps) {
  assertAdmin(ctx, 'connect Speko');
  if (!d.kek && process.env.NODE_ENV === 'production') throw unprocessable(NO_KEK);
  const key = input.apiKey?.trim() || d.speko?.apiKey;
  if (!key) throw unprocessable('Paste a Speko API key (or set SPEKO_API_KEY on the server)', { field: 'apiKey' });
  const client = spekoClient(key, d);
  let balance: { balanceUsd: number | null } = { balanceUsd: null };
  try {
    balance = await client.verify();
  } catch (e) {
    if (e instanceof DialerError && (e.status === 401 || e.status === 403)) throw unprocessable('Speko rejected the API key', { field: 'apiKey' });
    throw e;
  }
  const numbers = await client.listNumbers().catch(() => []);
  const fromNumbers = numbers.filter((n) => !n.setupStatus || n.setupStatus.outboundReady !== false).map((n) => normalizePhone(n.e164) ?? n.e164);
  const existing = await getTelephony(ctx, 'speko');
  const prev = (existing?.settings ?? {}) as SpekoSettings;
  const { apiKey: _k, webhookSecret, coach, ...rest } = input;
  const settings: SpekoSettings = { ...prev, ...stripUndefined(rest), ...(webhookSecret !== undefined ? { webhookSecretEncrypted: webhookSecret ? seal(webhookSecret.trim(), d.kek) : null } : {}) };
  if (settings.fromNumber) settings.fromNumber = normalizePhone(settings.fromNumber) ?? settings.fromNumber;
  if (settings.maxDurationSeconds) settings.maxDurationSeconds = Math.min(Math.max(30, settings.maxDurationSeconds), MAX_AI_CALL_SECONDS);
  const values = {
    workspaceId: ctx.principal.workspaceId,
    provider: 'speko',
    /** Not a real account id: Speko keys are organization-scoped. Keep the key's tail for display. */
    accountSid: input.apiKey ? `speko-${key.slice(-4)}` : 'speko-server',
    authTokenEncrypted: input.apiKey ? seal(key, d.kek) : ENV_KEY,
    fromNumbers,
    record: true,
    transcribe: false,
    coach: coach ?? existing?.coach ?? true,
    settings: settings as Record<string, unknown>,
    updatedAt: ctx.clock.now(),
  };
  const [row] = existing
    ? await ctx.db.update(telephonyConnections).set(values).where(eq(telephonyConnections.id, existing.id)).returning()
    : await ctx.db.insert(telephonyConnections).values(values).returning();
  await ensureDialerProvider(ctx, 'speko');
  return { ...serializeSpeko(row!, !!d.speko?.apiKey), balanceUsd: balance.balanceUsd };
}

const stripUndefined = <T extends Record<string, unknown>>(o: T): Partial<T> => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export async function updateSpekoSettings(ctx: Ctx, patch: Omit<SpekoSettings, 'webhookSecretEncrypted'> & { webhookSecret?: string | null; coach?: boolean; fromNumbers?: string[] }, d: TelephonyDeps) {
  assertAdmin(ctx, 'change Speko settings');
  const existing = await getTelephony(ctx, 'speko');
  if (!existing) throw unprocessable('Speko is not connected');
  const prev = (existing.settings ?? {}) as SpekoSettings;
  const { webhookSecret, coach, fromNumbers, ...rest } = patch;
  const settings: SpekoSettings = { ...prev, ...stripUndefined(rest), ...(webhookSecret !== undefined ? { webhookSecretEncrypted: webhookSecret ? seal(webhookSecret.trim(), d.kek) : null } : {}) };
  if (settings.fromNumber) settings.fromNumber = normalizePhone(settings.fromNumber) ?? settings.fromNumber;
  if (settings.maxDurationSeconds !== undefined) settings.maxDurationSeconds = Math.min(Math.max(30, settings.maxDurationSeconds), MAX_AI_CALL_SECONDS);
  if (settings.dailySpendCapUsd !== undefined) settings.dailySpendCapUsd = Math.max(0, settings.dailySpendCapUsd);
  const [row] = await ctx.db
    .update(telephonyConnections)
    .set({ settings: settings as Record<string, unknown>, ...(coach !== undefined ? { coach } : {}), ...(fromNumbers ? { fromNumbers: fromNumbers.map((n) => normalizePhone(n)).filter((n): n is string => !!n) } : {}), updatedAt: ctx.clock.now() })
    .where(eq(telephonyConnections.id, existing.id))
    .returning();
  return serializeSpeko(row!, !!d.speko?.apiKey);
}

export async function disconnectSpeko(ctx: Ctx) {
  assertAdmin(ctx, 'disconnect Speko');
  await ctx.db.delete(telephonyConnections).where(and(eq(telephonyConnections.workspaceId, ctx.principal.workspaceId), eq(telephonyConnections.provider, 'speko')));
  await clearDialerProviderIf(ctx, 'speko');
}

export interface SpekoHandle {
  kind: 'speko';
  row: TelephonyRow;
  client: SpekoClient;
  provider: SpekoProvider;
  settings: ReturnType<typeof spekoSettingsOf>;
  webhookSecret: string | null;
}

export async function spekoFor(ctx: Ctx, d: TelephonyDeps): Promise<SpekoHandle | null> {
  const row = await getTelephony(ctx, 'speko');
  if (!row) return null;
  const key = row.authTokenEncrypted === ENV_KEY ? d.speko?.apiKey : open(row.authTokenEncrypted, d.kek);
  if (!key) return null;
  const client = spekoClient(key, d);
  const settings = spekoSettingsOf(row);
  return { kind: 'speko', row, client, provider: new SpekoProvider(client), settings, webhookSecret: settings.webhookSecretEncrypted ? open(settings.webhookSecretEncrypted, d.kek) : null };
}

export async function requireSpeko(ctx: Ctx, d: TelephonyDeps): Promise<SpekoHandle> {
  const s = await spekoFor(ctx, d);
  if (!s) throw unprocessable('Connect Speko under Settings → Dialer first', { code: 'NO_SPEKO' });
  return s;
}

/* -------------------------------------------------------------------- Dial */

export type AiDialerKind = 'speko' | 'dial';
export const AI_DIALERS: readonly AiDialerKind[] = ['speko', 'dial'];
export const isAiDialer = (k: unknown): k is AiDialerKind => k === 'speko' || k === 'dial';
export const DIALER_LABEL: Record<DialerKind, string> = { twilio: 'Twilio', speko: 'Speko', dial: 'Dial' };

/** Same settings shape as Speko; `voice` holds Dial's `male` or `female`, `agentId` and the webhook secret are unused. */
export type DialSettings = Omit<SpekoSettings, 'webhookSecretEncrypted' | 'agentId'>;
export const DIAL_DEFAULTS = SPEKO_DEFAULTS;

export function dialSettingsOf(row: TelephonyRow | null): Required<Omit<DialSettings, 'fromNumber' | 'voice' | 'voicemailMessage'>> & DialSettings {
  const s = (row?.settings ?? {}) as DialSettings;
  return { ...DIAL_DEFAULTS, ...s, maxDurationSeconds: Math.min(Math.max(DIAL_MIN_CALL_SECONDS, s.maxDurationSeconds ?? DIAL_DEFAULTS.maxDurationSeconds), MAX_AI_CALL_SECONDS) };
}

export function serializeDial(row: TelephonyRow | null, serverKey: boolean) {
  if (!row) return { provider: 'dial' as const, status: 'disconnected' as const, keySource: null as 'workspace' | 'server' | null, keyLast4: null as string | null, fromNumbers: [] as string[], settings: { ...DIAL_DEFAULTS, fromNumber: null, maxAllowedSeconds: MAX_AI_CALL_SECONDS, minSeconds: DIAL_MIN_CALL_SECONDS }, serverKeyAvailable: serverKey, record: false, transcribe: false, coach: true, updatedAt: null as string | null };
  const s = dialSettingsOf(row);
  return {
    provider: 'dial' as const,
    status: 'connected' as const,
    keySource: row.authTokenEncrypted === ENV_KEY ? ('server' as const) : ('workspace' as const),
    keyLast4: row.accountSid.length >= 4 && row.authTokenEncrypted !== ENV_KEY ? row.accountSid.slice(-4) : null,
    fromNumbers: row.fromNumbers,
    settings: { ...s, fromNumber: s.fromNumber ?? row.fromNumbers[0] ?? null, maxAllowedSeconds: MAX_AI_CALL_SECONDS, minSeconds: DIAL_MIN_CALL_SECONDS },
    serverKeyAvailable: serverKey,
    record: row.record,
    transcribe: row.transcribe,
    coach: row.coach,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ConnectDialInput extends DialSettings {
  /** Omit to use the server's DIAL_API_KEY. */
  apiKey?: string | null;
  coach?: boolean;
}

const dialClient = (key: string, d: TelephonyDeps) => new DialClient(key, { apiBase: d.dial?.apiBase, fetchImpl: d.fetchImpl });

const normalizeDialSettings = (settings: DialSettings) => {
  if (settings.fromNumber) settings.fromNumber = normalizePhone(settings.fromNumber) ?? settings.fromNumber;
  if (settings.maxDurationSeconds !== undefined) settings.maxDurationSeconds = Math.min(Math.max(DIAL_MIN_CALL_SECONDS, settings.maxDurationSeconds), MAX_AI_CALL_SECONDS);
  if (settings.dailySpendCapUsd !== undefined) settings.dailySpendCapUsd = Math.max(0, settings.dailySpendCapUsd);
  return settings;
};

/** Store a Dial key after verifying it and discover the account's numbers that can place calls. */
export async function connectDial(ctx: Ctx, input: ConnectDialInput, d: TelephonyDeps) {
  assertAdmin(ctx, 'connect Dial');
  if (!d.kek && process.env.NODE_ENV === 'production') throw unprocessable(NO_KEK);
  const key = input.apiKey?.trim() || d.dial?.apiKey;
  if (!key) throw unprocessable('Paste a Dial API key (or set DIAL_API_KEY on the server)', { field: 'apiKey' });
  const client = dialClient(key, d);
  let verified: { balanceUsd: number | null; limits: { maxCallDurationSeconds?: number; maxConcurrentCalls?: number } | null } = { balanceUsd: null, limits: null };
  try {
    verified = await client.verify();
  } catch (e) {
    if (e instanceof DialerError && (e.status === 401 || e.status === 403)) throw unprocessable('Dial rejected the API key', { field: 'apiKey' });
    throw e;
  }
  const numbers = await client.listNumbers().catch(() => []);
  const fromNumbers = numbers.filter((n) => n.callingEnabled !== false && (!n.capabilities || n.capabilities.includes('call'))).map((n) => normalizePhone(n.number) ?? n.number);
  const existing = await getTelephony(ctx, 'dial');
  const prev = (existing?.settings ?? {}) as DialSettings;
  const { apiKey: _k, coach, ...rest } = input;
  const settings = normalizeDialSettings({ ...prev, ...stripUndefined(rest) });
  const values = {
    workspaceId: ctx.principal.workspaceId,
    provider: 'dial',
    /** Not a real account id: Dial keys are account-scoped. Keep the key's tail for display. */
    accountSid: input.apiKey ? `dial-${key.slice(-4)}` : 'dial-server',
    authTokenEncrypted: input.apiKey ? seal(key, d.kek) : ENV_KEY,
    fromNumbers,
    record: false,
    transcribe: false,
    coach: coach ?? existing?.coach ?? true,
    settings: settings as Record<string, unknown>,
    updatedAt: ctx.clock.now(),
  };
  const [row] = existing
    ? await ctx.db.update(telephonyConnections).set(values).where(eq(telephonyConnections.id, existing.id)).returning()
    : await ctx.db.insert(telephonyConnections).values(values).returning();
  await ensureDialerProvider(ctx, 'dial');
  return { ...serializeDial(row!, !!d.dial?.apiKey), balanceUsd: verified.balanceUsd, limits: verified.limits };
}

export async function updateDialSettings(ctx: Ctx, patch: DialSettings & { coach?: boolean; fromNumbers?: string[] }, d: TelephonyDeps) {
  assertAdmin(ctx, 'change Dial settings');
  const existing = await getTelephony(ctx, 'dial');
  if (!existing) throw unprocessable('Dial is not connected');
  const prev = (existing.settings ?? {}) as DialSettings;
  const { coach, fromNumbers, ...rest } = patch;
  const settings = normalizeDialSettings({ ...prev, ...stripUndefined(rest) });
  const [row] = await ctx.db
    .update(telephonyConnections)
    .set({ settings: settings as Record<string, unknown>, ...(coach !== undefined ? { coach } : {}), ...(fromNumbers ? { fromNumbers: fromNumbers.map((n) => normalizePhone(n)).filter((n): n is string => !!n) } : {}), updatedAt: ctx.clock.now() })
    .where(eq(telephonyConnections.id, existing.id))
    .returning();
  return serializeDial(row!, !!d.dial?.apiKey);
}

export async function disconnectDial(ctx: Ctx) {
  assertAdmin(ctx, 'disconnect Dial');
  await ctx.db.delete(telephonyConnections).where(and(eq(telephonyConnections.workspaceId, ctx.principal.workspaceId), eq(telephonyConnections.provider, 'dial')));
  await clearDialerProviderIf(ctx, 'dial');
}

export interface DialHandle {
  kind: 'dial';
  row: TelephonyRow;
  client: DialClient;
  provider: DialProvider;
  settings: ReturnType<typeof dialSettingsOf>;
  webhookSecret: null;
}

export async function dialFor(ctx: Ctx, d: TelephonyDeps): Promise<DialHandle | null> {
  const row = await getTelephony(ctx, 'dial');
  if (!row) return null;
  const key = row.authTokenEncrypted === ENV_KEY ? d.dial?.apiKey : open(row.authTokenEncrypted, d.kek);
  if (!key) return null;
  const client = dialClient(key, d);
  return { kind: 'dial', row, client, provider: new DialProvider(client), settings: dialSettingsOf(row), webhookSecret: null };
}

export async function requireDial(ctx: Ctx, d: TelephonyDeps): Promise<DialHandle> {
  const h = await dialFor(ctx, d);
  if (!h) throw unprocessable('Connect Dial under Settings → Dialer first', { code: 'NO_DIAL' });
  return h;
}

/* -------------------------------------------------------- AI dialer (either) */

export type AiDialerHandle = SpekoHandle | DialHandle;

/**
 * The AI-voiced dialer to use: the one named by `kind`, else the workspace's chosen dialer when it
 * is an AI one, else whichever of Speko and Dial is connected (Speko first).
 */
export async function aiDialerFor(ctx: Ctx, d: TelephonyDeps, kind?: AiDialerKind | string | null): Promise<AiDialerHandle | null> {
  if (kind) return isAiDialer(kind) ? (kind === 'dial' ? dialFor(ctx, d) : spekoFor(ctx, d)) : null;
  const s = await workspaceSettings(ctx);
  const pref = isAiDialer(s.dialerProvider) ? s.dialerProvider : null;
  const order: AiDialerKind[] = pref ? [pref, ...AI_DIALERS.filter((k) => k !== pref)] : [...AI_DIALERS];
  for (const k of order) {
    const h = await aiDialerFor(ctx, d, k);
    if (h) return h;
  }
  return null;
}

export async function requireAiDialer(ctx: Ctx, d: TelephonyDeps, kind?: AiDialerKind | string | null): Promise<AiDialerHandle> {
  const h = await aiDialerFor(ctx, d, kind);
  if (!h) throw unprocessable(kind && isAiDialer(kind) ? `Connect ${DIALER_LABEL[kind]} under Settings → Dialer first` : 'Connect Speko or Dial under Settings → Dialer first', { code: kind === 'speko' ? 'NO_SPEKO' : kind === 'dial' ? 'NO_DIAL' : 'NO_AI_DIALER' });
  return h;
}

/* ----------------------------------------------------------- provider pick */

async function workspaceSettings(ctx: Ctx) {
  const [w] = await ctx.db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ctx.principal.workspaceId)).limit(1);
  return w?.settings ?? {};
}

/** First connection picks itself as the dialer; later ones leave the choice alone. */
async function ensureDialerProvider(ctx: Ctx, provider: DialerKind) {
  const s = await workspaceSettings(ctx);
  if (s.dialerProvider) return;
  await ctx.db.update(workspaces).set({ settings: { ...s, dialerProvider: provider } }).where(eq(workspaces.id, ctx.principal.workspaceId));
}
async function clearDialerProviderIf(ctx: Ctx, provider: DialerKind) {
  const s = await workspaceSettings(ctx);
  if (s.dialerProvider !== provider) return;
  let next: DialerKind | undefined;
  for (const other of (['twilio', 'speko', 'dial'] as DialerKind[]).filter((k) => k !== provider)) {
    if (await getTelephony(ctx, other)) {
      next = other;
      break;
    }
  }
  await ctx.db.update(workspaces).set({ settings: { ...s, dialerProvider: next } }).where(eq(workspaces.id, ctx.principal.workspaceId));
}

export async function setDialerProvider(ctx: Ctx, provider: DialerKind) {
  assertAdmin(ctx, 'choose the dialer provider');
  if (!(await getTelephony(ctx, provider))) throw unprocessable(`${DIALER_LABEL[provider]} is not connected`, { field: 'provider' });
  const s = await workspaceSettings(ctx);
  await ctx.db.update(workspaces).set({ settings: { ...s, dialerProvider: provider } }).where(eq(workspaces.id, ctx.principal.workspaceId));
  return provider;
}

/** Everything the Settings → Dialer page and `cooks_dialer_status` need in one read. */
export async function dialerOverview(ctx: Ctx, d: TelephonyDeps) {
  const [tw, sp, dl, s] = await Promise.all([getTelephony(ctx, 'twilio', d), getTelephony(ctx, 'speko'), getTelephony(ctx, 'dial'), workspaceSettings(ctx)]);
  const connected: Record<DialerKind, boolean> = { twilio: !!tw, speko: !!sp, dial: !!dl };
  const provider: DialerKind | null = s.dialerProvider && connected[s.dialerProvider] ? s.dialerProvider : tw ? 'twilio' : sp ? 'speko' : dl ? 'dial' : null;
  return { provider, twilio: serializeTelephony(tw), speko: serializeSpeko(sp, !!d.speko?.apiKey), dial: serializeDial(dl, !!d.dial?.apiKey), parallel: serializeParallelSettings(s.parallelDialer) };
}

/* ------------------------------------------------------ parallel dialer settings */

export const PARALLEL_DEFAULTS = {
  complianceMode: 'b2b' as const,
  maxLines: 3,
  onUnknown: 'hangup' as const,
  ringTimeoutSeconds: 25,
  amd: { speechThresholdMs: 2400, speechEndThresholdMs: 1200, silenceTimeoutMs: 3000, timeoutSeconds: 5 },
  speechGate: { enabled: true, judge: 'rules' as const, maxMs: 6000 },
};
/** Hard ceilings whatever the settings say. */
export const MAX_PARALLEL_LINES = 6;
export const MAX_CONSUMER_LINES = 2;

export function parallelSettingsOf(s: ParallelDialerSettings | undefined) {
  const mode = s?.complianceMode ?? PARALLEL_DEFAULTS.complianceMode;
  const cap = mode === 'consumer' ? MAX_CONSUMER_LINES : MAX_PARALLEL_LINES;
  return {
    complianceMode: mode,
    confirmed: !!s?.confirmedAt,
    confirmedBy: s?.confirmedBy ?? null,
    confirmedAt: s?.confirmedAt ?? null,
    maxLines: Math.min(cap, Math.max(1, s?.maxLines ?? PARALLEL_DEFAULTS.maxLines)),
    maxAllowedLines: cap,
    abandonedCallMessage: s?.abandonedCallMessage ?? null,
    onUnknown: s?.onUnknown ?? PARALLEL_DEFAULTS.onUnknown,
    ringTimeoutSeconds: Math.min(60, Math.max(15, s?.ringTimeoutSeconds ?? PARALLEL_DEFAULTS.ringTimeoutSeconds)),
    amd: { ...PARALLEL_DEFAULTS.amd, ...(s?.amd ?? {}) },
    speechGate: { ...PARALLEL_DEFAULTS.speechGate, ...(s?.speechGate ?? {}) },
  };
}
export const serializeParallelSettings = (s: ParallelDialerSettings | undefined) => parallelSettingsOf(s);

export interface ParallelSettingsPatch {
  complianceMode?: 'b2b' | 'consumer';
  /** Required to (re)confirm after changing the mode. */
  confirm?: boolean;
  maxLines?: number;
  abandonedCallMessage?: string | null;
  onUnknown?: 'hangup' | 'connect';
  ringTimeoutSeconds?: number;
  amd?: ParallelDialerSettings['amd'];
  speechGate?: ParallelDialerSettings['speechGate'];
}

/**
 * Admins choose B2B or consumer and must confirm it explicitly. Changing the mode clears the
 * confirmation; consumer mode needs the abandoned-call message before it can be confirmed.
 */
export async function setParallelSettings(ctx: Ctx, patch: ParallelSettingsPatch) {
  assertAdmin(ctx, 'change parallel dialer settings');
  const s = await workspaceSettings(ctx);
  const prev = s.parallelDialer ?? {};
  const next: ParallelDialerSettings = { ...prev };
  if (patch.complianceMode && patch.complianceMode !== (prev.complianceMode ?? 'b2b')) {
    next.complianceMode = patch.complianceMode;
    next.confirmedAt = null;
    next.confirmedBy = null;
  } else if (patch.complianceMode) next.complianceMode = patch.complianceMode;
  if (patch.maxLines !== undefined) next.maxLines = Math.min(MAX_PARALLEL_LINES, Math.max(1, Math.round(patch.maxLines)));
  if (patch.abandonedCallMessage !== undefined) next.abandonedCallMessage = patch.abandonedCallMessage?.trim() || null;
  if (patch.onUnknown) next.onUnknown = patch.onUnknown;
  if (patch.ringTimeoutSeconds !== undefined) next.ringTimeoutSeconds = patch.ringTimeoutSeconds;
  if (patch.amd) next.amd = { ...(prev.amd ?? {}), ...patch.amd };
  if (patch.speechGate) next.speechGate = { ...(prev.speechGate ?? {}), ...patch.speechGate };
  if (patch.confirm) {
    if ((next.complianceMode ?? 'b2b') === 'consumer' && !next.abandonedCallMessage) throw unprocessable('Consumer mode needs an abandoned-call message (your company name and a call-back number) before it can be confirmed', { code: 'ABANDON_MESSAGE_REQUIRED', field: 'abandonedCallMessage' });
    next.confirmedAt = ctx.clock.now().toISOString();
    next.confirmedBy = ctx.principal.userId ?? 'api-key';
  }
  await ctx.db.update(workspaces).set({ settings: { ...s, parallelDialer: next } }).where(eq(workspaces.id, ctx.principal.workspaceId));
  return parallelSettingsOf(next);
}

export async function getParallelSettings(ctx: Ctx) {
  const s = await workspaceSettings(ctx);
  return parallelSettingsOf(s.parallelDialer);
}
