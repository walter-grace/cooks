import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { emailEvents, emails, prospects, sequenceStates, suppressions, trackingLinks, type DbOrTx } from '@cooks/db';
import { emitEvent } from '../events.js';
import { finishEnrollment } from '../engine/transitions.js';
import { bumpCounter } from './analytics.js';
import type { Ctx } from '../context.js';

/** Tokens are `<id>.<hmac>`; the HMAC covers the id (and url for clicks) so tokens cannot be forged. */
function sign(secret: string, ...parts: string[]) {
  return createHmac('sha256', secret).update(parts.join('|')).digest('base64url').slice(0, 24);
}
function verify(secret: string, sig: string, ...parts: string[]) {
  const expected = sign(secret, ...parts);
  return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export const openToken = (emailId: string, secret: string) => `${emailId}.${sign(secret, 'open', emailId)}`;
export const clickToken = (linkId: string, secret: string) => `${linkId}.${sign(secret, 'click', linkId)}`;
export const unsubToken = (emailId: string, secret: string) => `${emailId}.${sign(secret, 'unsub', emailId)}`;

function parse(token: string): [string, string] | null {
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  return [token.slice(0, i), token.slice(i + 1)];
}

const BOT_UA = /(googleimageproxy|bot|crawler|spider|preview|scan|monitor|outlook-ios|barracuda|proofpoint|mimecast|safelinks)/i;

/** Rewrite links and append the open pixel. Called by the send pipeline after rendering. */
export async function instrumentHtml(db: DbOrTx, args: { workspaceId: string; emailId: string; html: string; publicUrl: string; secret: string; opens: boolean; clicks: boolean; skipUrls: string[] }) {
  let html = args.html;
  if (args.clicks) {
    const matches = [...html.matchAll(/href="(https?:\/\/[^"]+)"/gi)];
    for (const m of matches) {
      const url = m[1]!;
      if (args.skipUrls.some((s) => url.startsWith(s))) continue;
      const [row] = await db.insert(trackingLinks).values({ workspaceId: args.workspaceId, emailId: args.emailId, token: `${args.emailId}:${matches.indexOf(m)}:${Math.random().toString(36).slice(2, 8)}`, url }).returning({ id: trackingLinks.id });
      html = html.replace(m[0], `href="${args.publicUrl}/t/c/${clickToken(row!.id, args.secret)}"`);
    }
  }
  if (args.opens) {
    const pixel = `<img src="${args.publicUrl}/t/o/${openToken(args.emailId, args.secret)}.gif" width="1" height="1" alt="" style="display:none;max-height:1px">`;
    html = html.includes('</body>') ? html.replace('</body>', `${pixel}</body>`) : html + pixel;
  }
  return html;
}

export interface TrackingDeps {
  db: DbOrTx;
  secret: string;
  now: Date;
  userAgent?: string | null;
}

export async function recordOpen(d: TrackingDeps, token: string): Promise<boolean> {
  const p = parse(token.replace(/\.gif$/, ''));
  if (!p || !verify(d.secret, p[1], 'open', p[0])) return false;
  const [email] = await d.db.select().from(emails).where(eq(emails.id, p[0])).limit(1);
  if (!email || email.direction !== 'outbound') return false;
  // Ignore scanner prefetches: known UAs and opens within 10 s of sending.
  if ((d.userAgent && BOT_UA.test(d.userAgent)) || (email.date && d.now.getTime() - email.date.getTime() < 10_000)) return true;
  const first = !email.openedAt;
  await d.db
    .update(emails)
    .set({ openedAt: email.openedAt ?? d.now, openCount: sql`${emails.openCount} + 1` })
    .where(eq(emails.id, email.id));
  await d.db.insert(emailEvents).values({ workspaceId: email.workspaceId, emailId: email.id, kind: 'opened', occurredAt: d.now, meta: { ua: d.userAgent ?? null }, rolledUpAt: d.now });
  if (first) {
    if (email.sequenceId) await bumpCounter(d.db, email.workspaceId, 'sequence', email.sequenceId, 'email.opened');
    if (email.sequenceStepId) await bumpCounter(d.db, email.workspaceId, 'sequence_step', email.sequenceStepId, 'email.opened');
    await emitEvent(d.db, { workspaceId: email.workspaceId, type: 'email.opened', aggregateType: 'email', aggregateId: email.id, payload: { emailId: email.id, prospectId: email.prospectId }, dedupeKey: `${email.id}:opened` });
  }
  return true;
}

export async function recordClick(d: TrackingDeps, token: string): Promise<string | null> {
  const p = parse(token);
  if (!p || !verify(d.secret, p[1], 'click', p[0])) return null;
  const [link] = await d.db.select().from(trackingLinks).where(eq(trackingLinks.id, p[0])).limit(1);
  if (!link) return null;
  const [email] = await d.db.select().from(emails).where(eq(emails.id, link.emailId)).limit(1);
  if (!email) return link.url;
  if (d.userAgent && BOT_UA.test(d.userAgent)) return link.url;
  const first = !email.clickedAt;
  await d.db.update(emails).set({ clickedAt: email.clickedAt ?? d.now, clickCount: sql`${emails.clickCount} + 1`, openedAt: email.openedAt ?? d.now }).where(eq(emails.id, email.id));
  await d.db.insert(emailEvents).values({ workspaceId: email.workspaceId, emailId: email.id, kind: 'clicked', occurredAt: d.now, meta: { url: link.url, ua: d.userAgent ?? null }, rolledUpAt: d.now });
  if (first) {
    if (email.sequenceId) await bumpCounter(d.db, email.workspaceId, 'sequence', email.sequenceId, 'email.clicked');
    if (email.sequenceStepId) await bumpCounter(d.db, email.workspaceId, 'sequence_step', email.sequenceStepId, 'email.clicked');
    await emitEvent(d.db, { workspaceId: email.workspaceId, type: 'email.clicked', aggregateType: 'email', aggregateId: email.id, payload: { emailId: email.id, prospectId: email.prospectId, url: link.url }, dedupeKey: `${email.id}:clicked` });
  }
  return link.url;
}

/** Unsubscribe: suppress the address, mark the prospect, finish every active enrollment. */
export async function recordUnsubscribe(ctx: Ctx, secret: string, token: string): Promise<{ ok: boolean; email?: string }> {
  const p = parse(token);
  if (!p || !verify(secret, p[1], 'unsub', p[0])) return { ok: false };
  const [email] = await ctx.db.select().from(emails).where(eq(emails.id, p[0])).limit(1);
  if (!email) return { ok: false };
  const now = ctx.clock.now();
  const addr = (email.toAddr ?? '').toLowerCase();
  if (addr) {
    await ctx.db.insert(suppressions).values({ workspaceId: email.workspaceId, emailLower: addr, reason: 'unsubscribe', source: `email:${email.id}` }).onConflictDoNothing();
  }
  if (email.prospectId) {
    await ctx.db.update(prospects).set({ unsubscribedAt: now, emailStatus: 'unsubscribed' }).where(and(eq(prospects.id, email.prospectId), sql`${prospects.unsubscribedAt} IS NULL`));
    const active = await ctx.db
      .select({ id: sequenceStates.id })
      .from(sequenceStates)
      .where(and(eq(sequenceStates.prospectId, email.prospectId), sql`${sequenceStates.state} <> 'finished'`));
    for (const s of active) await finishEnrollment({ ...ctx, principal: { ...ctx.principal, workspaceId: email.workspaceId } }, s.id, 'unsubscribed');
  }
  await ctx.db.insert(emailEvents).values({ workspaceId: email.workspaceId, emailId: email.id, kind: 'unsubscribed', occurredAt: now, rolledUpAt: now });
  if (email.sequenceId) await bumpCounter(ctx.db, email.workspaceId, 'sequence', email.sequenceId, 'email.unsubscribed');
  if (email.sequenceStepId) await bumpCounter(ctx.db, email.workspaceId, 'sequence_step', email.sequenceStepId, 'email.unsubscribed');
  await emitEvent(ctx.db, { workspaceId: email.workspaceId, type: 'prospect.unsubscribed', aggregateType: 'prospect', aggregateId: email.prospectId ?? email.id, payload: { prospectId: email.prospectId, emailId: email.id, address: addr }, dedupeKey: `${email.id}:unsubscribed` });
  return { ok: true, email: addr };
}
