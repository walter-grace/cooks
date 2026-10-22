import { and, eq, type SQL } from 'drizzle-orm';
import { tags } from '@cooks/db';
import type { Ctx } from '../context.js';
import { notFound } from '../errors.js';
import type { PageArgs } from '../pagination.js';
import { ciEq, isoReq, paginate, tenantWhere, uuidOr404 } from './_shared.js';

export type TagRow = typeof tags.$inferSelect;
export const serializeTag = (t: TagRow) => ({ id: t.id, name: t.name, createdAt: isoReq(t.createdAt), updatedAt: isoReq(t.updatedAt) });

export async function listTags(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; requestUrl: string }) {
  const conds: SQL[] = [tenantWhere(tags, ctx.principal.workspaceId)];
  const name = q.filter?.name;
  if (typeof name === 'string' && name) conds.push(ciEq(tags.name, name));
  const page = await paginate({
    table: tags,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(tags)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: page.data.map(serializeTag), links: page.links };
}

export async function getTag(ctx: Ctx, id: string) {
  uuidOr404(id, 'Tag');
  const [row] = await ctx.db
    .select()
    .from(tags)
    .where(and(tenantWhere(tags, ctx.principal.workspaceId), eq(tags.id, id)))
    .limit(1);
  if (!row) throw notFound('Tag');
  return serializeTag(row);
}

/** Idempotent by case-insensitive name: existing → {created:false}, new → {created:true}. */
export async function createTag(ctx: Ctx, name: string) {
  const trimmed = name.trim();
  const [existing] = await ctx.db
    .select()
    .from(tags)
    .where(and(tenantWhere(tags, ctx.principal.workspaceId), ciEq(tags.name, trimmed)))
    .limit(1);
  if (existing) return { tag: serializeTag(existing), created: false };
  const [row] = await ctx.db.insert(tags).values({ workspaceId: ctx.principal.workspaceId, name: trimmed }).returning();
  return { tag: serializeTag(row!), created: true };
}
