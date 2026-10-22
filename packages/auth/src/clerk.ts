import { and, eq } from 'drizzle-orm';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { users, workspaceMembers, workspaces, type DbOrTx } from '@cooks/db';

export interface ClerkClaims {
  userId: string;
  orgId: string | null;
  orgSlug: string | null;
  orgRole: string | null;
}
export interface ClerkProfile {
  email: string;
  name: string;
}
export interface ClerkProviderToken {
  token: string;
  scopes?: string[];
  expiresAt?: number | null;
  externalAccountId?: string;
}

/** The slice of Clerk Cooks needs. Swappable so tests run without Clerk. */
export interface ClerkGateway {
  verify(sessionToken: string): Promise<ClerkClaims | null>;
  getProfile(userId: string): Promise<ClerkProfile | null>;
  getProviderToken(userId: string, provider: 'google' | 'microsoft' | 'hubspot'): Promise<ClerkProviderToken | null>;
}

export function clerkGateway(secretKey: string, opts: { publishableKey?: string; jwtKey?: string } = {}): ClerkGateway {
  const client = createClerkClient({ secretKey, publishableKey: opts.publishableKey });
  return {
    async verify(sessionToken) {
      try {
        const r = await verifyToken(sessionToken, { secretKey, jwtKey: opts.jwtKey });
        const p = (r as { data?: Record<string, unknown> }).data ?? (r as Record<string, unknown>);
        const sub = p.sub as string | undefined;
        if (!sub) return null;
        const o = (p.o as { id?: string; slg?: string; rol?: string } | undefined) ?? undefined; // v2 claims
        return {
          userId: sub,
          orgId: (p.org_id as string | undefined) ?? o?.id ?? null,
          orgSlug: (p.org_slug as string | undefined) ?? o?.slg ?? null,
          orgRole: (p.org_role as string | undefined) ?? (o?.rol ? `org:${o.rol}` : null) ?? null,
        };
      } catch {
        return null;
      }
    },
    async getProfile(userId) {
      try {
        const u = await client.users.getUser(userId);
        const primary = u.emailAddresses.find((e) => e.id === u.primaryEmailAddressId) ?? u.emailAddresses[0];
        if (!primary) return null;
        return { email: primary.emailAddress.toLowerCase(), name: [u.firstName, u.lastName].filter(Boolean).join(' ') || primary.emailAddress.split('@')[0]! };
      } catch {
        return null;
      }
    },
    async getProviderToken(userId, provider) {
      try {
        const res = await client.users.getUserOauthAccessToken(userId, provider);
        const t = res.data[0];
        if (!t) return null;
        return { token: t.token, scopes: t.scopes, expiresAt: (t as { expiresAt?: number | null }).expiresAt ?? null, externalAccountId: t.externalAccountId };
      } catch {
        return null;
      }
    },
  };
}

export interface ClerkMappingOptions {
  /** Join this workspace when the Clerk session has no organization (single-tenant installs). */
  defaultWorkspaceSlug?: string;
}

/**
 * Resolve a Clerk session into a Cooks user + workspace membership, creating what is missing.
 * Clerk organizations become workspaces (admins from org:admin); users without an org join the
 * default workspace or get a personal one.
 */
export async function ensureClerkUser(db: DbOrTx, claims: ClerkClaims, rawProfile: ClerkProfile, opts: ClerkMappingOptions = {}) {
  const profile = { ...rawProfile, email: rawProfile.email.toLowerCase().trim() };
  let [user] = await db.select().from(users).where(eq(users.clerkUserId, claims.userId)).limit(1);
  if (!user) {
    const [byEmail] = await db.select().from(users).where(eq(users.email, profile.email)).limit(1);
    if (byEmail) [user] = await db.update(users).set({ clerkUserId: claims.userId, name: byEmail.name || profile.name }).where(eq(users.id, byEmail.id)).returning();
    else [user] = await db.insert(users).values({ email: profile.email, name: profile.name, clerkUserId: claims.userId }).returning();
  }
  let workspaceId: string;
  let role: 'user' | 'manager' | 'admin' = 'user';
  if (claims.orgId) {
    let [ws] = await db.select().from(workspaces).where(eq(workspaces.clerkOrgId, claims.orgId)).limit(1);
    if (!ws) {
      const base = (claims.orgSlug ?? claims.orgId.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 60);
      let slug = base;
      for (let i = 2; (await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1)).length; i++) slug = `${base}-${i}`;
      [ws] = await db.insert(workspaces).values({ name: claims.orgSlug ?? 'Workspace', slug, clerkOrgId: claims.orgId }).returning();
    }
    workspaceId = ws!.id;
    role = claims.orgRole === 'org:admin' ? 'admin' : 'user';
  } else if (opts.defaultWorkspaceSlug) {
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, opts.defaultWorkspaceSlug)).limit(1);
    if (!ws) throw new Error(`Default workspace ${opts.defaultWorkspaceSlug} does not exist`);
    workspaceId = ws.id;
    const anyMember = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(eq(workspaceMembers.workspaceId, ws.id)).limit(1);
    role = anyMember.length ? 'user' : 'admin';
  } else {
    const slug = `u-${claims.userId.replace(/^user_/, '').toLowerCase().slice(0, 24)}`;
    let [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    if (!ws) [ws] = await db.insert(workspaces).values({ name: `${profile.name}'s workspace`, slug }).returning();
    workspaceId = ws!.id;
    role = 'admin';
  }
  const [m] = await db.select().from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user!.id))).limit(1);
  if (!m) await db.insert(workspaceMembers).values({ workspaceId, userId: user!.id, role });
  else if (claims.orgId && m.role !== role && role === 'admin') await db.update(workspaceMembers).set({ role }).where(eq(workspaceMembers.id, m.id));
  return { user: user!, workspaceId, role };
}
