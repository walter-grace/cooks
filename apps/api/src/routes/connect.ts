/**
 * Mailbox connectors: Google (Gmail) and Microsoft 365. A signed-in user (session cookie)
 * starts the flow; the callback stores encrypted tokens on a mailbox row for that user.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { getCookie } from 'hono/cookie';
import { and, eq, ne } from 'drizzle-orm';
import { SESSION_COOKIE, getSessionUser } from '@cooks/auth';
import { encrypt, googleAuthUrl, googleExchangeCode, microsoftAuthUrl, microsoftExchangeCode, type ConnectorApps, type OAuthAppConfig } from '@cooks/core';
import { mailboxCredentials, mailboxes, workspaceMembers, type Db } from '@cooks/db';
import type { AppEnv } from '../types.js';

export interface ConnectDeps {
  db: Db;
  publicUrl: string;
  kek?: string;
  apps: ConnectorApps;
  msTenant?: string;
  fetchImpl?: typeof fetch;
  now: () => Date;
}

const page = (title: string, body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1>${body}</body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

function signState(secret: string, payload: Record<string, string>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url').slice(0, 24)}`;
}
function readState(secret: string, state: string | undefined): Record<string, string> | null {
  if (!state) return null;
  const [body, sig] = state.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest('base64url').slice(0, 24);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, string>;
  } catch {
    return null;
  }
}

export function mountConnect(app: OpenAPIHono<AppEnv>, d: ConnectDeps) {
  const secret = d.kek ?? 'cooks-dev';
  const appFor = (kind: 'google' | 'microsoft'): OAuthAppConfig | null => {
    const a = d.apps[kind];
    return a ? { ...a, redirectUri: `${d.publicUrl}/connect/${kind}/callback` } : null;
  };

  for (const kind of ['google', 'microsoft'] as const) {
    app.get(`/connect/${kind}/start`, async (c) => {
      const cfg = appFor(kind);
      if (!cfg) return page('Connector not configured', `<p>Set ${kind === 'google' ? 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET' : 'MS_CLIENT_ID / MS_CLIENT_SECRET'} on the server to enable this connector.</p>`, 503);
      if (!d.kek) return page('Server not ready', '<p>Set COOKS_KEK so mailbox tokens can be stored encrypted.</p>', 503);
      const user = await getSessionUser(d.db, getCookie(c, SESSION_COOKIE), d.now());
      if (!user) return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path + (c.req.query('workspace') ? `?workspace=${c.req.query('workspace')}` : ''))}`, 302);
      const memberships = await d.db.select({ workspaceId: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
      const wsParam = c.req.query('workspace');
      const ws = wsParam && memberships.some((m) => m.workspaceId === wsParam) ? wsParam : memberships[0]?.workspaceId;
      if (!ws) return page('No workspace', '<p>Your account is not a member of any workspace.</p>', 403);
      const state = signState(secret, { u: user.id, w: ws, t: String(d.now().getTime()), r: c.req.query('return') ?? '/app/settings' });
      return c.redirect(kind === 'google' ? googleAuthUrl(cfg, state) : microsoftAuthUrl(cfg, state, d.msTenant), 302);
    });

    app.get(`/connect/${kind}/callback`, async (c) => {
      const cfg = appFor(kind);
      if (!cfg || !d.kek) return page('Connector not configured', '', 503);
      if (c.req.query('error')) return page('Connection cancelled', `<p>${c.req.query('error_description') ?? c.req.query('error')}</p>`, 400);
      const st = readState(secret, c.req.query('state'));
      if (!st || d.now().getTime() - Number(st.t) > 15 * 60_000) return page('Link expired', '<p>Start the connection again.</p>', 400);
      const code = c.req.query('code');
      if (!code) return page('Missing code', '', 400);
      const f = d.fetchImpl ?? fetch;
      const tokens = kind === 'google' ? await googleExchangeCode(f, cfg, code) : await microsoftExchangeCode(f, cfg, code, d.msTenant);
      const email = tokens.email!;
      const provider = kind === 'google' ? 'gmail' : 'ms_graph';
      const [existing] = await d.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, st.w!), eq(mailboxes.email, email))).limit(1);
      let mailboxId: string;
      if (existing) {
        await d.db.update(mailboxes).set({ provider, status: 'connected', deletedAt: null, userId: st.u! }).where(eq(mailboxes.id, existing.id));
        mailboxId = existing.id;
      } else {
        const [row] = await d.db.insert(mailboxes).values({ workspaceId: st.w!, userId: st.u!, email, provider, isDefault: true, status: 'connected' }).returning({ id: mailboxes.id });
        mailboxId = row!.id;
        await d.db.update(mailboxes).set({ isDefault: false }).where(and(eq(mailboxes.userId, st.u!), eq(mailboxes.workspaceId, st.w!), eq(mailboxes.isDefault, true), ne(mailboxes.id, mailboxId)));
      }
      const blob = encrypt(JSON.stringify({ [kind]: tokens }), d.kek);
      await d.db.insert(mailboxCredentials).values({ mailboxId, encrypted: blob, syncCursor: null }).onConflictDoUpdate({ target: mailboxCredentials.mailboxId, set: { encrypted: blob, syncCursor: null } });
      const back = st.r && st.r.startsWith('/') ? st.r : '/app/settings';
      return c.redirect(`${back}${back.includes('?') ? '&' : '?'}connected=${encodeURIComponent(email)}`, 302);
    });
  }
}
