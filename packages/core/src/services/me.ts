import type { Ctx } from '../context.js';

export function getMe(ctx: Ctx) {
  const p = ctx.principal;
  return {
    workspaceId: p.workspaceId,
    userId: p.userId,
    email: p.email ?? null,
    name: p.name ?? null,
    authType: p.authType,
    clientId: p.clientId,
    scopes: [...p.scopes],
  };
}
