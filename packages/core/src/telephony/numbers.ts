/**
 * Buying phone numbers from inside Cooks: Twilio (search, quoted monthly price, buy) and Dial
 * (Dial picks the number, optionally in an area code). Speko's lives in ai-call.ts. Every purchase
 * is PAID: admins only, `confirm: true`, and the new number joins the caller ids.
 */
import { eq } from 'drizzle-orm';
import { telephonyConnections, users, workspaces } from '@cooks/db';
import type { Ctx } from '../context.js';
import { DialerError } from '../dialer/providers/index.js';
import { unprocessable } from '../errors.js';
import { ENV_ROW_ID, dialFor, requireTelephony, type TelephonyDeps, type TelephonyRow } from './connection.js';
import { TwilioError, normalizePhone } from './twilio.js';

const assertCanBuy = (ctx: Ctx, confirm: boolean | undefined) => {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw unprocessable('Only admins can buy phone numbers', { code: 'ADMIN_REQUIRED' });
  if (confirm !== true) throw unprocessable('Buying a number is a paid action: confirm the price by passing confirm: true', { code: 'CONFIRM_REQUIRED' });
};

/** Adds a bought number to a connection's caller ids; first number (or makeDefault) becomes the default. */
async function addCallerId(ctx: Ctx, row: TelephonyRow, e164: string, makeDefault?: boolean) {
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const next = { ...settings, ...(makeDefault || !settings.fromNumber ? { fromNumber: e164 } : {}) };
  if (row.id !== ENV_ROW_ID) {
    // Twilio has no fromNumber setting and dials from the first caller id, so a default goes first.
    const fromNumbers = makeDefault ? [e164, ...row.fromNumbers.filter((n) => n !== e164)] : [...new Set([...row.fromNumbers, e164])];
    await ctx.db.update(telephonyConnections).set({ fromNumbers, settings: next, updatedAt: ctx.clock.now() }).where(eq(telephonyConnections.id, row.id));
  }
  return next.fromNumber === e164;
}

const twilioFailure = (e: unknown): never => {
  if (e instanceof TwilioError) throw unprocessable(`Twilio: ${e.message}`, { code: e.code ? `TWILIO_${e.code}` : `HTTP_${e.status}`, provider: 'twilio' });
  throw e;
};

/* ---------- Twilio ---------- */

export async function searchTwilioNumbers(ctx: Ctx, d: TelephonyDeps, q: { country?: string; areaCode?: string; contains?: string; limit?: number }) {
  const t = await requireTelephony(ctx, d);
  const country = (q.country ?? 'US').toUpperCase();
  const [numbers, price] = await Promise.all([t.client.availableNumbers({ ...q, country, limit: q.limit ?? 10 }).catch(twilioFailure), t.client.localNumberPrice(country)]);
  return numbers.map((n) => ({ ...n, monthlyUsd: price?.monthlyUsd ?? null, currency: price?.currency ?? 'USD' }));
}

export async function buyTwilioNumber(ctx: Ctx, d: TelephonyDeps, input: { e164: string; confirm?: boolean; makeDefault?: boolean }) {
  assertCanBuy(ctx, input.confirm);
  const t = await requireTelephony(ctx, d);
  const want = normalizePhone(input.e164);
  if (!want) throw unprocessable('Pick a number from the search results', { field: 'e164' });
  const bought = await t.client.buyNumber(want, 'Cooks').catch(twilioFailure);
  const e164 = normalizePhone(bought.phone_number) ?? bought.phone_number;
  const isDefault = await addCallerId(ctx, t.row, e164, input.makeDefault);
  return { provider: 'twilio' as const, id: bought.sid, e164, isDefault };
}

/* ---------- Dial ---------- */

export async function buyDialNumber(ctx: Ctx, d: TelephonyDeps, input: { areaCode?: string; confirm?: boolean; consent?: boolean; inboundInstruction?: string; makeDefault?: boolean }) {
  assertCanBuy(ctx, input.confirm);
  if (input.consent !== true) throw unprocessable('Dial asks the account holder to agree to buying numbers programmatically: pass consent: true', { code: 'CONSENT_REQUIRED' });
  if (input.areaCode && !/^\d{3}$/.test(input.areaCode)) throw unprocessable('Area code is three digits (US only)', { field: 'areaCode' });
  const h = await dialFor(ctx, d);
  if (!h) throw unprocessable('Connect Dial under Settings → Dialer first', { code: 'NO_DIAL' });
  const [w] = await ctx.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.principal.workspaceId)).limit(1);
  const [u] = ctx.principal.userId ? await ctx.db.select({ email: users.email }).from(users).where(eq(users.id, ctx.principal.userId)).limit(1) : [];
  const who = u?.email ? `admin ${u.email}` : ctx.principal.apiKeyId ? `API key ${ctx.principal.apiKeyId}` : 'a workspace admin';
  const team = w?.name ?? 'the team';
  let bought;
  try {
    bought = await h.client.purchaseNumber({
      inboundInstruction: input.inboundInstruction?.trim() || `You answer calls to ${team}'s sales line. Say the team is away from the phone, ask for the caller's name, company and the best time to call back, then thank them and end the call.`,
      explicitProgrammaticConsent: `In Cooks (workspace "${team}"), ${who} confirmed the price and agreed to buy this number programmatically on ${ctx.clock.now().toISOString()}.`,
      ...(input.areaCode ? { areaCode: input.areaCode } : {}),
    });
  } catch (e) {
    if (e instanceof DialerError) throw unprocessable(e.message, { code: e.code, provider: 'dial', ...(e.details ?? {}) });
    throw e;
  }
  const e164 = normalizePhone(bought.number) ?? bought.number;
  const isDefault = await addCallerId(ctx, h.row, e164, input.makeDefault);
  return { provider: 'dial' as const, id: bought.id, e164, status: bought.status ?? null, isDefault };
}
