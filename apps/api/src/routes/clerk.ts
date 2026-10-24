/**
 * Clerk SSO mode. When CLERK_SECRET_KEY is set:
 *  - GET  /auth/config               → the publishable key for the web UI
 *  - POST /auth/clerk/session        → verify a Clerk session token, map user + workspace, set the Cooks cookie
 *  - POST /v1/mailboxes/from-clerk   → connect Gmail / Microsoft 365 using the token the user granted Clerk
 *  - PUT  /v1/workspace/crm/hubspot/from-clerk → connect HubSpot the same way
 */
import type { OpenAPIHono } from '@hono/zod-openapi';
import { createRoute, z } from '@hono/zod-openapi';
import { setCookie } from 'hono/cookie';
import { and, eq, ne } from 'drizzle-orm';
import { SESSION_COOKIE, createSession, ensureClerkUser, type ClerkGateway } from '@cooks/auth';
import { connectHubspot, dataOf, encrypt, errorResponses, jsonBody, jsonResponse, serializeConnection, serializeMailbox, unprocessable, type Clock, type CrmDeps } from '@cooks/core';
import { mailboxCredentials, mailboxes, users, type Db } from '@cooks/db';
import { register, type Registrar } from '../register.js';
import type { AppEnv } from '../types.js';

export interface ClerkDeps {
  gateway: ClerkGateway;
  publishableKey?: string;
  defaultWorkspaceSlug?: string;
  db: Db;
  kek?: string;
  clock: Clock;
  secureCookies: boolean;
  crm: CrmDeps;
}

export function mountClerkAuth(app: OpenAPIHono<AppEnv>, d: ClerkDeps | null, opts: { signup?: 'open' | 'invite' | 'off' } = {}) {
  app.get('/auth/config', (c) => c.json({ mode: d ? 'clerk' : 'password', clerkPublishableKey: d?.publishableKey ?? null, signup: d ? 'clerk' : (opts.signup ?? 'off') }));
  if (!d) return;
  app.post('/auth/clerk/session', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    const token = body.token ?? (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!token) return c.json({ error: 'invalid_request', error_description: 'token is required' }, 400);
    const claims = await d.gateway.verify(token);
    if (!claims) return c.json({ error: 'unauthorized', error_description: 'Clerk session is invalid or expired' }, 401);
    const profile = await d.gateway.getProfile(claims.userId);
    if (!profile) return c.json({ error: 'unauthorized', error_description: 'Clerk user has no email address' }, 401);
    const { user, workspaceId, role } = await ensureClerkUser(d.db, claims, profile, { defaultWorkspaceSlug: d.defaultWorkspaceSlug });
    const s = await createSession(d.db, user.id, d.clock.now());
    setCookie(c, SESSION_COOKIE, s.token, { httpOnly: true, sameSite: 'Lax', secure: d.secureCookies, path: '/', expires: s.expiresAt });
    return c.json({ ok: true, user: { id: user.id, email: user.email, name: user.name }, workspaceId, role });
  });
}

export function mountClerkConnectors(reg: Registrar, d: ClerkDeps) {
  const Provider = z.enum(['google', 'microsoft']);
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/mailboxes/from-clerk',
      operationId: 'connectMailboxFromClerk',
      tags: ['Mailboxes'],
      summary: 'Connect Gmail or Microsoft 365 using the account the user linked in Clerk',
      request: { body: jsonBody(z.object({ data: z.object({ provider: Provider, isDefault: z.boolean().optional() }) })) },
      responses: { 201: jsonResponse(dataOf(z.record(z.string(), z.unknown())), 'Mailbox'), ...errorResponses },
    }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => {
      const ctx = c.get('ctx');
      if (!ctx.principal.userId) throw unprocessable('Sign in through Clerk to connect a mailbox this way');
      const [u] = await d.db.select().from(users).where(eq(users.id, ctx.principal.userId)).limit(1);
      if (!u?.clerkUserId) throw unprocessable('This user did not sign in through Clerk');
      const { provider, isDefault } = c.req.valid('json').data;
      const t = await d.gateway.getProviderToken(u.clerkUserId, provider);
      if (!t) throw unprocessable(`No ${provider} account is linked to this Clerk user. Add it under your Clerk profile (Connected accounts), then retry.`, { provider });
      if (!d.kek) throw unprocessable('Set COOKS_KEK on the server before storing mailbox credentials');
      const email = u.email.toLowerCase();
      const providerKind = provider === 'google' ? 'gmail' : 'ms_graph';
      const [existing] = await d.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, ctx.principal.workspaceId), eq(mailboxes.email, email))).limit(1);
      let mailboxId: string;
      if (existing) {
        await d.db.update(mailboxes).set({ provider: providerKind, status: 'connected', deletedAt: null, userId: u.id }).where(eq(mailboxes.id, existing.id));
        mailboxId = existing.id;
      } else {
        const [row] = await d.db.insert(mailboxes).values({ workspaceId: ctx.principal.workspaceId, userId: u.id, email, provider: providerKind, isDefault: isDefault ?? true, status: 'connected' }).returning({ id: mailboxes.id });
        mailboxId = row!.id;
      }
      if (isDefault ?? true) await d.db.update(mailboxes).set({ isDefault: false }).where(and(eq(mailboxes.userId, u.id), eq(mailboxes.workspaceId, ctx.principal.workspaceId), ne(mailboxes.id, mailboxId)));
      const tokens = { refreshToken: '', accessToken: t.token, expiresAt: t.expiresAt ?? Date.now() + 50 * 60_000, email, viaClerk: true };
      const blob = encrypt(JSON.stringify({ [provider]: tokens }), d.kek);
      await d.db.insert(mailboxCredentials).values({ mailboxId, encrypted: blob, syncCursor: null }).onConflictDoUpdate({ target: mailboxCredentials.mailboxId, set: { encrypted: blob, syncCursor: null } });
      const [mb] = await d.db.select().from(mailboxes).where(eq(mailboxes.id, mailboxId));
      return c.json({ data: serializeMailbox(mb!) }, 201);
    },
  );
  register(
    reg,
    createRoute({
      method: 'put',
      path: '/v1/workspace/crm/hubspot/from-clerk',
      operationId: 'connectHubspotFromClerk',
      tags: ['CRM'],
      summary: 'Connect HubSpot using the HubSpot account the admin linked in Clerk',
      responses: { 200: jsonResponse(dataOf(z.record(z.string(), z.unknown())), 'Connected'), ...errorResponses },
    }),
    { rateClass: 'write', extension: true },
    async (c) => {
      const ctx = c.get('ctx');
      if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw unprocessable('Only admins can connect the CRM');
      if (!ctx.principal.userId) throw unprocessable('Sign in through Clerk to connect HubSpot this way');
      const [u] = await d.db.select().from(users).where(eq(users.id, ctx.principal.userId)).limit(1);
      if (!u?.clerkUserId) throw unprocessable('This user did not sign in through Clerk');
      const t = await d.gateway.getProviderToken(u.clerkUserId, 'hubspot');
      if (!t) throw unprocessable('No HubSpot account is linked to this Clerk user. Add it under Connected accounts in Clerk, then retry.');
      const res = await connectHubspot(ctx, { accessToken: t.token, expiresAt: t.expiresAt ?? Date.now() + 25 * 60_000 }, 'clerk', d.crm, { clerkUserId: u.clerkUserId });
      return c.json({ data: res }, 200);
    },
  );
}

/** Build the broker callbacks the worker and connectors use to refresh Clerk-managed tokens. */
export function clerkBrokers(db: Db, gateway: ClerkGateway) {
  const clerkIdOf = async (userId: string) => (await db.select({ c: users.clerkUserId }).from(users).where(eq(users.id, userId)).limit(1))[0]?.c ?? null;
  return {
    brokerToken: async (userId: string, provider: 'google' | 'microsoft' | 'hubspot') => {
      const cid = await clerkIdOf(userId);
      if (!cid) return null;
      const t = await gateway.getProviderToken(cid, provider);
      return t ? { refreshToken: '', accessToken: t.token, expiresAt: t.expiresAt ?? Date.now() + 50 * 60_000, viaClerk: true } : null;
    },
    brokerHubspotToken: async (clerkUserId: string) => {
      const t = await gateway.getProviderToken(clerkUserId, 'hubspot');
      return t ? { accessToken: t.token, expiresAt: t.expiresAt ?? Date.now() + 25 * 60_000 } : null;
    },
  };
}
export { serializeConnection };
