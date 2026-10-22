import type { Scope } from './scopes.js';
import { SCOPES } from './scopes.js';
import { insufficientPermission, insufficientScope } from './errors.js';

export type Role = 'user' | 'manager' | 'admin';

export interface Principal {
  workspaceId: string;
  /** null for API keys */
  userId: string | null;
  role: Role | null;
  authType: 'apiKey' | 'oauth';
  clientId: string | null;
  apiKeyId?: string;
  scopes: ReadonlySet<Scope>;
  /** API keys are workspace-wide: role checks do not apply. */
  bypassRoleChecks: boolean;
  email?: string | null;
  name?: string | null;
}

export const ALL_SCOPES: ReadonlySet<Scope> = new Set(SCOPES);

export function assertScope(p: Principal, scope: Scope | undefined): void {
  if (!scope) return;
  if (!p.scopes.has(scope)) throw insufficientScope(scope);
}

export function isManagerOrAdmin(p: Principal): boolean {
  return p.bypassRoleChecks || p.role === 'manager' || p.role === 'admin';
}

/** Owner, manager, admin or API key may act; others are rejected. */
export function assertOwnerOrManager(p: Principal, ownerId: string | null | undefined, what: string): void {
  if (isManagerOrAdmin(p)) return;
  if (p.userId && ownerId === p.userId) return;
  throw insufficientPermission(`Only the owner or a manager can ${what}`);
}

export function canReadPrivacy(p: Principal, privacy: 'private' | 'team_visible' | 'team_editable', ownerId: string): boolean {
  if (privacy !== 'private') return true;
  return isManagerOrAdmin(p) || p.userId === ownerId;
}

export function assertCanEditPrivacy(
  p: Principal,
  privacy: 'private' | 'team_visible' | 'team_editable',
  ownerId: string,
  what: string,
): void {
  if (privacy === 'team_editable') return;
  assertOwnerOrManager(p, ownerId, what);
}

/** Worker-side principal: acts for a workspace with every scope and no role restrictions. */
export function systemPrincipal(workspaceId: string): Principal {
  return { workspaceId, userId: null, role: null, authType: 'apiKey', clientId: null, scopes: ALL_SCOPES, bypassRoleChecks: true, email: null, name: 'system' };
}
