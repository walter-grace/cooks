import { and, desc, eq, isNull } from 'drizzle-orm';
import { apiKeys, workspaces, type WorkspaceSettings } from '@cooks/db';
import type { Ctx } from '../context.js';
import { insufficientPermission, notFound } from '../errors.js';
import { isManagerOrAdmin } from '../principal.js';
import { iso, isoReq, uuidOr404 } from './_shared.js';

export async function getWorkspace(ctx: Ctx) {
  const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ctx.principal.workspaceId)).limit(1);
  if (!ws) throw notFound('Workspace');
  return { id: ws.id, name: ws.name, slug: ws.slug, settings: ws.settings, createdAt: isoReq(ws.createdAt), updatedAt: isoReq(ws.updatedAt) };
}

/** Admins (and API keys) may change settings; settings merge shallowly. */
export async function updateWorkspace(ctx: Ctx, input: { name?: string; settings?: WorkspaceSettings }) {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission('Only admins can change workspace settings');
  const current = await getWorkspace(ctx);
  const [ws] = await ctx.db
    .update(workspaces)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.settings !== undefined ? { settings: { ...current.settings, ...input.settings } } : {}),
    })
    .where(eq(workspaces.id, ctx.principal.workspaceId))
    .returning();
  return { id: ws!.id, name: ws!.name, slug: ws!.slug, settings: ws!.settings, createdAt: isoReq(ws!.createdAt), updatedAt: isoReq(ws!.updatedAt) };
}

export const serializeApiKey = (k: typeof apiKeys.$inferSelect) => ({
  id: k.id,
  name: k.name,
  keyId: k.keyId,
  prefix: k.prefix,
  createdBy: k.createdBy,
  lastUsedAt: iso(k.lastUsedAt),
  revokedAt: iso(k.revokedAt),
  createdAt: isoReq(k.createdAt),
});

export async function listApiKeys(ctx: Ctx) {
  if (!isManagerOrAdmin(ctx.principal)) throw insufficientPermission('Only managers and admins can view API keys');
  const rows = await ctx.db.select().from(apiKeys).where(and(eq(apiKeys.workspaceId, ctx.principal.workspaceId), isNull(apiKeys.revokedAt))).orderBy(desc(apiKeys.createdAt));
  return rows.map(serializeApiKey);
}

export function assertCanManageKeys(ctx: Ctx) {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission('Only admins can manage API keys');
}

export async function getApiKeyRow(ctx: Ctx, id: string) {
  uuidOr404(id, 'API key');
  const [row] = await ctx.db.select().from(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, ctx.principal.workspaceId))).limit(1);
  if (!row) throw notFound('API key');
  return row;
}
