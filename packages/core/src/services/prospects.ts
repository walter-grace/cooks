import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { accounts, prospects, sequenceStates } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { emitEvent } from '../events.js';
import { parseInclude, ref, refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { parseBool } from '../query.js';
import { ciEq, idFilter, isoReq, isUuid, paginate, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

export type ProspectRow = typeof prospects.$inferSelect;
export const PROSPECT_INCLUDES = ['sequenceStates'] as const;

export function fullName(first: string | null | undefined, last: string | null | undefined, fallback: string | null | undefined) {
  const n = [first, last].filter(Boolean).join(' ').trim();
  return n || fallback || null;
}

export function serializeProspect(
  p: ProspectRow,
  opts: { customFields: boolean; states: Array<string | object> },
) {
  return {
    id: p.id,
    name: p.name,
    firstName: p.firstName,
    lastName: p.lastName,
    title: p.title,
    primaryEmail: p.primaryEmail,
    linkedInUrl: p.linkedInUrl,
    phone: p.phone,
    timezone: p.timezone,
    city: p.city,
    state: p.state,
    country: p.country,
    crmId: p.crmId,
    account: refOrNull('accounts', p.accountId),
    sequenceStates: opts.states.map((s) => (typeof s === 'string' ? ref('sequenceStates', s) : s)) as unknown[],
    crmCustomFields: opts.customFields ? p.crmCustomFields : {},
    createdAt: isoReq(p.createdAt),
    updatedAt: isoReq(p.updatedAt),
  };
}

/** Enrollment ids per prospect (unexpanded refs), or expanded rows when requested. */
async function statesFor(
  ctx: Ctx,
  prospectIds: string[],
  expand: boolean,
  serializeState: (row: typeof sequenceStates.$inferSelect) => object,
): Promise<Map<string, Array<string | object>>> {
  const map = new Map<string, Array<string | object>>();
  if (prospectIds.length === 0) return map;
  const rows = await ctx.db
    .select()
    .from(sequenceStates)
    .where(and(tenantWhere(sequenceStates, ctx.principal.workspaceId), inArray(sequenceStates.prospectId, prospectIds)));
  for (const r of rows) {
    const list = map.get(r.prospectId) ?? [];
    list.push(expand ? serializeState(r) : r.id);
    map.set(r.prospectId, list);
  }
  return map;
}

export interface ProspectListQuery {
  page: PageArgs;
  filter?: Record<string, unknown>;
  include?: unknown;
  includeCRMCustomFields?: unknown;
  requestUrl: string;
}

export async function listProspects(
  ctx: Ctx,
  q: ProspectListQuery,
  serializeState: (row: typeof sequenceStates.$inferSelect) => object,
) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, PROSPECT_INCLUDES);
  const conds: SQL[] = [tenantWhere(prospects, ctx.principal.workspaceId)];
  const idc = idFilter(prospects.id, f.id);
  if (idc) conds.push(idc);
  if (typeof f.name === 'string' && f.name) conds.push(ciEq(prospects.name, f.name));
  if (typeof f.title === 'string' && f.title) conds.push(ciEq(prospects.title, f.title));
  if (typeof f.primaryEmail === 'string' && f.primaryEmail) conds.push(ciEq(prospects.primaryEmail, f.primaryEmail));
  if (typeof f.crmId === 'string' && f.crmId) conds.push(eq(prospects.crmId, f.crmId));
  const acc = (f.account as Record<string, unknown> | undefined)?.id;
  if (typeof acc === 'string' && acc) {
    if (!isUuid(acc)) throw badRequest('filter[account][id] must be a UUID');
    conds.push(eq(prospects.accountId, acc));
  }
  const seq = (f.sequence as Record<string, unknown> | undefined)?.id;
  if (typeof seq === 'string' && seq) {
    if (!isUuid(seq)) throw badRequest('filter[sequence][id] must be a UUID');
    const sub = ctx.db
      .select({ pid: sequenceStates.prospectId })
      .from(sequenceStates)
      .where(and(tenantWhere(sequenceStates, ctx.principal.workspaceId), eq(sequenceStates.sequenceId, seq)));
    conds.push(inArray(prospects.id, sub));
  }
  conds.push(...updatedAtFilter(prospects.updatedAt, f, 'lte'));
  const customFields = parseBool(q.includeCRMCustomFields, 'includeCRMCustomFields') ?? false;

  const page = await paginate({
    table: prospects,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(prospects)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  const states = await statesFor(
    ctx,
    page.data.map((p) => p.id),
    includes.includes('sequenceStates'),
    serializeState,
  );
  return {
    data: page.data.map((p) => serializeProspect(p, { customFields, states: states.get(p.id) ?? [] })),
    links: page.links,
  };
}

export async function getProspectRow(ctx: Ctx, id: string): Promise<ProspectRow> {
  uuidOr404(id, 'Prospect');
  const [row] = await ctx.db
    .select()
    .from(prospects)
    .where(and(tenantWhere(prospects, ctx.principal.workspaceId), eq(prospects.id, id)))
    .limit(1);
  if (!row) throw notFound('Prospect');
  return row;
}

export async function getProspect(
  ctx: Ctx,
  id: string,
  q: { include?: unknown; includeCRMCustomFields?: unknown },
  serializeState: (row: typeof sequenceStates.$inferSelect) => object,
) {
  const includes = parseInclude(q.include, PROSPECT_INCLUDES);
  const row = await getProspectRow(ctx, id);
  const states = await statesFor(ctx, [row.id], includes.includes('sequenceStates'), serializeState);
  return serializeProspect(row, {
    customFields: parseBool(q.includeCRMCustomFields, 'includeCRMCustomFields') ?? false,
    states: states.get(row.id) ?? [],
  });
}

export interface ProspectInput {
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  title?: string | null;
  primaryEmail?: string | null;
  phone?: string | null;
  linkedInUrl?: string | null;
  timezone?: string | null;
  crmId?: string | null;
  account?: { id: string } | null;
  crmCustomFields?: Record<string, unknown>;
  ownerId?: string | null;
}

async function resolveAccount(ctx: Ctx, account: ProspectInput['account']): Promise<string | null | undefined> {
  if (account === undefined) return undefined;
  if (account === null) return null;
  if (!isUuid(account.id)) throw unprocessable('account.id does not reference an account in this workspace', { field: 'account.id' });
  const [a] = await ctx.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(tenantWhere(accounts, ctx.principal.workspaceId), eq(accounts.id, account.id)))
    .limit(1);
  if (!a) throw unprocessable('account.id does not reference an account in this workspace', { field: 'account.id' });
  return a.id;
}

export async function createProspect(ctx: Ctx, input: ProspectInput) {
  const accountId = await resolveAccount(ctx, input.account);
  const { account: _a, ...rest } = input;
  if (!rest.firstName && !rest.lastName && !rest.name && !rest.primaryEmail) {
    throw badRequest('Provide at least a name or primaryEmail');
  }
  const [row] = await ctx.db
    .insert(prospects)
    .values({
      workspaceId: ctx.principal.workspaceId,
      ...rest,
      name: fullName(rest.firstName, rest.lastName, rest.name),
      accountId: accountId ?? null,
      crmCustomFields: rest.crmCustomFields ?? {},
    })
    .returning();
  await emitEvent(ctx.db, {
    workspaceId: ctx.principal.workspaceId,
    type: 'prospect.created',
    aggregateType: 'prospect',
    aggregateId: row!.id,
    payload: { prospectId: row!.id },
  });
  return serializeProspect(row!, { customFields: true, states: [] });
}

export async function updateProspect(ctx: Ctx, id: string, input: ProspectInput) {
  const existing = await getProspectRow(ctx, id);
  const accountId = await resolveAccount(ctx, input.account);
  const { account: _a, ...rest } = input;
  const first = rest.firstName === undefined ? existing.firstName : rest.firstName;
  const last = rest.lastName === undefined ? existing.lastName : rest.lastName;
  const explicitName = rest.name === undefined ? existing.name : rest.name;
  const [row] = await ctx.db
    .update(prospects)
    .set({
      ...rest,
      name: rest.firstName !== undefined || rest.lastName !== undefined ? fullName(first, last, explicitName) : explicitName,
      ...(accountId !== undefined ? { accountId } : {}),
    })
    .where(and(eq(prospects.id, id), eq(prospects.workspaceId, ctx.principal.workspaceId)))
    .returning();
  await emitEvent(ctx.db, {
    workspaceId: ctx.principal.workspaceId,
    type: 'prospect.updated',
    aggregateType: 'prospect',
    aggregateId: id,
    payload: { prospectId: id },
  });
  return serializeProspect(row!, { customFields: true, states: [] });
}
