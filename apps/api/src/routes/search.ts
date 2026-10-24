import { createRoute, z } from '@hono/zod-openapi';
import { SEARCH_TYPES, errorResponses, insufficientPermission, jsonResponse, search } from '@cooks/core';
import { register, type Registrar } from '../register.js';

const Hit = z
  .object({
    id: z.string().uuid(),
    type: z.enum(SEARCH_TYPES),
    entityId: z.string().uuid(),
    chunk: z.number().int(),
    title: z.string(),
    snippet: z.string().describe('Plain text; matched words are wrapped in « »'),
    prospectId: z.string().uuid().nullable(),
    accountId: z.string().uuid().nullable(),
    occurredAt: z.string(),
    meta: z.record(z.string(), z.unknown()),
    href: z.string().describe('Path inside the web app, relative to /app'),
    score: z.number(),
  })
  .openapi('SearchHit');

export function mountSearch(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/search',
      operationId: 'search',
      tags: ['Search'],
      summary: 'Search prospects, accounts, calls, transcript lines, signals, emails, notes, tasks and sequences',
      description: 'Postgres full-text search with a substring match on titles. Ranked by title match, then relevance, then recency. Scoped to the workspace.',
      request: {
        query: z.object({
          q: z.string().min(1).max(200),
          types: z.string().optional().describe(`Comma-separated subset of ${SEARCH_TYPES.join(', ')}`),
          limit: z.coerce.number().int().min(1).max(50).optional(),
          prospectId: z.string().uuid().optional(),
          accountId: z.string().uuid().optional(),
        }),
      },
      responses: { 200: jsonResponse(z.object({ data: z.array(Hit) }), 'Hits, best first'), ...errorResponses },
    }),
    { scope: 'prospects:read', rateClass: 'list', extension: true },
    async (c) => {
      const qp = c.req.valid('query');
      const types = qp.types
        ?.split(',')
        .map((s) => s.trim())
        .filter((s): s is (typeof SEARCH_TYPES)[number] => (SEARCH_TYPES as readonly string[]).includes(s));
      return c.json({ data: await search(c.get('ctx'), { q: qp.q, types, limit: qp.limit, prospectId: qp.prospectId, accountId: qp.accountId }) }, 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/search/actions/reindex',
      operationId: 'reindexSearch',
      tags: ['Search'],
      summary: 'Rebuild the search index for the workspace',
      description: 'Queues a full rebuild. The worker also refreshes the index incrementally every two minutes, and the first search in an empty workspace builds it inline.',
      responses: { 202: jsonResponse(z.object({ data: z.object({ queued: z.boolean() }) }), 'Queued'), ...errorResponses },
    }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => {
      const ctx = c.get('ctx');
      if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission('Only admins can rebuild the search index');
      await ctx.jobs.send('search.index', { workspaceId: ctx.principal.workspaceId, full: true }, { singletonKey: `search:${ctx.principal.workspaceId}` });
      return c.json({ data: { queued: true } }, 202);
    },
  );
}
