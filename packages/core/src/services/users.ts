import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { users, workspaceMembers } from '@cooks/db';
import type { Ctx } from '../context.js';
import { notFound } from '../errors.js';
import type { PageArgs } from '../pagination.js';
import { ciEq, iso, isoReq, paginate, updatedAtFilter, uuidOr404 } from './_shared.js';

export type UserRow = typeof users.$inferSelect;

export function serializeUser(u: UserRow) {
  return { id: u.id, name: u.name, email: u.email, crmId: u.crmId, createdAt: isoReq(u.createdAt), updatedAt: isoReq(u.updatedAt) };
}

export async function listUsers(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; requestUrl: string }) {
  const f = q.filter ?? {};
  const conds: SQL[] = [eq(workspaceMembers.workspaceId, ctx.principal.workspaceId)];
  if (typeof f.name === 'string' && f.name) conds.push(ciEq(users.name, f.name));
  if (typeof f.email === 'string' && f.email) conds.push(ciEq(users.email, f.email));
  if (typeof f.crmId === 'string' && f.crmId) conds.push(eq(users.crmId, f.crmId));
  conds.push(...updatedAtFilter(users.updatedAt, f, 'lt'));
  const page = await paginate({
    table: users,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select({ u: users })
        .from(users)
        .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit)
        .then((rows) => rows.map((r) => r.u)),
  });
  return { data: page.data.map(serializeUser), links: page.links };
}

export async function getUser(ctx: Ctx, id: string) {
  uuidOr404(id, 'User');
  const [row] = await ctx.db
    .select({ u: users })
    .from(users)
    .innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id))
    .where(and(eq(workspaceMembers.workspaceId, ctx.principal.workspaceId), eq(users.id, id)))
    .limit(1);
  if (!row) throw notFound('User');
  return serializeUser(row.u);
}

export async function usersByIds(ctx: Ctx, ids: string[]): Promise<Map<string, UserRow>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db.select().from(users).where(inArray(users.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}

export { iso };
