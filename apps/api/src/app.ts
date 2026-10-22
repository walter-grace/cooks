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
import type { AppEnv } from './types.js';
import { mountRoutes } from './routes/index.js';
import { mountTracking } from './routes/tracking.js';
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

  // Authenticated API surface. Everything under /v1 except /v1/public-ip-list.
  app.use('/v1/*', authMiddleware({ db: deps.db, acceptNooksPrefix: deps.acceptNooksPrefix ?? true, verifyJwt: deps.verifyJwt }));
  app.use('/v1/*', async (c, next) => {
    if (c.req.path === '/v1/public-ip-list') return next();
    const ctx: Ctx = { db: deps.db, principal: c.get('principal'), jobs, clock, traceId: c.get('traceId'), publicUrl };
    c.set('ctx', ctx);
    await next();
  });

  const reg: Registrar = { app, store, now: () => clock.now(), registry: [] };
  mountRoutes(reg, { publicIps: deps.publicIps ?? [], kek: deps.kek, fetchImpl: deps.fetchImpl });
  mountTracking(app, { db: deps.db, secret: deps.kek ?? 'cooks-dev', clock, jobs, publicUrl });

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
