import { createRoute, z } from '@hono/zod-openapi';
import { IdParam, PageParams, SIGNAL_KIND_CATALOG, actOnSignal, createSignalRule, dataOf, deleteSignalRule, dismissSignal, errorResponses, getSignal, insufficientPermission, jsonBody, jsonResponse, listOf, listSignalRules, listSignals, pushSignal, serializeSignal, signalSummary } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

const Signal = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    source: z.string().nullable(),
    title: z.string().nullable(),
    url: z.string().nullable(),
    score: z.number().nullable(),
    status: z.string(),
    actedAction: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    prospect: z.unknown(),
    account: z.unknown(),
    occurredAt: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('Signal');
const Rule = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    kindPattern: z.string(),
    minScore: z.number().nullable(),
    action: z.string(),
    sequenceId: z.string().nullable(),
    sequenceName: z.string().nullable(),
    ownerId: z.string().nullable(),
    taskAction: z.string().nullable(),
    taskNote: z.string().nullable(),
    enabled: z.boolean(),
    firedCount: z.number().int(),
    lastFiredAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('SignalRule');
const PushBody = z.object({
  data: z.object({
    kind: z.string().describe('category.type, e.g. research.funding, web.visit, custom.event'),
    title: z.string().max(500).optional(),
    url: z.string().url().optional(),
    source: z.string().max(100).optional(),
    score: z.number().min(0).max(1).optional(),
    occurredAt: z.string().optional(),
    dedupeKey: z.string().max(200).optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
    prospect: z.object({ id: z.string().optional(), email: z.string().optional() }).optional(),
    account: z.object({ id: z.string().optional(), domain: z.string().optional() }).optional(),
  }),
});
const ActBody = z.object({
  data: z.discriminatedUnion('action', [
    z.object({ action: z.literal('enroll'), sequenceId: z.string().uuid(), ownerId: z.string() }),
    z.object({ action: z.literal('task'), ownerId: z.string(), taskAction: z.string().optional(), note: z.string().optional(), dueAt: z.string().optional() }),
  ]),
});
const RuleBody = z.object({
  data: z.object({
    name: z.string().max(120).optional(),
    kindPattern: z.string(),
    minScore: z.number().min(0).max(1).nullable().optional(),
    action: z.enum(['enroll', 'task']),
    sequenceId: z.string().uuid().optional(),
    ownerId: z.string(),
    taskAction: z.string().optional(),
    taskNote: z.string().optional(),
    enabled: z.boolean().optional(),
  }),
});

const requireAdmin = (c: { get: (k: 'ctx') => { principal: { role?: string | null; bypassRoleChecks?: boolean } } }) => {
  const p = c.get('ctx').principal;
  if (!p.bypassRoleChecks && p.role !== 'admin') throw insufficientPermission('Only admins can manage signal rules');
};

export function mountSignals(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/signals',
      operationId: 'listSignals',
      tags: ['Signals'],
      summary: 'Buying signals feed',
      request: {
        query: z.object({
          ...PageParams,
          'filter[kind]': z.string().optional().describe('Exact kind or prefix with *, e.g. research.*'),
          'filter[status]': z.string().optional().describe('new (default all), acted, dismissed, all'),
          'filter[prospect][id]': z.string().optional(),
          'filter[account][id]': z.string().optional(),
          'filter[occurredAt][gte]': z.string().optional(),
          include: z.string().optional().openapi({ description: 'Allowed: prospect, account' }),
        }),
      },
      responses: { 200: jsonResponse(listOf(Signal), 'Signals'), ...errorResponses },
    }),
    { scope: 'prospects:read', rateClass: 'list', extension: true },
    async (c) => c.json(await listSignals(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/signals/summary', operationId: 'getSignalSummary', tags: ['Signals'], summary: 'Signal counts by kind for the last N days', request: { query: z.object({ days: z.coerce.number().int().min(1).max(90).optional() }) }, responses: { 200: jsonResponse(dataOf(z.object({ days: z.number(), total: z.number(), new: z.number(), byKind: z.record(z.string(), z.number()), catalog: z.record(z.string(), z.string()) })), 'Summary'), ...errorResponses } }),
    { scope: 'prospects:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: { ...(await signalSummary(c.get('ctx'), c.req.valid('query').days ?? 7)), catalog: SIGNAL_KIND_CATALOG } }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/signals', operationId: 'pushSignal', tags: ['Signals'], summary: 'Record a buying signal from a bot or integration', description: 'Attach to a prospect (id or email) or an account (id or domain). Pass dedupeKey to make the call idempotent. Rules run immediately.', request: { body: jsonBody(PushBody) }, responses: { 201: jsonResponse(dataOf(Signal), 'Created'), 200: jsonResponse(dataOf(Signal), 'Already recorded'), ...errorResponses } }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => {
      const r = await pushSignal(c.get('ctx'), c.req.valid('json').data);
      return c.json({ data: serializeSignal(r.signal) }, r.created ? 201 : 200);
    },
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/signals/{id}', operationId: 'getSignal', tags: ['Signals'], summary: 'Get a signal', request: { params: IdParam, query: z.object({ include: z.string().optional() }) }, responses: { 200: jsonResponse(dataOf(Signal), 'Signal'), ...errorResponses } }),
    { scope: 'prospects:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await getSignal(c.get('ctx'), c.req.valid('param').id, c.req.query('include')) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/signals/{id}/actions/dismiss', operationId: 'dismissSignal', tags: ['Signals'], summary: 'Dismiss a signal', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(Signal), 'Dismissed'), ...errorResponses } }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await dismissSignal(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/signals/{id}/actions/act', operationId: 'actOnSignal', tags: ['Signals'], summary: 'Enroll the prospect or create a task from a signal', request: { params: IdParam, body: jsonBody(ActBody) }, responses: { 200: jsonResponse(dataOf(z.record(z.string(), z.unknown())), 'Result'), ...errorResponses } }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await actOnSignal(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/signalRules', operationId: 'listSignalRules', tags: ['Signals'], summary: 'Rules that turn signals into enrollments or tasks', responses: { 200: jsonResponse(z.object({ data: z.array(Rule) }), 'Rules'), ...errorResponses } }),
    { scope: 'prospects:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await listSignalRules(c.get('ctx')) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/workspace/signalRules', operationId: 'createSignalRule', tags: ['Signals'], summary: 'Add a signal rule', request: { body: jsonBody(RuleBody) }, responses: { 201: jsonResponse(dataOf(Rule), 'Created'), ...errorResponses } }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => {
      requireAdmin(c);
      return c.json({ data: await createSignalRule(c.get('ctx'), c.req.valid('json').data) }, 201);
    },
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/workspace/signalRules/{id}', operationId: 'deleteSignalRule', tags: ['Signals'], summary: 'Remove a signal rule', request: { params: IdParam }, responses: { 204: { description: 'Deleted' }, ...errorResponses } }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => {
      requireAdmin(c);
      await deleteSignalRule(c.get('ctx'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
}
