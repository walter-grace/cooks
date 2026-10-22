import { and, eq, type SQL } from 'drizzle-orm';
import { accounts } from '@cooks/db';
import type { Ctx } from '../context.js';
import { notFound } from '../errors.js';
import type { PageArgs } from '../pagination.js';
import { parseBool } from '../query.js';
import { ciEq, idFilter, isoReq, paginate, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

export type AccountRow = typeof accounts.$inferSelect;

export function serializeAccount(a: AccountRow, opts: { customFields: boolean }) {
  return {
    id: a.id,
    name: a.name,
    domain: a.domain,
    numEmployees: a.numEmployees,
    linkedInUrl: a.linkedInUrl,
    description: a.description,
    crmCustomFields: opts.customFields ? a.crmCustomFields : {},
    createdAt: isoReq(a.createdAt),
    updatedAt: isoReq(a.updatedAt),
  };
}

export async function listAccounts(
  ctx: Ctx,
  q: { page: PageArgs; filter?: Record<string, unknown>; includeCRMCustomFields?: unknown; requestUrl: string },
) {
  const f = q.filter ?? {};
  const conds: SQL[] = [tenantWhere(accounts, ctx.principal.workspaceId)];
  const idc = idFilter(accounts.id, f.id);
  if (idc) conds.push(idc);
  if (typeof f.name === 'string' && f.name) conds.push(ciEq(accounts.name, f.name));
  if (typeof f.domain === 'string' && f.domain) conds.push(ciEq(accounts.domain, f.domain));
  if (typeof f.crmId === 'string' && f.crmId) conds.push(eq(accounts.crmId, f.crmId));
  conds.push(...updatedAtFilter(accounts.updatedAt, f, 'lt'));
  const customFields = parseBool(q.includeCRMCustomFields, 'includeCRMCustomFields') ?? false;
  const page = await paginate({
    table: accounts,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(accounts)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: page.data.map((a) => serializeAccount(a, { customFields })), links: page.links };
}

export async function getAccountRow(ctx: Ctx, id: string): Promise<AccountRow> {
  uuidOr404(id, 'Account');
  const [row] = await ctx.db
    .select()
    .from(accounts)
    .where(and(tenantWhere(accounts, ctx.principal.workspaceId), eq(accounts.id, id)))
    .limit(1);
  if (!row) throw notFound('Account');
  return row;
}

export async function getAccount(ctx: Ctx, id: string, includeCRMCustomFields?: unknown) {
  const row = await getAccountRow(ctx, id);
  return serializeAccount(row, { customFields: parseBool(includeCRMCustomFields, 'includeCRMCustomFields') ?? false });
}

export interface AccountInput {
  name?: string | null;
  domain?: string | null;
  numEmployees?: number | null;
  linkedInUrl?: string | null;
  description?: string | null;
  crmId?: string | null;
  timezone?: string | null;
  crmCustomFields?: Record<string, unknown>;
}

export async function createAccount(ctx: Ctx, input: AccountInput) {
  const [row] = await ctx.db
    .insert(accounts)
    .values({ workspaceId: ctx.principal.workspaceId, ...input, crmCustomFields: input.crmCustomFields ?? {} })
    .returning();
  return serializeAccount(row!, { customFields: true });
}

export async function updateAccount(ctx: Ctx, id: string, input: AccountInput) {
  await getAccountRow(ctx, id);
  const [row] = await ctx.db
    .update(accounts)
    .set({ ...input })
    .where(and(eq(accounts.id, id), eq(accounts.workspaceId, ctx.principal.workspaceId)))
    .returning();
  return serializeAccount(row!, { customFields: true });
}
