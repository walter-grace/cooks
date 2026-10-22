import { createRoute, z } from '@hono/zod-openapi';
import { createApiKey, revokeApiKey } from '@cooks/auth';
import { IdParam, assertCanManageKeys, dataOf, errorResponses, getApiKeyRow, getWorkspace, jsonBody, jsonResponse, listApiKeys, serializeApiKey, updateWorkspace } from '@cooks/core';
import { register, type Registrar } from '../register.js';

const Settings = z
  .object({
    timezone: z.string().max(64).optional(),
    sendWindow: z.object({ days: z.array(z.number().int().min(1).max(7)).min(1), start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/) }).optional(),
    jitterSeconds: z.number().int().min(0).max(3600).optional(),
    replyBehavior: z.enum(['finish', 'pause', 'continue']).optional(),
    tracking: z.object({ opens: z.boolean(), clicks: z.boolean() }).optional(),
    minProspectGapHours: z.number().int().min(0).max(720).optional(),
    requireUnsubscribeLink: z.boolean().optional(),
  })
  .openapi('WorkspaceSettings');
const Workspace = z.object({ id: z.string().uuid(), name: z.string(), slug: z.string(), settings: Settings, createdAt: z.string(), updatedAt: z.string() }).openapi('Workspace');
const ApiKey = z
  .object({ id: z.string().uuid(), name: z.string(), keyId: z.string(), prefix: z.string(), createdBy: z.string().nullable(), lastUsedAt: z.string().nullable(), revokedAt: z.string().nullable(), createdAt: z.string() })
  .openapi('ApiKey');

export function mountWorkspace(reg: Registrar, opts: { keyPrefix: 'cooks' | 'nooks' }) {
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace', operationId: 'getWorkspace', tags: ['Workspace'], summary: 'Current workspace and settings', responses: { 200: jsonResponse(dataOf(Workspace), 'Workspace'), ...errorResponses } }),
    { rateClass: 'default', extension: true },
    async (c) => c.json({ data: await getWorkspace(c.get('ctx')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'patch',
      path: '/v1/workspace',
      operationId: 'updateWorkspace',
      tags: ['Workspace'],
      summary: 'Update workspace name or settings (shallow merge)',
      request: { body: jsonBody(z.object({ data: z.object({ name: z.string().min(1).max(200).optional(), settings: Settings.optional() }) })) },
      responses: { 200: jsonResponse(dataOf(Workspace), 'Updated'), ...errorResponses },
    }),
    { rateClass: 'write', extension: true },
    async (c) => c.json({ data: await updateWorkspace(c.get('ctx'), c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/apiKeys', operationId: 'listApiKeys', tags: ['API keys'], summary: 'List active API keys (no secrets)', responses: { 200: jsonResponse(z.object({ data: z.array(ApiKey) }), 'Keys'), ...errorResponses } }),
    { scope: 'api-keys:write', rateClass: 'list', extension: true },
    async (c) => c.json({ data: await listApiKeys(c.get('ctx')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/apiKeys',
      operationId: 'createApiKey',
      tags: ['API keys'],
      summary: 'Create an API key (token shown once)',
      request: { body: jsonBody(z.object({ data: z.object({ name: z.string().min(1).max(100) }) })) },
      responses: { 201: jsonResponse(dataOf(ApiKey.extend({ token: z.string() })), 'Created'), ...errorResponses },
    }),
    { scope: 'api-keys:write', rateClass: 'write', extension: true },
    async (c) => {
      const ctx = c.get('ctx');
      assertCanManageKeys(ctx);
      const created = await createApiKey(ctx.db, { workspaceId: ctx.principal.workspaceId, name: c.req.valid('json').data.name, createdBy: ctx.principal.userId, prefix: opts.keyPrefix });
      const row = await getApiKeyRow(ctx, created.id);
      return c.json({ data: { ...serializeApiKey(row), token: created.token } }, 201);
    },
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/apiKeys/{id}', operationId: 'revokeApiKey', tags: ['API keys'], summary: 'Revoke an API key', request: { params: IdParam }, responses: { 204: { description: 'Revoked' }, ...errorResponses } }),
    { scope: 'api-keys:write', rateClass: 'write', extension: true },
    async (c) => {
      const ctx = c.get('ctx');
      assertCanManageKeys(ctx);
      await getApiKeyRow(ctx, c.req.valid('param').id);
      await revokeApiKey(ctx.db, ctx.principal.workspaceId, c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}
