/**
 * Inkbox connection per workspace: the API key (encrypted), the webhook bearer token, and the
 * identities (handle, email, phone, iMessage line) mapped to Cooks users. Each mapped identity
 * gets a mailbox row (provider `inkbox`) so sequences can send email through it.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { channelConnections, channelIdentities, mailboxes, workspaceMembers } from '@cooks/db';
import type { Ctx } from '../context.js';
import { decrypt, encrypt } from '../crypto.js';
import { insufficientPermission, notFound, unprocessable } from '../errors.js';
import { normalizePhone } from '../telephony/twilio.js';
import { InkboxClient, InkboxError, type InkboxIdentity } from './inkbox.js';
import { isUuid } from '../services/_shared.js';

export type ChannelRow = typeof channelConnections.$inferSelect;
export type IdentityRow = typeof channelIdentities.$inferSelect;

export interface ChannelDeps {
  kek?: string;
  fetchImpl?: typeof fetch;
  inkbox?: { apiBase?: string };
  publicUrl: string;
}

const seal = (v: string, kek?: string) => (kek ? encrypt(v, kek) : `plain:${v}`);
const open = (v: string, kek?: string) => (v.startsWith('plain:') ? v.slice(6) : kek ? decrypt(v, kek) : '');
const assertAdmin = (ctx: Ctx, what: string) => {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission(`Only admins can ${what}`);
};

/** Events Cooks subscribes every mapped identity to. */
export const INKBOX_EVENTS = ['message.received', 'message.bounced', 'message.failed', 'text.received', 'text.delivered', 'text.delivery_failed', 'imessage.received', 'imessage.delivered', 'imessage.delivery_failed', 'call.ended', 'a2a.task.created', 'a2a.task.message'];

export async function getInkboxConnection(ctx: Ctx): Promise<ChannelRow | null> {
  const [row] = await ctx.db.select().from(channelConnections).where(and(eq(channelConnections.workspaceId, ctx.principal.workspaceId), eq(channelConnections.provider, 'inkbox'))).limit(1);
  return row ?? null;
}

export interface InkboxHandle {
  row: ChannelRow;
  client: InkboxClient;
  webhookToken: string | null;
}

export async function inkboxFor(ctx: Ctx, d: ChannelDeps): Promise<InkboxHandle | null> {
  const row = await getInkboxConnection(ctx);
  if (!row) return null;
  const key = open(row.apiKeyEncrypted, d.kek);
  if (!key) return null;
  return { row, client: new InkboxClient(key, { apiBase: d.inkbox?.apiBase, fetchImpl: d.fetchImpl }), webhookToken: row.webhookTokenEncrypted ? open(row.webhookTokenEncrypted, d.kek) : null };
}

export async function requireInkbox(ctx: Ctx, d: ChannelDeps): Promise<InkboxHandle> {
  const h = await inkboxFor(ctx, d);
  if (!h) throw unprocessable('Connect Inkbox under Settings → Channels first', { code: 'NO_INKBOX' });
  return h;
}

export function serializeIdentity(i: IdentityRow) {
  return {
    id: i.id,
    externalId: i.externalId,
    handle: i.handle,
    displayName: i.displayName,
    emailAddress: i.emailAddress,
    phoneNumber: i.phoneNumber,
    smsStatus: i.smsStatus,
    imessageNumber: i.imessageNumber,
    imessageEnabled: !!i.imessageNumber,
    user: i.userId ? { id: i.userId } : null,
    mailbox: i.mailboxId ? { id: i.mailboxId } : null,
    signed: !!i.signingKeyEncrypted,
    subscriptions: i.subscriptionIds.length,
    updatedAt: i.updatedAt.toISOString(),
  };
}

export function serializeInkbox(row: ChannelRow | null, identities: IdentityRow[], d: ChannelDeps) {
  const ws = identities[0]?.workspaceId;
  return {
    provider: 'inkbox' as const,
    status: row ? ('connected' as const) : ('disconnected' as const),
    webhookUrl: row ? `${d.publicUrl.replace(/\/+$/, '')}/webhooks/inkbox?ws=${ws ?? row.workspaceId}` : null,
    webhookTokenConfigured: !!row?.webhookTokenEncrypted,
    identities: identities.map(serializeIdentity),
    settings: row?.settings ?? {},
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function listIdentities(ctx: Ctx): Promise<IdentityRow[]> {
  return ctx.db.select().from(channelIdentities).where(and(eq(channelIdentities.workspaceId, ctx.principal.workspaceId), eq(channelIdentities.provider, 'inkbox'))).orderBy(channelIdentities.handle);
}

export async function inkboxOverview(ctx: Ctx, d: ChannelDeps) {
  const [row, ids] = await Promise.all([getInkboxConnection(ctx), listIdentities(ctx)]);
  return serializeInkbox(row, ids, d);
}

/** Upsert the identities Inkbox reports for this key. Existing user mappings and keys survive. */
export async function syncInkboxIdentities(ctx: Ctx, d: ChannelDeps, list?: InkboxIdentity[]): Promise<IdentityRow[]> {
  const h = await requireInkbox(ctx, d);
  const remote = list ?? (await h.client.listIdentities());
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  for (const r of remote) {
    const values = {
      workspaceId: ws,
      provider: 'inkbox',
      externalId: r.id,
      handle: r.agent_handle,
      displayName: r.display_name ?? null,
      emailAddress: (r.email_address ?? r.mailbox?.email_address ?? null)?.toLowerCase() ?? null,
      phoneNumber: r.phone_number?.number ? (normalizePhone(r.phone_number.number) ?? r.phone_number.number) : null,
      phoneNumberId: r.phone_number?.id ?? null,
      smsStatus: r.phone_number?.sms_status ?? null,
      imessageNumber: r.imessage_number?.number ? (normalizePhone(r.imessage_number.number) ?? r.imessage_number.number) : null,
      imessageNumberId: r.imessage_number?.id ?? null,
      raw: { status: r.status ?? null, signing_key_configured: r.signing_key_configured ?? null, imessage_enabled: r.imessage_enabled ?? null },
      updatedAt: now,
    };
    const [existing] = await ctx.db.select().from(channelIdentities).where(and(eq(channelIdentities.workspaceId, ws), eq(channelIdentities.provider, 'inkbox'), eq(channelIdentities.externalId, r.id))).limit(1);
    if (existing) await ctx.db.update(channelIdentities).set(values).where(eq(channelIdentities.id, existing.id));
    else await ctx.db.insert(channelIdentities).values(values);
  }
  const rows = await listIdentities(ctx);
  // keep mailbox rows in step with the identity email
  for (const row of rows) if (row.userId) await ensureIdentityMailbox(ctx, row);
  return rows;
}

/** Connect (or re-key) Inkbox: verify the key, store it encrypted, pull identities. */
export async function connectInkbox(ctx: Ctx, input: { apiKey: string; webhookToken?: string | null }, d: ChannelDeps) {
  assertAdmin(ctx, 'connect Inkbox');
  if (!d.kek && process.env.NODE_ENV === 'production') throw unprocessable('COOKS_KEK is required to store channel credentials');
  const key = input.apiKey.trim();
  const client = new InkboxClient(key, { apiBase: d.inkbox?.apiBase, fetchImpl: d.fetchImpl });
  let probe: { scoped: boolean; identities: InkboxIdentity[] };
  try {
    probe = await client.verify();
  } catch (e) {
    if (e instanceof InkboxError && (e.status === 401 || e.status === 403)) throw unprocessable('Inkbox rejected the API key', { field: 'apiKey' });
    throw e;
  }
  const existing = await getInkboxConnection(ctx);
  const webhookToken = input.webhookToken?.trim() || (existing?.webhookTokenEncrypted ? null : randomBytes(24).toString('base64url'));
  const values = {
    workspaceId: ctx.principal.workspaceId,
    provider: 'inkbox',
    apiKeyEncrypted: seal(key, d.kek),
    ...(webhookToken ? { webhookTokenEncrypted: seal(webhookToken, d.kek) } : {}),
    status: 'connected',
    settings: { ...(existing?.settings ?? {}), keyScope: probe.scoped ? 'agent' : 'admin' },
    updatedAt: ctx.clock.now(),
  };
  if (existing) await ctx.db.update(channelConnections).set(values).where(eq(channelConnections.id, existing.id));
  else await ctx.db.insert(channelConnections).values(values);
  const ids = await syncInkboxIdentities(ctx, d, probe.identities);
  return serializeInkbox(await getInkboxConnection(ctx), ids, d);
}

export async function disconnectInkbox(ctx: Ctx) {
  assertAdmin(ctx, 'disconnect Inkbox');
  const ws = ctx.principal.workspaceId;
  const ids = await listIdentities(ctx);
  for (const i of ids) if (i.mailboxId) await ctx.db.update(mailboxes).set({ status: 'disconnected', deletedAt: ctx.clock.now() }).where(eq(mailboxes.id, i.mailboxId));
  await ctx.db.delete(channelIdentities).where(and(eq(channelIdentities.workspaceId, ws), eq(channelIdentities.provider, 'inkbox')));
  await ctx.db.delete(channelConnections).where(and(eq(channelConnections.workspaceId, ws), eq(channelConnections.provider, 'inkbox')));
}

async function identityRow(ctx: Ctx, id: string): Promise<IdentityRow> {
  if (!isUuid(id)) throw notFound('Identity');
  const [row] = await ctx.db.select().from(channelIdentities).where(and(eq(channelIdentities.workspaceId, ctx.principal.workspaceId), eq(channelIdentities.id, id))).limit(1);
  if (!row) throw notFound('Identity');
  return row;
}

/** A mailbox row (provider inkbox) for the identity email, owned by the mapped user, so the sequence engine can pick it. */
async function ensureIdentityMailbox(ctx: Ctx, identity: IdentityRow): Promise<string | null> {
  if (!identity.emailAddress || !identity.userId) return identity.mailboxId;
  const ws = ctx.principal.workspaceId;
  const [byEmail] = await ctx.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, ws), eq(mailboxes.email, identity.emailAddress))).limit(1);
  let mailboxId = byEmail?.id ?? null;
  if (byEmail) {
    await ctx.db.update(mailboxes).set({ userId: identity.userId, provider: 'inkbox', status: 'connected', deletedAt: null, updatedAt: ctx.clock.now() }).where(eq(mailboxes.id, byEmail.id));
  } else {
    const [others] = await ctx.db.select({ id: mailboxes.id }).from(mailboxes).where(and(eq(mailboxes.workspaceId, ws), eq(mailboxes.userId, identity.userId), isNull(mailboxes.deletedAt))).limit(1);
    const [mb] = await ctx.db.insert(mailboxes).values({ workspaceId: ws, userId: identity.userId, email: identity.emailAddress, provider: 'inkbox', isDefault: !others, dailySendLimit: 200, minGapSeconds: 30, settings: { inkboxIdentityId: identity.id } }).returning({ id: mailboxes.id });
    mailboxId = mb!.id;
  }
  if (mailboxId !== identity.mailboxId) await ctx.db.update(channelIdentities).set({ mailboxId, updatedAt: ctx.clock.now() }).where(eq(channelIdentities.id, identity.id));
  return mailboxId;
}

/** Map an identity to the Cooks user it sends as (null unmaps and retires its mailbox). */
export async function mapIdentityUser(ctx: Ctx, identityId: string, userId: string | null) {
  assertAdmin(ctx, 'map Inkbox identities');
  const row = await identityRow(ctx, identityId);
  if (userId) {
    const [m] = await ctx.db.select({ id: workspaceMembers.userId }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, ctx.principal.workspaceId), eq(workspaceMembers.userId, userId))).limit(1);
    if (!m) throw unprocessable('userId does not reference a user in this workspace', { field: 'userId' });
  }
  await ctx.db.update(channelIdentities).set({ userId, updatedAt: ctx.clock.now() }).where(eq(channelIdentities.id, row.id));
  const updated = { ...row, userId };
  if (userId) await ensureIdentityMailbox(ctx, updated);
  else if (row.mailboxId) await ctx.db.update(mailboxes).set({ status: 'disconnected', deletedAt: ctx.clock.now() }).where(eq(mailboxes.id, row.mailboxId));
  return serializeIdentity((await identityRow(ctx, row.id))!);
}

/**
 * Subscribe an identity to Cooks' webhook. Creates the signing key first when the identity has
 * none (Inkbox returns a key exactly once), stores it encrypted, and remembers the subscription id.
 */
export async function subscribeInkboxWebhooks(ctx: Ctx, identityId: string, d: ChannelDeps) {
  assertAdmin(ctx, 'subscribe Inkbox webhooks');
  const h = await requireInkbox(ctx, d);
  const row = await identityRow(ctx, identityId);
  let webhookToken = h.webhookToken;
  if (!webhookToken) {
    webhookToken = randomBytes(24).toString('base64url');
    await ctx.db.update(channelConnections).set({ webhookTokenEncrypted: seal(webhookToken, d.kek), updatedAt: ctx.clock.now() }).where(eq(channelConnections.id, h.row.id));
  }
  let signingKey: string | null = null;
  if (!row.signingKeyEncrypted) {
    const created = await h.client.createSigningKey(row.handle).catch(() => null);
    signingKey = created?.signing_key ?? null;
  }
  const url = `${d.publicUrl.replace(/\/+$/, '')}/webhooks/inkbox?ws=${ctx.principal.workspaceId}`;
  const sub = await h.client.createSubscription({ identityId: row.externalId, url, eventTypes: INKBOX_EVENTS, authToken: webhookToken });
  signingKey = signingKey ?? sub.signing_key ?? null;
  await ctx.db
    .update(channelIdentities)
    .set({ subscriptionIds: [...new Set([...row.subscriptionIds, sub.id])], ...(signingKey ? { signingKeyEncrypted: seal(signingKey, d.kek) } : {}), updatedAt: ctx.clock.now() })
    .where(eq(channelIdentities.id, row.id));
  return { identity: serializeIdentity((await identityRow(ctx, row.id))!), subscriptionId: sub.id, url, signed: !!(signingKey || row.signingKeyEncrypted) };
}

/** Decrypted signing key for an identity (webhook verification). */
export function identitySigningKey(row: IdentityRow, d: ChannelDeps): string | null {
  return row.signingKeyEncrypted ? open(row.signingKeyEncrypted, d.kek) : null;
}

/* ---------- identity lookup ---------- */

export async function identityByAddress(ctx: Ctx, addr: { email?: string | null; phone?: string | null; externalId?: string | null }): Promise<IdentityRow | null> {
  const ws = ctx.principal.workspaceId;
  const base = [eq(channelIdentities.workspaceId, ws), eq(channelIdentities.provider, 'inkbox')];
  if (addr.externalId) {
    const [r] = await ctx.db.select().from(channelIdentities).where(and(...base, eq(channelIdentities.externalId, addr.externalId))).limit(1);
    if (r) return r;
  }
  if (addr.email) {
    const [r] = await ctx.db.select().from(channelIdentities).where(and(...base, eq(channelIdentities.emailAddress, addr.email.toLowerCase()))).limit(1);
    if (r) return r;
  }
  if (addr.phone) {
    const p = normalizePhone(addr.phone) ?? addr.phone;
    const rows = await ctx.db.select().from(channelIdentities).where(and(...base));
    return rows.find((r) => r.phoneNumber === p || r.imessageNumber === p) ?? null;
  }
  return null;
}

/** The identity a user sends as: mapped to them, else the first mapped identity, else the first identity. */
export async function identityForUser(ctx: Ctx, userId: string | null | undefined, need: 'sms' | 'imessage' | 'email' | 'call' = 'sms'): Promise<IdentityRow | null> {
  const rows = await listIdentities(ctx);
  const capable = rows.filter((r) => (need === 'sms' || need === 'call' ? !!r.phoneNumberId : need === 'imessage' ? !!r.imessageNumber || !!r.phoneNumber : !!r.emailAddress));
  return capable.find((r) => userId && r.userId === userId) ?? capable.find((r) => r.userId) ?? capable[0] ?? null;
}
