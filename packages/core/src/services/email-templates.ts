import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { emailTemplates } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, notFound } from '../errors.js';
import { refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { parseBool } from '../query.js';
import { isUuid, isoReq, paginate, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

export type TemplateRow = typeof emailTemplates.$inferSelect;

export function serializeTemplate(t: TemplateRow) {
  return {
    id: t.id,
    name: t.name,
    subject: t.subject,
    htmlBody: t.htmlBody,
    source: t.source,
    archived: t.archived,
    order: t.order,
    owner: refOrNull('users', t.ownerId),
    privacy: t.privacy,
    createdAt: isoReq(t.createdAt),
    updatedAt: isoReq(t.updatedAt),
  };
}

export async function listEmailTemplates(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; requestUrl: string }) {
  const f = q.filter ?? {};
  const conds: SQL[] = [tenantWhere(emailTemplates, ctx.principal.workspaceId)];
  const owner = (f.owner as Record<string, unknown> | undefined)?.id;
  if (typeof owner === 'string' && owner) {
    if (!isUuid(owner)) throw badRequest('filter[owner][id] must be a UUID');
    conds.push(eq(emailTemplates.ownerId, owner));
  }
  const archived = parseBool(f.archived, 'filter[archived]');
  if (archived !== undefined) conds.push(eq(emailTemplates.archived, archived));
  conds.push(...updatedAtFilter(emailTemplates.updatedAt, f, 'lt'));
  const page = await paginate({
    table: emailTemplates,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(emailTemplates)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: page.data.map(serializeTemplate), links: page.links };
}

export async function getEmailTemplate(ctx: Ctx, id: string) {
  uuidOr404(id, 'Email template');
  const [row] = await ctx.db
    .select()
    .from(emailTemplates)
    .where(and(tenantWhere(emailTemplates, ctx.principal.workspaceId), eq(emailTemplates.id, id)))
    .limit(1);
  if (!row) throw notFound('Email template');
  return serializeTemplate(row);
}

export async function templatesByIds(ctx: Ctx, ids: string[]): Promise<Map<string, TemplateRow>> {
  if (ids.length === 0) return new Map();
  const rows = await ctx.db.select().from(emailTemplates).where(inArray(emailTemplates.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r]));
}
