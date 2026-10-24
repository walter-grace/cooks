import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { and, eq, inArray } from 'drizzle-orm';
import {
  OAuthError,
  SESSION_COOKIE,
  authorizationServerMetadata,
  createAuthorizationCode,
  createSession,
  destroySession,
  exchangeAuthorizationCode,
  getSessionUser,
  grantConsent,
  hasConsent,
  memberRole,
  publicJwks,
  refreshAccessToken,
  registerClient,
  revokeToken,
  validateAuthorize,
  verifyPassword,
  type ActiveKey,
} from '@cooks/auth';
import { SCOPES, SCOPE_DESCRIPTIONS, type Clock } from '@cooks/core';
import { users, workspaceMembers, workspaces, type Db } from '@cooks/db';
import type { AppEnv } from '../types.js';
import { consentPage, errorPage, loginPage, workspacePicker } from './html.js';

export interface OAuthDeps {
  db: Db;
  issuer: string;
  key: ActiveKey;
  clock: Clock;
  dcrEnabled: boolean;
  secureCookies: boolean;
  /** Where an anonymous browser is sent to sign in before consent. Defaults to the password page; Clerk mode points it at the web UI. */
  loginUrl?: string;
}

async function formOrJson(c: { req: { header: (n: string) => string | undefined; parseBody: () => Promise<Record<string, unknown>>; json: () => Promise<unknown> } }): Promise<Record<string, string>> {
  const ct = c.req.header('content-type') ?? '';
  const raw = ct.includes('application/json') ? ((await c.req.json()) as Record<string, unknown>) : await c.req.parseBody();
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]));
}

const safeNext = (n: string | undefined) => (n && n.startsWith('/') && !n.startsWith('//') ? n : '/docs');

/** First-party browser token: issuer-signed JWT with every scope, no refresh token, no client. */
async function issueSessionAccessToken(d: OAuthDeps, a: { userId: string; workspaceId: string; role: string }) {
  const { SignJWT } = await import('jose');
  const now = Math.floor(d.clock.now().getTime() / 1000);
  const access_token = await new SignJWT({ ws: a.workspaceId, cid: 'cooks-web', scope: SCOPES.join(' '), role: a.role, jti: Math.random().toString(36).slice(2) })
    .setProtectedHeader({ alg: 'ES256', kid: d.key.kid, typ: 'at+jwt' })
    .setIssuer(d.issuer)
    .setSubject(a.userId)
    .setAudience('cooks-api')
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(d.key.privateKey);
  return { access_token, token_type: 'Bearer' as const, expires_in: 3600 };
}

export function mountOAuth(app: OpenAPIHono<AppEnv>, d: OAuthDeps) {
  const roleOf = (ws: string, uid: string) => memberRole(d.db, ws, uid);
  const cookieOpts = { httpOnly: true, sameSite: 'Lax' as const, secure: d.secureCookies, path: '/' };
  const loginUrl = d.loginUrl ?? '/auth/login';
  const toLogin = (next: string) => `${loginUrl}?next=${encodeURIComponent(next)}`;

  // ---- discovery
  app.get('/.well-known/oauth-authorization-server', (c) => c.json(authorizationServerMetadata(d.issuer, SCOPES, { dcr: d.dcrEnabled })));
  app.get('/.well-known/openid-configuration', (c) => c.json(authorizationServerMetadata(d.issuer, SCOPES, { dcr: d.dcrEnabled })));
  app.get('/.well-known/jwks.json', async (c) => c.json(await publicJwks(d.db), 200, { 'cache-control': 'public, max-age=300' }));

  // ---- session login (email + password)
  app.get('/auth/login', (c) => {
    const next = safeNext(c.req.query('next'));
    if (loginUrl !== '/auth/login') return c.redirect(toLogin(next), 302);
    return c.html(loginPage(next));
  });
  app.post('/auth/login', async (c) => {
    const body = await formOrJson(c);
    const next = safeNext(body.next);
    const [u] = await d.db.select().from(users).where(eq(users.email, (body.email ?? '').toLowerCase().trim())).limit(1);
    if (!u || !(await verifyPassword(body.password ?? '', u.passwordHash))) return c.html(loginPage(next, 'Email or password is incorrect'), 401);
    const s = await createSession(d.db, u.id, d.clock.now());
    setCookie(c, SESSION_COOKIE, s.token, { ...cookieOpts, expires: s.expiresAt });
    return c.redirect(next, 303);
  });
  // Web UI: exchange the session cookie for a 1 h access token (all scopes, the user's role).
  app.post('/auth/session-token', async (c) => {
    const user = await getSessionUser(d.db, getCookie(c, SESSION_COOKIE), d.clock.now());
    if (!user) return c.json({ error: 'unauthorized', error_description: 'Sign in first' }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { workspaceId?: string };
    const memberships = await d.db
      .select({ id: workspaces.id, name: workspaces.name, role: workspaceMembers.role })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id));
    const ws = memberships.find((m) => m.id === body.workspaceId) ?? memberships[0];
    if (!ws) return c.json({ error: 'no_workspace', error_description: 'Not a member of any workspace' }, 403);
    const tokens = await issueSessionAccessToken(d, { userId: user.id, workspaceId: ws.id, role: ws.role });
    return c.json({ ...tokens, workspace: { id: ws.id, name: ws.name, role: ws.role }, user: { id: user.id, email: user.email, name: user.name, emailVerified: !!user.emailVerifiedAt }, workspaces: memberships }, 200, { 'cache-control': 'no-store' });
  });
  app.get('/auth/me', async (c) => {
    const user = await getSessionUser(d.db, getCookie(c, SESSION_COOKIE), d.clock.now());
    if (!user) return c.json({ authenticated: false }, 200);
    return c.json({ authenticated: true, user: { id: user.id, email: user.email, name: user.name } });
  });
  app.post('/auth/logout', async (c) => {
    await destroySession(d.db, getCookie(c, SESSION_COOKIE));
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/auth/login', 303);
  });

  // ---- authorization endpoint
  const renderAuthorize = async (c: Context<AppEnv>, query: Record<string, string>, decision?: 'approve' | 'deny') => {
    let v: Awaited<ReturnType<typeof validateAuthorize>>;
    try {
      v = await validateAuthorize(d.db, query, SCOPES);
    } catch (e) {
      if (e instanceof OAuthError) return c.html(errorPage('Cannot authorize', `${e.error}: ${e.message}`), e.status as 400);
      throw e;
    }
    const redirectWith = (params: Record<string, string>) => {
      const u = new URL(query.redirect_uri!);
      for (const [k, val] of Object.entries(params)) u.searchParams.set(k, val);
      if (query.state) u.searchParams.set('state', query.state);
      return c.redirect(u.toString(), 302);
    };
    const user = await getSessionUser(d.db, getCookie(c, SESSION_COOKIE), d.clock.now());
    if (!user) {
      const back = `/oauth/authorize?${new URLSearchParams(query).toString()}`;
      return c.redirect(toLogin(back), 302);
    }
    const memberships = await d.db
      .select({ id: workspaces.id, name: workspaces.name })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id));
    if (!memberships.length) return c.html(errorPage('No workspace', 'Your account is not a member of any workspace.'), 403);
    const { workspace: wsParam, ...rest } = query;
    const q = new URLSearchParams(rest).toString();
    const ws = wsParam ? memberships.find((m) => m.id === wsParam) : memberships.length === 1 ? memberships[0] : undefined;
    if (!ws) return c.html(workspacePicker(memberships, q));

    const consented = await hasConsent(d.db, user.id, v.client.clientId, ws.id, v.scopes);
    if (decision === 'deny') return redirectWith({ error: 'access_denied', error_description: 'The user denied the request' });
    if (!consented && decision !== 'approve') {
      return c.html(
        consentPage({
          clientName: v.client.name,
          scopes: v.scopes.map((s) => ({ scope: s, description: SCOPE_DESCRIPTIONS[s as keyof typeof SCOPE_DESCRIPTIONS] ?? '' })),
          workspaceName: ws.name,
          userEmail: user.email,
          query: `${q}&workspace=${ws.id}`,
        }),
      );
    }
    if (decision === 'approve' && !consented) await grantConsent(d.db, user.id, v.client.clientId, ws.id, v.scopes);
    const code = await createAuthorizationCode(d.db, {
      clientId: v.client.clientId,
      userId: user.id,
      workspaceId: ws.id,
      scopes: v.scopes,
      codeChallenge: query.code_challenge!,
      redirectUri: query.redirect_uri!,
      resource: query.resource,
      now: d.clock.now(),
    });
    return redirectWith({ code });
  };
  app.get('/oauth/authorize', (c) => renderAuthorize(c, c.req.query()));
  app.post('/oauth/authorize/decision', async (c) => {
    const body = await formOrJson(c);
    const query = Object.fromEntries(new URLSearchParams(body.q ?? '').entries());
    return renderAuthorize(c, query, body.decision === 'approve' ? 'approve' : 'deny');
  });

  // ---- token / revoke / register
  const oauthJson = (c: { json: (b: unknown, s: number, h?: Record<string, string>) => Response }, e: OAuthError) => c.json(e.body(), e.status, { 'cache-control': 'no-store' });
  app.post('/oauth/token', async (c) => {
    const p = await formOrJson(c);
    const iss = { issuer: d.issuer, key: d.key };
    try {
      let tokens;
      if (p.grant_type === 'authorization_code') tokens = await exchangeAuthorizationCode(d.db, iss, p, roleOf, d.clock.now());
      else if (p.grant_type === 'refresh_token') tokens = await refreshAccessToken(d.db, iss, p, roleOf, d.clock.now());
      else throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
      return c.json(tokens, 200, { 'cache-control': 'no-store', pragma: 'no-cache' });
    } catch (e) {
      if (e instanceof OAuthError) return oauthJson(c, e);
      throw e;
    }
  });
  app.post('/oauth/revoke', async (c) => {
    const p = await formOrJson(c);
    if (p.token) await revokeToken(d.db, p.token, d.clock.now());
    return c.body(null, 200);
  });
  app.post('/oauth/register', async (c) => {
    if (!d.dcrEnabled) return c.json({ error: 'access_denied', error_description: 'Dynamic client registration is disabled' }, 403);
    try {
      const body = (await c.req.json()) as Parameters<typeof registerClient>[1];
      return c.json(await registerClient(d.db, body), 201);
    } catch (e) {
      if (e instanceof OAuthError) return oauthJson(c, e);
      throw e;
    }
  });
}

/** Build the JWT branch of the auth middleware. */
export function makeVerifyJwt(d: { db: Db; issuer: string; audiences: string[]; clock: Clock }) {
  return async (token: string) => {
    const { verifyAccessToken } = await import('@cooks/auth');
    const claims = await verifyAccessToken(d.db, token, d.issuer, d.audiences, d.clock.now());
    if (!claims || !claims.sub) return null;
    const [u] = await d.db.select().from(users).where(eq(users.id, claims.sub)).limit(1);
    const role = await memberRole(d.db, claims.ws, claims.sub);
    if (!u || !role) return null;
    const { isScope } = await import('@cooks/core');
    const scopes = new Set(claims.scope.split(' ').filter(isScope));
    return { workspaceId: claims.ws, userId: claims.sub, role, authType: 'oauth' as const, clientId: claims.cid, scopes, bypassRoleChecks: false, email: u.email, name: u.name };
  };
}

export { and, inArray };
