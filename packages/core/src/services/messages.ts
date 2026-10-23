import { and, desc, eq, inArray, isNull, lt, type SQL } from 'drizzle-orm';
import { calls, emails, messages, prospects } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest } from '../errors.js';
import { refOrNull } from '../include.js';
import { iso, isoReq, isUuid, tenantWhere } from './_shared.js';

export type MessageRow = typeof messages.$inferSelect;

export function serializeMessage(m: MessageRow) {
  return {
    id: m.id,
    channel: m.channel,
    direction: m.direction,
    status: m.status,
    from: m.fromAddr,
    to: m.toAddr,
    body: m.body,
    mediaUrls: m.mediaUrls,
    provider: m.provider,
    providerMessageId: m.providerMessageId,
    conversationId: m.conversationId,
    error: m.error,
    blockReason: m.blockReason,
    prospect: refOrNull('prospects', m.prospectId),
    sequence: refOrNull('sequences', m.sequenceId),
    sequenceStep: refOrNull('sequenceSteps', m.sequenceStepId),
    task: refOrNull('tasks', m.taskId),
    owner: refOrNull('users', m.ownerId),
    identity: m.identityId ? { id: m.identityId } : null,
    sentAt: iso(m.sentAt),
    deliveredAt: iso(m.deliveredAt),
    repliedAt: iso(m.repliedAt),
    autoSubmitted: m.autoSubmitted,
    createdAt: isoReq(m.createdAt),
    updatedAt: isoReq(m.updatedAt),
  };
}

export async function listMessages(ctx: Ctx, q: { prospectId?: string; channel?: string; direction?: string; limit?: number; before?: string }) {
  const conds: SQL[] = [tenantWhere(messages, ctx.principal.workspaceId)];
  if (q.prospectId) {
    if (!isUuid(q.prospectId)) throw badRequest('prospectId must be a UUID');
    conds.push(eq(messages.prospectId, q.prospectId));
  }
  if (q.channel) conds.push(eq(messages.channel, q.channel as MessageRow['channel']));
  if (q.direction) conds.push(eq(messages.direction, q.direction as MessageRow['direction']));
  if (q.before) {
    const b = new Date(q.before);
    if (Number.isNaN(b.getTime())) throw badRequest('before must be ISO 8601');
    conds.push(lt(messages.createdAt, b));
  }
  const rows = await ctx.db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.createdAt))
    .limit(Math.min(Math.max(q.limit ?? 50, 1), 200));
  return rows.map(serializeMessage);
}

export interface InboxItem {
  id: string;
  kind: 'email' | 'sms' | 'imessage' | 'a2a' | 'call';
  direction: 'inbound' | 'outbound';
  at: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  text: string | null;
  status: string;
  prospect: { id: string; name: string | null } | null;
  provider: string | null;
  meta: Record<string, unknown>;
}

/**
 * Unified inbox: email, SMS, iMessage, agent-to-agent and calls, newest first. One prospect or the
 * whole workspace. `before` pages backwards by time.
 */
export async function listInbox(ctx: Ctx, q: { prospectId?: string; limit?: number; before?: string; direction?: 'inbound' | 'outbound'; kinds?: string[] }): Promise<{ items: InboxItem[]; nextBefore: string | null }> {
  const ws = ctx.principal.workspaceId;
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  if (q.prospectId && !isUuid(q.prospectId)) throw badRequest('prospectId must be a UUID');
  const before = q.before ? new Date(q.before) : null;
  if (before && Number.isNaN(before.getTime())) throw badRequest('before must be ISO 8601');
  const kinds = new Set(q.kinds?.length ? q.kinds : ['email', 'sms', 'imessage', 'a2a', 'call']);
  const timeOf = {
    email: (e: typeof emails.$inferSelect) => e.date ?? e.createdAt,
    // when Cooks learned of it: inbound rows are created on receipt, outbound on send
    message: (m: MessageRow) => m.createdAt,
    call: (c: typeof calls.$inferSelect) => c.time ?? c.createdAt,
  };
  const [es, ms, cs] = await Promise.all([
    kinds.has('email')
      ? ctx.db
          .select()
          .from(emails)
          .where(and(tenantWhere(emails, ws), ...(q.prospectId ? [eq(emails.prospectId, q.prospectId)] : []), ...(q.direction ? [eq(emails.direction, q.direction)] : []), ...(before ? [lt(emails.createdAt, before)] : []), isNull(emails.deletedAt)))
          .orderBy(desc(emails.createdAt))
          .limit(limit)
      : [],
    kinds.has('sms') || kinds.has('imessage') || kinds.has('a2a')
      ? ctx.db
          .select()
          .from(messages)
          .where(and(tenantWhere(messages, ws), ...(q.prospectId ? [eq(messages.prospectId, q.prospectId)] : []), ...(q.direction ? [eq(messages.direction, q.direction)] : []), ...(before ? [lt(messages.createdAt, before)] : []), inArray(messages.channel, [...kinds].filter((k) => k === 'sms' || k === 'imessage' || k === 'a2a') as MessageRow['channel'][])))
          .orderBy(desc(messages.createdAt))
          .limit(limit)
      : [],
    kinds.has('call')
      ? ctx.db
          .select()
          .from(calls)
          .where(and(tenantWhere(calls, ws), ...(q.prospectId ? [eq(calls.prospectId, q.prospectId)] : []), ...(q.direction ? [eq(calls.direction, q.direction)] : []), ...(before ? [lt(calls.createdAt, before)] : []), isNull(calls.deletedAt)))
          .orderBy(desc(calls.createdAt))
          .limit(limit)
      : [],
  ]);
  const pids = [...new Set([...es.map((e) => e.prospectId), ...ms.map((m) => m.prospectId), ...cs.map((c) => c.prospectId)].filter((x): x is string => !!x))];
  const ps = pids.length ? await ctx.db.select({ id: prospects.id, name: prospects.name }).from(prospects).where(inArray(prospects.id, pids)) : [];
  const pmap = new Map(ps.map((p) => [p.id, p]));
  const prospectOf = (id: string | null) => (id && pmap.get(id) ? { id, name: pmap.get(id)!.name } : id ? { id, name: null } : null);
  const snippet = (t: string | null | undefined) => (t ? t.replace(/\s+/g, ' ').trim().slice(0, 500) : null);
  const items: InboxItem[] = [
    ...es.map((e): InboxItem => ({ id: e.id, kind: 'email', direction: e.direction, at: timeOf.email(e).toISOString(), from: e.fromAddr, to: e.toAddr, subject: e.subject, text: snippet(e.bodyText), status: e.status, prospect: prospectOf(e.prospectId), provider: e.type, meta: { openCount: e.openCount, clickCount: e.clickCount, repliedAt: iso(e.repliedAt), bouncedAt: iso(e.bouncedAt), sequenceStateId: e.sequenceStateId, autoSubmitted: e.autoSubmitted, messageId: e.messageId } })),
    ...ms.map((m): InboxItem => ({ id: m.id, kind: m.channel, direction: m.direction, at: timeOf.message(m).toISOString(), from: m.fromAddr, to: m.toAddr, subject: null, text: snippet(m.body), status: m.status, prospect: prospectOf(m.prospectId), provider: m.provider, meta: { mediaUrls: m.mediaUrls, conversationId: m.conversationId, blockReason: m.blockReason, error: m.error, repliedAt: iso(m.repliedAt), sequenceStateId: m.sequenceStateId, autoSubmitted: m.autoSubmitted } })),
    ...cs.map((c): InboxItem => ({ id: c.id, kind: 'call', direction: c.direction, at: timeOf.call(c).toISOString(), from: c.fromNumber, to: c.toNumber, subject: null, text: snippet(c.summary ?? c.notes), status: c.outcome ?? c.status, prospect: prospectOf(c.prospectId), provider: c.provider, meta: { durationSeconds: c.durationSeconds, mode: c.mode, outcome: c.outcome, recordingUrl: c.recordingUrl, transcriptStatus: c.transcriptStatus, loggedAt: iso(c.loggedAt), costUsd: c.costUsd === null ? null : Number(c.costUsd) } })),
  ]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .slice(0, limit);
  return { items, nextBefore: items.length === limit ? items[items.length - 1]!.at : null };
}
