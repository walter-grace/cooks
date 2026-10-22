import { and, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { callDispositions, calls, prospects, sequenceSteps, sequences } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { parseInclude, refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { parseDate } from '../query.js';
import { serializeProspect } from './prospects.js';
import { serializeSequences } from './sequences.js';
import { serializeStep } from './sequence-steps.js';
import { serializeUser, usersByIds } from './users.js';
import { ciEq, idFilter, iso, isUuid, isoReq, paginate, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

export type CallRow = typeof calls.$inferSelect;
export type DispositionRow = typeof callDispositions.$inferSelect;
export const CALL_INCLUDES = ['prospect', 'sequence', 'sequenceStep', 'callDisposition', 'owner'] as const;

export const serializeDisposition = (d: DispositionRow) => ({ id: d.id, name: d.name, callOutcome: d.callOutcome, order: d.order, createdAt: isoReq(d.createdAt), updatedAt: isoReq(d.updatedAt) });

export function serializeCall(c: CallRow, x: Record<string, unknown> = {}) {
  return {
    id: c.id,
    source: c.source,
    duration: c.durationSeconds,
    from: c.fromNumber,
    to: c.toNumber,
    direction: c.direction,
    recordingUrl: c.recordingUrl,
    time: isoReq(c.time),
    prospect: x.prospect ?? refOrNull('prospects', c.prospectId),
    sequence: x.sequence ?? refOrNull('sequences', c.sequenceId),
    sequenceStep: x.sequenceStep ?? refOrNull('sequenceSteps', c.sequenceStepId),
    callDisposition: x.callDisposition ?? refOrNull('callDispositions', c.callDispositionId),
    owner: x.owner ?? refOrNull('users', c.ownerId),
    createdAt: isoReq(c.createdAt),
    updatedAt: isoReq(c.updatedAt),
    // Cooks extensions
    status: c.status,
    notes: c.notes,
    loggedAt: iso(c.loggedAt),
    endedAt: iso(c.endedAt),
    mode: c.mode,
    account: refOrNull('accounts', c.accountId),
    taskId: c.taskId,
    recordingDurationSeconds: c.recordingDurationSeconds,
    transcriptStatus: c.transcriptStatus,
    coachingStatus: c.coachingStatus,
    amdResult: c.amdResult,
  };
}

async function serializeCalls(ctx: Ctx, rows: CallRow[], includes: string[]) {
  if (!includes.length || !rows.length) return rows.map((r) => serializeCall(r));
  const pick = (k: keyof CallRow) => [...new Set(rows.map((r) => r[k]).filter((v): v is string => typeof v === 'string'))];
  const [ps, seqs, steps, disps, owners] = await Promise.all([
    includes.includes('prospect') && pick('prospectId').length ? ctx.db.select().from(prospects).where(inArray(prospects.id, pick('prospectId'))) : [],
    includes.includes('sequence') && pick('sequenceId').length ? ctx.db.select().from(sequences).where(inArray(sequences.id, pick('sequenceId'))).then((rs) => serializeSequences(ctx, rs, [])) : [],
    includes.includes('sequenceStep') && pick('sequenceStepId').length ? ctx.db.select().from(sequenceSteps).where(inArray(sequenceSteps.id, pick('sequenceStepId'))) : [],
    includes.includes('callDisposition') && pick('callDispositionId').length ? ctx.db.select().from(callDispositions).where(inArray(callDispositions.id, pick('callDispositionId'))) : [],
    includes.includes('owner') ? usersByIds(ctx, pick('ownerId')) : new Map(),
  ]);
  const m = {
    p: new Map(ps.map((p) => [p.id, serializeProspect(p, { customFields: false, states: [] })])),
    s: new Map(seqs.map((s) => [s.id, s])),
    st: new Map(steps.map((s) => [s.id, serializeStep(s, undefined, undefined)])),
    d: new Map(disps.map((d) => [d.id, serializeDisposition(d)])),
  };
  return rows.map((r) =>
    serializeCall(r, {
      prospect: r.prospectId ? m.p.get(r.prospectId) : undefined,
      sequence: r.sequenceId ? m.s.get(r.sequenceId) : undefined,
      sequenceStep: r.sequenceStepId ? m.st.get(r.sequenceStepId) : undefined,
      callDisposition: r.callDispositionId ? m.d.get(r.callDispositionId) : undefined,
      owner: r.ownerId && owners.get(r.ownerId) ? serializeUser(owners.get(r.ownerId)!) : undefined,
    }),
  );
}

export async function listCalls(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; include?: unknown; requestUrl: string }) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, CALL_INCLUDES);
  const conds: SQL[] = [tenantWhere(calls, ctx.principal.workspaceId)];
  const idc = idFilter(calls.id, f.id);
  if (idc) conds.push(idc);
  for (const [key, col] of [
    ['prospect', calls.prospectId],
    ['account', calls.accountId],
    ['callDisposition', calls.callDispositionId],
    ['owner', calls.ownerId],
  ] as const) {
    const v = (f[key] as Record<string, unknown> | undefined)?.id;
    if (typeof v === 'string' && v) {
      if (!isUuid(v)) throw badRequest(`filter[${key}][id] must be a UUID`);
      conds.push(eq(col, v));
    }
  }
  if (typeof f.status === 'string' && f.status) conds.push(eq(calls.status, f.status));
  if (f.logged === 'true') conds.push(sql`${calls.loggedAt} is not null`);
  if (f.logged === 'false') conds.push(sql`${calls.loggedAt} is null`);
  for (const [key, col] of [
    ['time', calls.time],
    ['createdAt', calls.createdAt],
  ] as const) {
    const r = (f[key] ?? {}) as Record<string, unknown>;
    const g = parseDate(r.gte, `filter[${key}][gte]`);
    const l = parseDate(r.lte, `filter[${key}][lte]`);
    if (g) conds.push(gte(col, g));
    if (l) conds.push(lte(col, l));
  }
  conds.push(...updatedAtFilter(calls.updatedAt, f, 'lt'));
  const page = await paginate({
    table: calls,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(calls)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: await serializeCalls(ctx, page.data, includes), links: page.links };
}

export async function getCall(ctx: Ctx, id: string, include?: unknown) {
  uuidOr404(id, 'Call');
  const includes = parseInclude(include, CALL_INCLUDES);
  const [row] = await ctx.db
    .select()
    .from(calls)
    .where(and(tenantWhere(calls, ctx.principal.workspaceId), eq(calls.id, id)))
    .limit(1);
  if (!row) throw notFound('Call');
  return (await serializeCalls(ctx, [row], includes))[0]!;
}

export async function listCallDispositions(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; requestUrl: string }) {
  const f = q.filter ?? {};
  const conds: SQL[] = [tenantWhere(callDispositions, ctx.principal.workspaceId)];
  const idc = idFilter(callDispositions.id, f.id);
  if (idc) conds.push(idc);
  if (typeof f.name === 'string' && f.name) conds.push(ciEq(callDispositions.name, f.name));
  const page = await paginate({
    table: callDispositions,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(callDispositions)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: page.data.map(serializeDisposition), links: page.links };
}

export async function getCallDisposition(ctx: Ctx, id: string) {
  uuidOr404(id, 'Call disposition');
  const [row] = await ctx.db
    .select()
    .from(callDispositions)
    .where(and(tenantWhere(callDispositions, ctx.principal.workspaceId), eq(callDispositions.id, id)))
    .limit(1);
  if (!row) throw notFound('Call disposition');
  return serializeDisposition(row);
}
