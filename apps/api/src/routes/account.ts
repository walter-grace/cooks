/**
 * Self-serve accounts.
 *  - POST /auth/signup              → user + workspace + admin membership, session cookie, verification mail
 *  - POST /auth/verify              → confirm an address from the emailed link
 *  - POST /auth/verify/resend       → another verification mail for the signed-in user
 *  - POST /auth/password/forgot     → reset link by mail (always 200)
 *  - POST /auth/password/reset      → new password from the link, other sessions revoked
 *  - GET  /auth/invite/{token}      → what an invite is for, before accepting
 *  - POST /auth/invite/accept       → join the workspace (new address: name + password)
 *  - /v1/workspace/invites          → admins list, create and revoke invites (OpenAPI, extension)
 */
import type { Context } from 'hono';
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { AccountError, SESSION_COOKIE, acceptInvite, createAccount, createInvite, createSession, describeInvite, findUserByEmail, getSessionUser, issueToken, listInvites, resetPassword, revokeInvite, verifyEmail, type SignupMode } from '@cooks/auth';
import { IdParam, errorResponses, insufficientPermission, jsonBody, jsonResponse } from '@cooks/core';
import { users, workspaces, type Db } from '@cooks/db';
import { eq } from 'drizzle-orm';
import type { AuthMailer } from '../auth-mail.js';
import { register, type Registrar } from '../register.js';
import type { AppEnv } from '../types.js';

export interface AccountDeps {
  db: Db;
  clock: { now(): Date };
  publicUrl: string;
  secureCookies: boolean;
  signup: SignupMode;
  mailer?: AuthMailer;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

const json = async (c: Context<AppEnv>) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, string | undefined>;
const fail = (c: Context<AppEnv>, e: unknown) => {
  if (e instanceof AccountError) return c.json({ error: e.code, error_description: e.message }, e.status as 400);
  throw e;
};

async function deliver(d: AccountDeps, to: string, subject: string, text: string) {
  if (!d.mailer) {
    d.log?.('auth mail (no mailer configured)', { to, subject, text });
    return;
  }
  try {
    await d.mailer.send({ to, subject, text });
  } catch (e) {
    d.log?.('auth mail failed', { to, subject, error: (e as Error).message });
  }
}

export async function sendVerification(d: AccountDeps, user: { id: string; email: string; name: string }) {
  const t = await issueToken(d.db, { kind: 'verify', email: user.email, userId: user.id }, d.clock.now());
  const link = `${d.publicUrl}/app/verify?token=${t.token}`;
  await deliver(d, user.email, 'Confirm your email for Cooks', `Hi ${user.name},\n\nConfirm this address to finish setting up Cooks:\n\n${link}\n\nThe link works for three days. If you did not sign up, ignore this message.`);
}

export function mountAccountAuth(app: OpenAPIHono<AppEnv>, d: AccountDeps) {
  const cookieOpts = { httpOnly: true, sameSite: 'Lax' as const, secure: d.secureCookies, path: '/' };
  const signIn = async (c: Context<AppEnv>, userId: string) => {
    const s = await createSession(d.db, userId, d.clock.now());
    setCookie(c, SESSION_COOKIE, s.token, { ...cookieOpts, expires: s.expiresAt });
  };

  app.post('/auth/signup', async (c) => {
    if (d.signup !== 'open') return c.json({ error: 'signup_closed', error_description: d.signup === 'invite' ? 'Ask an admin for an invite link' : 'Sign-up is turned off on this server' }, 403);
    const b = await json(c);
    try {
      const { user, workspace } = await createAccount(d.db, { email: b.email ?? '', name: b.name ?? '', password: b.password ?? '', workspaceName: b.workspaceName ?? '' }, d.clock.now());
      await signIn(c, user.id);
      await sendVerification(d, user);
      return c.json({ ok: true, user: { id: user.id, email: user.email, name: user.name }, workspace: { id: workspace.id, name: workspace.name } }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/auth/verify', async (c) => {
    const b = await json(c);
    try {
      await verifyEmail(d.db, b.token ?? '', d.clock.now());
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post('/auth/verify/resend', async (c) => {
    const user = await getSessionUser(d.db, getCookie(c, SESSION_COOKIE), d.clock.now());
    if (!user) return c.json({ error: 'unauthorized', error_description: 'Sign in first' }, 401);
    if (user.emailVerifiedAt) return c.json({ ok: true, alreadyVerified: true });
    await sendVerification(d, user);
    return c.json({ ok: true });
  });

  app.post('/auth/password/forgot', async (c) => {
    const b = await json(c);
    const user = b.email ? await findUserByEmail(d.db, b.email) : null;
    if (user) {
      const t = await issueToken(d.db, { kind: 'reset', email: user.email, userId: user.id }, d.clock.now());
      const link = `${d.publicUrl}/app/reset?token=${t.token}`;
      await deliver(d, user.email, 'Reset your Cooks password', `Hi ${user.name},\n\nSet a new password here:\n\n${link}\n\nThe link works for one hour. If you did not ask for this, ignore this message and your password stays as it is.`);
    }
    return c.json({ ok: true });
  });

  app.post('/auth/password/reset', async (c) => {
    const b = await json(c);
    try {
      const userId = await resetPassword(d.db, b.token ?? '', b.password ?? '', d.clock.now());
      deleteCookie(c, SESSION_COOKIE, { path: '/' });
      await signIn(c, userId);
      return c.json({ ok: true });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.get('/auth/invite/:token', async (c) => {
    const info = await describeInvite(d.db, c.req.param('token'), d.clock.now());
    if (!info) return c.json({ error: 'invalid_token', error_description: 'This invite is invalid or has expired' }, 404);
    return c.json(info);
  });

  app.post('/auth/invite/accept', async (c) => {
    const b = await json(c);
    try {
      const { user, workspaceId } = await acceptInvite(d.db, b.token ?? '', { name: b.name, password: b.password }, d.clock.now());
      await signIn(c, user.id);
      return c.json({ ok: true, workspaceId, user: { id: user.id, email: user.email, name: user.name } });
    } catch (e) {
      return fail(c, e);
    }
  });
}

const Invite = z
  .object({ id: z.string().uuid(), email: z.string(), role: z.string().nullable(), invitedBy: z.string().nullable(), expiresAt: z.string(), createdAt: z.string() })
  .openapi('WorkspaceInvite');
const InviteBody = z.object({ data: z.object({ email: z.string().email(), role: z.enum(['user', 'manager', 'admin']).optional() }) });

const requireAdmin = (c: Context<AppEnv>) => {
  const p = c.get('ctx').principal;
  if (!p.bypassRoleChecks && p.role !== 'admin') throw insufficientPermission('Only admins can manage invites');
};
const ser = (i: { id: string; email: string; role: string | null; invitedBy: string | null; expiresAt: Date; createdAt: Date }) => ({ ...i, expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString() });

export function mountInvites(reg: Registrar, d: AccountDeps) {
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/invites', operationId: 'listWorkspaceInvites', tags: ['Workspace'], summary: 'Pending invites', responses: { 200: jsonResponse(z.object({ data: z.array(Invite) }), 'Invites'), ...errorResponses } }),
    { scope: 'users:read', rateClass: 'get', extension: true },
    async (c) => {
      requireAdmin(c);
      return c.json({ data: (await listInvites(d.db, c.get('ctx').principal.workspaceId, d.clock.now())).map(ser) }, 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/workspace/invites',
      operationId: 'createWorkspaceInvite',
      tags: ['Workspace'],
      summary: 'Invite someone by email',
      description: 'Mails a link that creates the account (or adds an existing one) as a member with the given role. Replaces any earlier live invite for the same address.',
      request: { body: jsonBody(InviteBody) },
      responses: { 201: jsonResponse(z.object({ data: Invite.extend({ link: z.string().optional() }) }), 'Invite sent'), ...errorResponses },
    }),
    { scope: 'users:write', rateClass: 'write', extension: true },
    async (c) => {
      requireAdmin(c);
      const ctx = c.get('ctx');
      const { email, role } = c.req.valid('json').data;
      try {
        const t = await createInvite(d.db, { workspaceId: ctx.principal.workspaceId, email, role: role ?? 'user', invitedBy: ctx.principal.userId ?? ctx.principal.workspaceId }, d.clock.now());
        const link = `${d.publicUrl}/app/join?token=${t.token}`;
        const [inviter] = ctx.principal.userId ? await d.db.select({ name: users.name }).from(users).where(eq(users.id, ctx.principal.userId)).limit(1) : [];
        const [ws] = await d.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.principal.workspaceId)).limit(1);
        await deliver(d, email, `${inviter?.name ?? 'A teammate'} invited you to ${ws?.name ?? 'Cooks'}`, `${inviter?.name ?? 'A teammate'} invited you to join ${ws?.name ?? 'their workspace'} on Cooks.\n\nAccept here:\n\n${link}\n\nThe link works for seven days.`);
        const rows = await listInvites(d.db, ctx.principal.workspaceId, d.clock.now());
        const mine = rows.find((r) => r.id === t.id)!;
        // the link is returned only when no mailer can deliver it, so an admin can pass it on by hand
        return c.json({ data: { ...ser(mine), ...(d.mailer ? {} : { link }) } }, 201);
      } catch (e) {
        if (e instanceof AccountError) return c.json({ error: { code: e.code, message: e.message }, traceId: ctx.traceId }, e.status as 400);
        throw e;
      }
    },
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/workspace/invites/{id}', operationId: 'revokeWorkspaceInvite', tags: ['Workspace'], summary: 'Revoke an invite', request: { params: IdParam }, responses: { 204: { description: 'Revoked' }, ...errorResponses } }),
    { scope: 'users:write', rateClass: 'write', extension: true },
    async (c) => {
      requireAdmin(c);
      await revokeInvite(d.db, c.get('ctx').principal.workspaceId, c.req.valid('param').id, d.clock.now());
      return c.body(null, 204);
    },
  );
}
