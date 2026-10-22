import { eq } from 'drizzle-orm';
import { telephonyConnections } from '@cooks/db';
import type { Ctx } from '../context.js';
import { decrypt, encrypt } from '../crypto.js';
import { insufficientPermission, unprocessable } from '../errors.js';
import { TwilioClient, TwilioError, normalizePhone, type TwilioClientOpts } from './twilio.js';

export type TelephonyRow = typeof telephonyConnections.$inferSelect;

export interface TelephonyDeps extends TwilioClientOpts {
  kek?: string;
}

const NO_KEK = 'COOKS_KEK is required to store telephony credentials';
const seal = (v: string, kek?: string) => (kek ? encrypt(v, kek) : `plain:${v}`);
const open = (v: string, kek?: string) => (v.startsWith('plain:') ? v.slice(6) : kek ? decrypt(v, kek) : '');

export async function getTelephony(ctx: Ctx): Promise<TelephonyRow | null> {
  const [row] = await ctx.db.select().from(telephonyConnections).where(eq(telephonyConnections.workspaceId, ctx.principal.workspaceId)).limit(1);
  return row ?? null;
}

export function serializeTelephony(row: TelephonyRow | null) {
  if (!row) return { provider: null, status: 'disconnected' as const, accountSid: null, fromNumbers: [] as string[], softphone: false, record: true, transcribe: true, coach: true, updatedAt: null };
  return {
    provider: row.provider,
    status: 'connected' as const,
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
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission('Only admins can connect telephony');
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
  const existing = await getTelephony(ctx);
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
  return serializeTelephony(row!);
}

export async function updateTelephonySettings(ctx: Ctx, patch: { fromNumbers?: string[]; record?: boolean; transcribe?: boolean; coach?: boolean }) {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission('Only admins can change telephony settings');
  const existing = await getTelephony(ctx);
  if (!existing) throw unprocessable('Telephony is not connected');
  const [row] = await ctx.db
    .update(telephonyConnections)
    .set({ ...(patch.fromNumbers ? { fromNumbers: patch.fromNumbers.map((n) => normalizePhone(n)).filter((n): n is string => !!n) } : {}), ...(patch.record !== undefined ? { record: patch.record } : {}), ...(patch.transcribe !== undefined ? { transcribe: patch.transcribe } : {}), ...(patch.coach !== undefined ? { coach: patch.coach } : {}), updatedAt: ctx.clock.now() })
    .where(eq(telephonyConnections.id, existing.id))
    .returning();
  return serializeTelephony(row!);
}

export async function disconnectTelephony(ctx: Ctx) {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission('Only admins can disconnect telephony');
  await ctx.db.delete(telephonyConnections).where(eq(telephonyConnections.workspaceId, ctx.principal.workspaceId));
}

/** Decrypted credentials + client for a workspace, or null when not connected. */
export async function telephonyFor(ctx: Ctx, d: TelephonyDeps): Promise<{ row: TelephonyRow; client: TwilioClient; authToken: string; apiKey: { sid: string; secret: string } | null } | null> {
  const row = await getTelephony(ctx);
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
