import { createHmac, timingSafeEqual } from 'node:crypto';
import { createRoute, z } from '@hono/zod-openapi';
import { getCookie } from 'hono/cookie';
import { eq } from 'drizzle-orm';
import { SESSION_COOKIE, getSessionUser } from '@cooks/auth';
import {
  ALL_SCOPES,
  IdParam,
  addAutoEnrollRule,
  connectHubspot,
  dataOf,
  disconnectCrm,
  errorResponses,
  insufficientPermission,
  hubspotAuthUrl,
  hubspotExchangeCode,
  jsonBody,
  jsonResponse,
  removeAutoEnrollRule,
  runAutoEnrollRule,
  serializeConnection,
  syncHubspotContacts,
  updateCrmSettings,
  type Ctx,
  type CrmDeps,
  type HubSpotApp,
} from '@cooks/core';
import { workspaceMembers, type Db } from '@cooks/db';
import { register, type Registrar } from '../register.js';

const Connection = z
  .object({
    type: z.string(),
    status: z.string(),
    hubspot: z.object({ portalId: z.number().nullable(), kind: z.string(), tokenLast4: z.string() }).nullable(),
    settings: z.object({ autoEnroll: z.array(z.record(z.string(), z.unknown())), logEmails: z.boolean(), logCalls: z.boolean(), ownerMapSize: z.number(), lastPollAt: z.string().nullable() }),
    updatedAt: z.string().nullable(),
  })
  .openapi('CrmConnection');
const RuleBody = z.object({
  data: z.object({
    kind: z.enum(['list', 'dealStage']),
    listId: z.string().optional(),
    pipelineId: z.string().optional(),
    stageId: z.string().optional(),
    sequenceId: z.string().uuid(),
    ownerId: z.string(),
    enabled: z.boolean().optional(),
  }),
});

export function mountCrm(reg: Registrar, deps: CrmDeps & { db: Db; publicUrl: string; now: () => Date }) {
  const admin = (ctx: Ctx) => {
    if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission('Only admins can manage the CRM connection');
  };
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/crm', operationId: 'getCrmConnection', tags: ['CRM'], summary: 'CRM connection status and auto-enroll rules', responses: { 200: jsonResponse(dataOf(Connection), 'Connection'), ...errorResponses } }),
    { rateClass: 'default', extension: true },
    async (c) => c.json({ data: await serializeConnection(c.get('ctx'), deps) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'put',
      path: '/v1/workspace/crm/hubspot',
      operationId: 'connectHubspot',
      tags: ['CRM'],
      summary: 'Connect HubSpot with a private-app access token (verified against the account)',
      request: { body: jsonBody(z.object({ data: z.object({ accessToken: z.string().min(10) }) })) },
      responses: { 200: jsonResponse(dataOf(Connection), 'Connected'), ...errorResponses },
    }),
    { rateClass: 'write', extension: true },
    async (c) => {
      admin(c.get('ctx'));
      return c.json({ data: await connectHubspot(c.get('ctx'), { accessToken: c.req.valid('json').data.accessToken }, 'private_app', deps) }, 200);
    },
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/workspace/crm', operationId: 'disconnectCrm', tags: ['CRM'], summary: 'Disconnect the CRM', responses: { 204: { description: 'Disconnected' }, ...errorResponses } }),
    { rateClass: 'write', extension: true },
    async (c) => {
      admin(c.get('ctx'));
      await disconnectCrm(c.get('ctx'));
      return c.body(null, 204);
    },
  );
  register(
    reg,
    createRoute({
      method: 'patch',
      path: '/v1/workspace/crm',
      operationId: 'updateCrmSettings',
      tags: ['CRM'],
      summary: 'Toggle activity logging to the CRM',
      request: { body: jsonBody(z.object({ data: z.object({ logEmails: z.boolean().optional(), logCalls: z.boolean().optional() }) })) },
      responses: { 200: jsonResponse(dataOf(Connection), 'Updated'), ...errorResponses },
    }),
    { rateClass: 'write', extension: true },
    async (c) => {
      admin(c.get('ctx'));
      return c.json({ data: await updateCrmSettings(c.get('ctx'), c.req.valid('json').data, deps) }, 200);
    },
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/workspace/crm/rules', operationId: 'addCrmAutoEnrollRule', tags: ['CRM'], summary: 'Auto-enroll contacts from a HubSpot list or deal stage into a sequence', request: { body: jsonBody(RuleBody) }, responses: { 201: jsonResponse(dataOf(Connection), 'Rule added'), ...errorResponses } }),
    { rateClass: 'write', extension: true },
    async (c) => {
      admin(c.get('ctx'));
      return c.json({ data: await addAutoEnrollRule(c.get('ctx'), c.req.valid('json').data, deps) }, 201);
    },
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/workspace/crm/rules/{id}', operationId: 'removeCrmAutoEnrollRule', tags: ['CRM'], summary: 'Remove an auto-enroll rule', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(Connection), 'Removed'), ...errorResponses } }),
    { rateClass: 'write', extension: true },
    async (c) => {
      admin(c.get('ctx'));
      return c.json({ data: await removeAutoEnrollRule(c.get('ctx'), c.req.valid('param').id, deps) }, 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/workspace/crm/rules/{id}/actions/run',
      operationId: 'runCrmAutoEnrollRule',
      tags: ['CRM'],
      summary: 'Run an auto-enroll rule now (otherwise every 5 minutes by the worker)',
      request: { params: IdParam },
      responses: { 200: jsonResponse(dataOf(z.object({ synced: z.number(), enrolled: z.number(), skipped: z.number() })), 'Result'), ...errorResponses },
    }),
    { rateClass: 'sync', extension: true },
    async (c) => {
      const ctx = c.get('ctx');
      const conn = await serializeConnection(ctx, deps);
      const rule = conn.settings.autoEnroll.find((r) => r.id === c.req.valid('param').id);
      if (!rule) return c.json({ error: { code: 'NOT_FOUND', message: 'Rule not found' }, traceId: ctx.traceId }, 404);
      return c.json({ data: await runAutoEnrollRule(ctx, rule as never, deps) }, 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/integrations/hubspot/import',
      operationId: 'importHubspotContacts',
      tags: ['CRM'],
      summary: 'Import HubSpot contacts by email address',
      request: { body: jsonBody(z.object({ data: z.object({ emails: z.array(z.string().email()).min(1).max(100) }) })) },
      responses: { 200: jsonResponse(z.object({ results: z.array(z.record(z.string(), z.unknown())), errors: z.array(z.record(z.string(), z.unknown())) }), 'Sync results'), ...errorResponses },
    }),
    { scope: 'prospects:write', rateClass: 'sync', extension: true },
    async (c) => c.json(await syncHubspotContacts(c.get('ctx'), c.req.valid('json').data.emails, deps, { byEmail: true }), 200),
  );

  // ---- OAuth connect flow (when a HubSpot app is configured): session user → HubSpot → callback
  const app = reg.app;
  const secret = deps.kek ?? 'cooks-dev';
  const sign = (p: Record<string, string>) => {
    const b = Buffer.from(JSON.stringify(p)).toString('base64url');
    return `${b}.${createHmac('sha256', secret).update(b).digest('base64url').slice(0, 24)}`;
  };
  const read = (s: string | undefined) => {
    if (!s) return null;
    const [b, sig] = s.split('.');
    if (!b || !sig) return null;
    const exp = createHmac('sha256', secret).update(b).digest('base64url').slice(0, 24);
    if (sig.length !== exp.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
    return JSON.parse(Buffer.from(b, 'base64url').toString()) as Record<string, string>;
  };
  const redirectUri = `${deps.publicUrl}/connect/hubspot/callback`;
  const html = (title: string, body: string, status = 200) => new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1>${body}</body>`, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  app.get('/connect/hubspot/start', async (c) => {
    const hs: HubSpotApp | undefined = deps.hubspotApp;
    if (!hs) return html('HubSpot app not configured', '<p>Set HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET on the server, or paste a private-app token in Settings instead.</p>', 503);
    const user = await getSessionUser(deps.db, getCookie(c, SESSION_COOKIE), deps.now());
    if (!user) return c.redirect(`/auth/login?next=${encodeURIComponent(c.req.path)}`, 302);
    const m = await deps.db.select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role }).from(workspaceMembers).where(eq(workspaceMembers.userId, user.id));
    const ws = m.find((x) => x.workspaceId === c.req.query('workspace')) ?? m[0];
    if (!ws) return html('No workspace', '', 403);
    if (ws.role !== 'admin') return html('Admins only', '<p>Ask a workspace admin to connect HubSpot.</p>', 403);
    return c.redirect(hubspotAuthUrl(hs, redirectUri, sign({ u: user.id, w: ws.workspaceId, t: String(deps.now().getTime()) })), 302);
  });
  app.get('/connect/hubspot/callback', async (c) => {
    const hs = deps.hubspotApp;
    if (!hs) return html('HubSpot app not configured', '', 503);
    const st = read(c.req.query('state'));
    if (!st || deps.now().getTime() - Number(st.t) > 15 * 60_000) return html('Link expired', '<p>Start the connection again from Settings.</p>', 400);
    const code = c.req.query('code');
    if (!code) return html('Missing code', '', 400);
    const auth = await hubspotExchangeCode(deps.fetchImpl ?? fetch, hs, redirectUri, code);
    const ctx: Ctx = { db: deps.db, principal: { workspaceId: st.w!, userId: st.u!, role: 'admin', authType: 'oauth', clientId: 'cooks-web', scopes: ALL_SCOPES, bypassRoleChecks: false }, jobs: { send: async () => null }, clock: { now: deps.now }, traceId: 'connect', publicUrl: deps.publicUrl };
    await connectHubspot(ctx, auth, 'oauth', deps);
    return c.redirect('/app/settings?connected=hubspot', 302);
  });
}
