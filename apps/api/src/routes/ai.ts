import { createRoute, z } from '@hono/zod-openapi';
import { IdParam, PageParams, agentRunStats, dataOf, errorResponses, getAgentRun, getAiSettings, jsonBody, jsonResponse, listAgentRuns, listOf, updateAiSettings } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

const Run = z
  .object({
    id: z.string().uuid(),
    kind: z.string(),
    status: z.string(),
    provider: z.string().nullable(),
    model: z.string().nullable(),
    agentId: z.string().nullable(),
    parentType: z.string().nullable(),
    parentId: z.string().nullable(),
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
    tokensCacheRead: z.number().int(),
    costUsd: z.number().nullable(),
    latencyMs: z.number().int().nullable(),
    error: z.string().nullable(),
    output: z.unknown(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('AgentRun');
const AiSettings = z
  .object({
    provider: z.enum(['anthropic', 'openai', 'xai', 'openrouter', 'ollama', 'custom']).nullable(),
    model: z.string().nullable(),
    baseUrl: z.string().nullable(),
    hasKey: z.boolean(),
    keyLast4: z.string().nullable(),
    classifyModel: z.string().nullable(),
    draftModel: z.string().nullable(),
    autoSendAiEmail: z.boolean(),
    confidenceThreshold: z.number(),
    monthlyBudgetUsd: z.number().nullable(),
  })
  .openapi('AiSettings');
const AiSettingsBody = z.object({
  data: z.object({
    provider: z.enum(['anthropic', 'openai', 'xai', 'openrouter', 'ollama', 'custom']).optional(),
    model: z.string().max(200).nullable().optional(),
    baseUrl: z.string().url().nullable().optional(),
    apiKey: z.string().max(500).nullable().optional().describe('Stored encrypted with COOKS_KEK; never returned'),
    classifyModel: z.string().max(200).nullable().optional(),
    draftModel: z.string().max(200).nullable().optional(),
    autoSendAiEmail: z.boolean().optional(),
    confidenceThreshold: z.number().min(0).max(1).optional(),
    monthlyBudgetUsd: z.number().min(0).nullable().optional(),
  }),
});

export function mountAi(reg: Registrar, opts: { kek?: string }) {
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/agentRuns', operationId: 'listAgentRuns', tags: ['AI'], summary: 'Hosted agent runs (drafts, classifications) with tokens and cost', request: { query: z.object({ ...PageParams, 'filter[kind]': z.string().optional(), 'filter[status]': z.string().optional(), 'filter[parent][id]': z.string().optional() }) }, responses: { 200: jsonResponse(listOf(Run), 'Runs'), ...errorResponses } }),
    { scope: 'agents:run', rateClass: 'list', extension: true },
    async (c) => c.json(await listAgentRuns(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/agentRuns/stats', operationId: 'getAgentRunStats', tags: ['AI'], summary: 'Spend and volume by day, provider, model and kind', request: { query: z.object({ days: z.string().optional() }) }, responses: { 200: jsonResponse(dataOf(z.object({ since: z.string(), totalCostUsd: z.number(), rows: z.array(z.record(z.string(), z.unknown())) })), 'Stats'), ...errorResponses } }),
    { scope: 'agents:run', rateClass: 'default', extension: true },
    async (c) => c.json({ data: await agentRunStats(c.get('ctx'), Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30) || 30))) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/agentRuns/{id}', operationId: 'getAgentRun', tags: ['AI'], summary: 'One run with redacted input and logs', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(Run.extend({ input: z.unknown(), logs: z.array(z.record(z.string(), z.unknown())) })), 'Run'), ...errorResponses } }),
    { scope: 'agents:run', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await getAgentRun(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/ai', operationId: 'getAiSettings', tags: ['AI'], summary: 'Hosted AI provider settings (keys never returned)', responses: { 200: jsonResponse(dataOf(AiSettings), 'Settings'), ...errorResponses } }),
    { rateClass: 'default', extension: true },
    async (c) => c.json({ data: await getAiSettings(c.get('ctx')) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'patch', path: '/v1/workspace/ai', operationId: 'updateAiSettings', tags: ['AI'], summary: 'Choose provider/model, store a key, set auto-send, confidence and budget', request: { body: jsonBody(AiSettingsBody) }, responses: { 200: jsonResponse(dataOf(AiSettings), 'Updated'), ...errorResponses } }),
    { rateClass: 'write', extension: true },
    async (c) => c.json({ data: await updateAiSettings(c.get('ctx'), c.req.valid('json').data, opts.kek) }, 200),
  );
}
