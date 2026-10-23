import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { Scalar } from '@scalar/hono-api-reference';
import { stringify as toYaml } from 'yaml';
import { CooksError, badRequest, internal, noopJobs, systemClock, type Clock, type Ctx, type JobsPort } from '@cooks/core';
import type { Db } from '@cooks/db';
import { authMiddleware, type AuthDeps } from './middleware/auth.js';
import { MemoryRateLimitStore, type RateLimitStore } from './middleware/rate-limit.js';
import { trace } from './middleware/trace.js';
import type { Registrar } from './register.js';
import { landingHtml } from './landing.js';
import type { AppEnv } from './types.js';
import { mountRoutes } from './routes/index.js';
import { mountTracking } from './routes/tracking.js';
import { mountTelephonyWebhooks } from './routes/telephony.js';
import { mountInkboxWebhook } from './routes/channels.js';
import { makeVerifyJwt, mountOAuth } from './oauth/routes.js';
import { mountConnect } from './routes/connect.js';
import { clerkBrokers, mountClerkAuth, mountClerkConnectors } from './routes/clerk.js';
import type { ClerkGateway } from '@cooks/auth';
import type { ConnectorApps, TwilioEnv } from '@cooks/core';
import type { ActiveKey } from '@cooks/auth';
import { SCOPES, SCOPE_DESCRIPTIONS } from '@cooks/core';

export interface AppDeps {
  db: Db;
  jobs?: JobsPort;
  rateLimitStore?: RateLimitStore;
  clock?: Clock;
  publicUrl?: string;
  acceptNooksPrefix?: boolean;
  publicIps?: string[];
  verifyJwt?: AuthDeps['verifyJwt'];
  version?: string;
  /** Encrypts mailbox credentials and signs tracking tokens. */
  kek?: string;
  /** Outbound HTTP for webhook pings (injectable for tests). */
  fetchImpl?: typeof fetch;
  keyPrefix?: 'cooks' | 'nooks';
  /** OAuth 2.1 authorization server. Omit to run API-key-only. */
  oauth?: { key: ActiveKey; dcrEnabled?: boolean; secureCookies?: boolean; mcpPublicUrl?: string };
  /** Gmail / Microsoft 365 OAuth apps for mailbox connectors. */
  connectorApps?: ConnectorApps;
  msTenant?: string;
  /** Clerk SSO (optional). With it, sign-in and provider tokens come from Clerk. */
  clerk?: { gateway: ClerkGateway; publishableKey?: string; defaultWorkspaceSlug?: string };
  /** HubSpot OAuth app (optional; private-app tokens work without it). */
  hubspotApp?: { clientId: string; clientSecret: string };
  /** Twilio: override the API base for mocks; `trustWebhookSignature: false` skips X-Twilio-Signature checks (tests only). */
  telephony?: { apiBase?: string; trustWebhookSignature?: boolean; speko?: { apiKey?: string; apiBase?: string }; twilioEnv?: TwilioEnv };
  channels?: { inkboxApiBase?: string; trustWebhookSignature?: boolean };
  /** Directory with the built web UI (apps/web/dist). Served at /app with SPA fallback. */
  webDir?: string;
}

export function createApp(deps: AppDeps) {
  const clock = deps.clock ?? systemClock;
  const jobs = deps.jobs ?? noopJobs;
  const publicUrl = deps.publicUrl ?? 'http://localhost:8080';
  const store = deps.rateLimitStore ?? new MemoryRateLimitStore();

  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
        return c.json(badRequest('Request validation failed', issues).toBody(c.get('traceId') ?? ''), 400);
      }
      return undefined;
    },
  });

  app.use('*', trace);
  app.use('*', cors({ origin: (o) => o ?? '*', allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Request-Id'], exposeHeaders: ['X-Trace-Id', 'X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset', 'Retry-After'] }));

  app.onError((err, c) => {
    const traceId = c.get('traceId') ?? '';
    if (err instanceof CooksError) {
      if (err.code === 'RATE_LIMIT_EXCEEDED' && err.extra?.retryAfterSeconds) c.header('Retry-After', String(err.extra.retryAfterSeconds));
      return c.json(err.toBody(traceId), err.status as 400);
    }
    if (err instanceof HTTPException) {
      const mapped = err.status === 404 ? new CooksError(404, 'NOT_FOUND', 'Route not found') : new CooksError(err.status, 'BAD_REQUEST', err.message);
      return c.json(mapped.toBody(traceId), mapped.status as 400);
    }
    console.error(`[${traceId}]`, err);
    return c.json(internal().toBody(traceId), 500);
  });
  app.notFound((c) => c.json(new CooksError(404, 'NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`).toBody(c.get('traceId') ?? ''), 404));

  app.get('/health', (c) => c.json({ ok: true, time: clock.now().toISOString() }));
  if (deps.webDir) {
    const dir = deps.webDir;
    app.get('/app/*', async (c, next) => {
      const rel = c.req.path.replace(/^\/app\/?/, '');
      const file = rel && !rel.includes('..') ? join(dir, rel) : '';
      if (file && existsSync(file) && statSync(file).isFile()) {
        const ext = extname(file);
        const type = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json', '.woff2': 'font/woff2' }[ext] ?? 'application/octet-stream';
        return c.body(readFileSync(file), 200, { 'content-type': type, 'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      }
      const index = join(dir, 'index.html');
      if (existsSync(index)) return c.html(readFileSync(index, 'utf8'));
      return next();
    });
    app.get('/app', (c) => c.redirect('/app/', 302));
  }
  app.get('/', (c) => c.html(landingHtml({ publicUrl, release: 'https://github.com/walter-grace/cooks/releases/latest/download/cooks-mcp.tgz' })));

  // Authenticated API surface. Everything under /v1 except /v1/public-ip-list.
  const verifyJwt =
    deps.verifyJwt ??
    (deps.oauth ? makeVerifyJwt({ db: deps.db, issuer: publicUrl, audiences: ['cooks-api', `${deps.oauth.mcpPublicUrl ?? ''}/mcp`].filter((a) => a !== '/mcp'), clock }) : undefined);
  app.use('/v1/*', authMiddleware({ db: deps.db, acceptNooksPrefix: deps.acceptNooksPrefix ?? true, verifyJwt }));
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/public-ip-list') return next();
    const ctx: Ctx = { db: deps.db, principal: c.get('principal'), jobs, clock, traceId: c.get('traceId'), publicUrl };
    c.set('ctx', ctx);
    await next();
  });

  const brokers = deps.clerk ? clerkBrokers(deps.db, deps.clerk.gateway) : undefined;
  const reg: Registrar = { app, store, now: () => clock.now(), registry: [], crmDeps: { kek: deps.kek, fetchImpl: deps.fetchImpl, hubspotApp: deps.hubspotApp, brokerHubspotToken: brokers?.brokerHubspotToken } };
  const dialer = { kek: deps.kek, fetchImpl: deps.fetchImpl, apiBase: deps.telephony?.apiBase, speko: deps.telephony?.speko, twilioEnv: deps.telephony?.twilioEnv, publicUrl };
  const channels = { kek: deps.kek, fetchImpl: deps.fetchImpl, inkbox: { apiBase: deps.channels?.inkboxApiBase }, publicUrl };
  mountRoutes(reg, { publicIps: deps.publicIps ?? [], kek: deps.kek, fetchImpl: deps.fetchImpl, keyPrefix: deps.keyPrefix, crm: { db: deps.db, publicUrl, now: () => clock.now(), kek: deps.kek, fetchImpl: deps.fetchImpl, hubspotApp: deps.hubspotApp, brokerHubspotToken: brokers?.brokerHubspotToken }, dialer, channels });
  const secureCookies = deps.oauth?.secureCookies ?? publicUrl.startsWith('https');
  mountClerkAuth(app, deps.clerk ? { gateway: deps.clerk.gateway, publishableKey: deps.clerk.publishableKey, defaultWorkspaceSlug: deps.clerk.defaultWorkspaceSlug, db: deps.db, kek: deps.kek, clock, secureCookies, crm: reg.crmDeps } : null);
  if (deps.clerk) mountClerkConnectors(reg, { gateway: deps.clerk.gateway, publishableKey: deps.clerk.publishableKey, defaultWorkspaceSlug: deps.clerk.defaultWorkspaceSlug, db: deps.db, kek: deps.kek, clock, secureCookies, crm: reg.crmDeps });
  mountTracking(app, { db: deps.db, secret: deps.kek ?? 'cooks-dev', clock, jobs, publicUrl });
  mountTelephonyWebhooks(app, { db: deps.db, jobs, clock, publicUrl, dialer, trustSignature: deps.telephony?.trustWebhookSignature === false });
  mountInkboxWebhook(app, { db: deps.db, jobs, clock, publicUrl, channels, trustSignature: deps.channels?.trustWebhookSignature === false });
  mountConnect(app, { db: deps.db, publicUrl, kek: deps.kek, apps: deps.connectorApps ?? {}, msTenant: deps.msTenant, fetchImpl: deps.fetchImpl, now: () => clock.now() });
  if (deps.oauth) mountOAuth(app, { db: deps.db, issuer: publicUrl, key: deps.oauth.key, clock, dcrEnabled: deps.oauth.dcrEnabled ?? true, secureCookies: deps.oauth.secureCookies ?? publicUrl.startsWith('https') });

  // OpenAPI document, served at the same paths as upstream (/openapi.yml) plus JSON and docs.
  app.openAPIRegistry.registerComponent('securitySchemes', 'BearerAuth', {
    type: 'http',
    scheme: 'bearer',
    description: 'A Cooks API key (`cooks-api-...`, also accepts `nooks-api-...`) or an OAuth 2.1 access token.',
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'OAuth2', {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: `${publicUrl}/oauth/authorize`,
        tokenUrl: `${publicUrl}/oauth/token`,
        refreshUrl: `${publicUrl}/oauth/token`,
        scopes: Object.fromEntries(SCOPES.map((s) => [s, SCOPE_DESCRIPTIONS[s]])),
      },
    },
  });
  const docConfig = {
    openapi: '3.1.0',
    info: {
      title: 'Cooks API',
      version: deps.version ?? '0.1.0',
      description:
        'Open-source sales engagement API. Wire-compatible with the public Nooks Sequencing API: ' +
        'switch the base URL and existing clients keep working. Cooks is an independent project and is not affiliated with Nooks.',
      license: { name: 'MIT' },
    },
    servers: [{ url: `${publicUrl}/v1` }],
    security: [{ BearerAuth: [] }],
  };
  /** Paths are registered under /v1 but documented relative to the /v1 server, as upstream does. */
  const buildDoc = () => {
    const doc = app.getOpenAPI31Document(docConfig) as unknown as { paths?: Record<string, unknown> } & Record<string, unknown>;
    const paths: Record<string, unknown> = {};
    for (const [p, v] of Object.entries(doc.paths ?? {})) paths[p.startsWith('/v1/') ? p.slice(3) : p] = v;
    return { ...doc, paths };
  };
  app.get('/openapi.json', (c) => c.json(buildDoc()));
  app.get('/openapi.yml', (c) => c.text(toYaml(buildDoc()), 200, { 'content-type': 'application/yaml; charset=utf-8' }));
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'Cooks API' }));

  return { app, registry: reg.registry };
}

export type App = ReturnType<typeof createApp>['app'];
