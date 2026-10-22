import { createRoute, z } from '@hono/zod-openapi';
import { IdParam, PageParams, WEBHOOK_EVENTS, createWebhook, dataOf, deleteWebhook, errorResponses, jsonBody, jsonResponse, listDeliveries, listOf, listWebhooks, testWebhook, updateWebhook } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

const Endpoint = z
  .object({
    id: z.string().uuid(),
    url: z.string(),
    events: z.array(z.string()),
    enabled: z.boolean(),
    description: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    lastFailureAt: z.string().nullable(),
    consecutiveFailures: z.number().int(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('WebhookEndpoint');
const EndpointWithSecret = Endpoint.extend({ secret: z.string().describe('Shown once. Verify with HMAC-SHA256(secret, `${t}.${rawBody}`).') }).openapi('WebhookEndpointCreated');
const Delivery = z
  .object({
    id: z.string().uuid(),
    eventId: z.string(),
    eventType: z.string(),
    status: z.enum(['pending', 'succeeded', 'failed', 'exhausted']),
    attempt: z.number().int(),
    responseStatus: z.number().int().nullable(),
    responseMs: z.number().int().nullable(),
    error: z.string().nullable(),
    nextAttemptAt: z.string().nullable(),
    deliveredAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('WebhookDelivery');
const EventEnum = z.enum(['*', ...WEBHOOK_EVENTS]);
const CreateBody = z.object({ data: z.object({ url: z.string().url(), events: z.array(EventEnum).optional(), description: z.string().max(500).optional() }) });
const UpdateBody = z.object({
  data: z
    .object({ url: z.string().url().optional(), events: z.array(EventEnum).optional(), enabled: z.boolean().optional(), description: z.string().max(500).nullable().optional() })
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});

export function mountWebhooks(reg: Registrar, deps: { kek?: string; fetchImpl?: typeof fetch }) {
  const ext = { scope: 'webhooks:write' as const, extension: true };
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/webhooks', operationId: 'listWebhooks', tags: ['Webhooks'], summary: 'List webhook endpoints', request: { query: z.object({ ...PageParams }) }, responses: { 200: jsonResponse(listOf(Endpoint), 'Endpoints'), ...errorResponses } }),
    { ...ext, rateClass: 'list' },
    async (c) => c.json(await listWebhooks(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/webhooks', operationId: 'createWebhook', tags: ['Webhooks'], summary: 'Create an endpoint (verification ping must answer 2xx)', request: { body: jsonBody(CreateBody) }, responses: { 201: jsonResponse(dataOf(EndpointWithSecret), 'Created'), ...errorResponses } }),
    { ...ext, rateClass: 'write' },
    async (c) => c.json({ data: await createWebhook(c.get('ctx'), c.req.valid('json').data, deps) }, 201),
  );
  register(
    reg,
    createRoute({ method: 'patch', path: '/v1/webhooks/{id}', operationId: 'updateWebhook', tags: ['Webhooks'], summary: 'Update an endpoint', request: { params: IdParam, body: jsonBody(UpdateBody) }, responses: { 200: jsonResponse(dataOf(Endpoint), 'Updated'), ...errorResponses } }),
    { ...ext, rateClass: 'write' },
    async (c) => c.json({ data: await updateWebhook(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data, deps) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/webhooks/{id}', operationId: 'deleteWebhook', tags: ['Webhooks'], summary: 'Delete an endpoint', request: { params: IdParam }, responses: { 204: { description: 'Deleted' }, ...errorResponses } }),
    { ...ext, rateClass: 'write' },
    async (c) => {
      await deleteWebhook(c.get('ctx'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/webhooks/{id}/actions/test', operationId: 'testWebhook', tags: ['Webhooks'], summary: 'Send a signed verification event now', request: { params: IdParam }, responses: { 200: jsonResponse(z.object({ ok: z.boolean(), status: z.number().nullable(), error: z.string().nullable() }), 'Result'), ...errorResponses } }),
    { ...ext, rateClass: 'default' },
    async (c) => c.json(await testWebhook(c.get('ctx'), c.req.valid('param').id, deps), 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/webhooks/{id}/deliveries', operationId: 'listWebhookDeliveries', tags: ['Webhooks'], summary: 'Recent deliveries for an endpoint', request: { params: IdParam, query: z.object({ ...PageParams }) }, responses: { 200: jsonResponse(listOf(Delivery), 'Deliveries'), ...errorResponses } }),
    { ...ext, rateClass: 'list' },
    async (c) => c.json(await listDeliveries(c.get('ctx'), c.req.valid('param').id, listArgs(c)), 200),
  );
}
