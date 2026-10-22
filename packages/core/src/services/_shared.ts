import { and, eq, gte, isNull, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { UUID_RE, workspaceMembers, users } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { keyset, buildPage, type PageArgs } from '../pagination.js';
import { parseDate } from '../query.js';

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
export const isoReq = (d: Date): string => d.toISOString();

/** Standard tenant filter: same workspace, not soft-deleted. */
export function tenantWhere(t: { workspaceId: PgColumn; deletedAt: PgColumn }, workspaceId: string): SQL {
  return and(eq(t.workspaceId, workspaceId), isNull(t.deletedAt))!;
}

export function updatedAtFilter(col: PgColumn, filter: Record<string, unknown> | undefined, upper: 'lt' | 'lte'): SQL[] {
  const out: SQL[] = [];
  const f = (filter?.updatedAt ?? {}) as Record<string, unknown>;
  const gteD = parseDate(f.gte, 'filter[updatedAt][gte]');
  const upD = parseDate(f[upper], `filter[updatedAt][${upper}]`);
  if (gteD) out.push(gte(col, gteD));
  if (upD) out.push(upper === 'lt' ? lt(col, upD) : lte(col, upD));
  return out;
}

export function ciEq(col: PgColumn, value: string): SQL {
  return sql`lower(${col}) = lower(${value})`;
}

export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** Path ids that are not UUIDs can never match a row: answer 404, not 500. */
export function uuidOr404(id: string, what: string): string {
  if (!isUuid(id)) throw notFound(what);
  return id;
}

export function idFilter(col: PgColumn, raw: unknown, name = 'filter[id]'): SQL | undefined {
  if (raw === undefined || raw === '') return undefined;
  const ids = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return undefined;
  for (const i of ids) if (!UUID_RE.test(i)) throw badRequest(`${name} must contain UUIDs`);
  return sql`${col} IN (${sql.join(
    ids.map((i) => sql`${i}`),
    sql`, `,
  )})`;
}

/**
 * Run a keyset-paginated list query on a tenant table.
 * `select` lets the caller build the drizzle query from a where clause.
 */
export async function paginate<Row extends { id: string; createdAt: Date }>(
  args: {
    table: { createdAt: PgColumn; id: PgColumn };
    page: PageArgs;
    requestUrl: string;
    run: (where: SQL | undefined, orderBy: SQL[], limit: number) => Promise<Row[]>;
  },
) {
  const ks = keyset(args.table.createdAt, args.table.id, args.page);
  const rows = await args.run(ks.where, ks.orderBy, args.page.size + 1);
  return buildPage(rows, args.page, ks.reversed, args.requestUrl);
}

/** Resolve a user id supplied by a client (owner.id / ownerId) to a workspace member. */
export async function requireMember(ctx: Ctx, userId: string | undefined | null, field: string): Promise<string> {
  if (!userId) throw badRequest(`${field} is required`);
  if (!isUuid(userId)) throw unprocessable(`${field} does not reference a user in this workspace`, { field, value: userId });
  const [m] = await ctx.db
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, ctx.principal.workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  if (!m) throw unprocessable(`${field} does not reference a user in this workspace`, { field, value: userId });
  return m.id;
}

export async function memberIds(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.db
    .select({ id: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, ctx.principal.workspaceId));
  return rows.map((r) => r.id);
}

export async function userById(ctx: Ctx, id: string) {
  const [u] = await ctx.db.select().from(users).where(eq(users.id, id)).limit(1);
  return u ?? null;
}

export type AnyPgTable = PgTable;
