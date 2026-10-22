import type { OpenAPIHono, RouteConfig, RouteHandler } from '@hono/zod-openapi';
import { assertScope, type CrmDeps, type Scope } from '@cooks/core';
import { enforceRateLimit, type RateClass, type RateLimitStore } from './middleware/rate-limit.js';
import type { AppEnv } from './types.js';

export interface RouteMeta {
  scope?: Scope;
  rateClass: RateClass;
  /** Mark Cooks-only operations so the conformance report can ignore them. */
  extension?: boolean;
}

export interface Registrar {
  app: OpenAPIHono<AppEnv>;
  /** KEK, outbound fetch, OAuth apps and token brokers for CRM calls made from route handlers. */
  crmDeps: CrmDeps;
  store: RateLimitStore;
  now: () => Date;
  registry: Array<{ method: string; path: string; operationId?: string; meta: RouteMeta }>;
}

const honoPath = (p: string) => p.replace(/\{(\w+)\}/g, ':$1');

/**
 * Register a typed OpenAPI route with scope + rate-limit enforcement that runs
 * before validation, so a 403/429 never leaks schema details.
 */
export function register<R extends RouteConfig>(reg: Registrar, route: R, meta: RouteMeta, handler: RouteHandler<R, AppEnv>): void {
  const method = route.method.toUpperCase();
  const path = honoPath(route.path);
  reg.registry.push({ method, path: route.path, operationId: route.operationId, meta });
  reg.app.on(method, path, async (c, next) => {
    assertScope(c.get('principal'), meta.scope);
    await enforceRateLimit(c, reg.store, meta.rateClass, `${method} ${route.path}`, reg.now());
    await next();
  });
  const decorated = meta.extension
    ? ({ ...route, description: `${route.description ?? ''}\n\n_Cooks extension: not part of the upstream API._`.trim(), tags: [...(route.tags ?? []), 'Cooks extensions'] } as R)
    : route;
  reg.app.openapi(decorated, handler);
}
