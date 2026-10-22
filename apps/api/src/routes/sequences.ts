import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateSequenceBody,
  IdParam,
  PageParams,
  ReorderStepsBody,
  Sequence,
  UpdateSequenceBody,
  UpdatedAtLt,
  createSequence,
  dataOf,
  errorResponses,
  getSequence,
  jsonBody,
  jsonResponse,
  listOf,
  listSequences,
  reorderSteps,
  updateSequence,
} from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountSequences(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/sequences',
      operationId: 'listSequences',
      tags: ['Sequences'],
      summary: 'List sequences',
      request: {
        query: z.object({
          ...PageParams,
          'filter[name]': z.string().optional(),
          'filter[type]': z.enum(['interval', 'date']).optional(),
          'filter[parentSequence][id]': z.string().optional().openapi({ description: 'UUID, or "null" for top-level sequences' }),
          include: z.string().optional().openapi({ description: 'Allowed: owner, sequenceSteps' }),
          ...UpdatedAtLt,
        }),
      },
      responses: { 200: jsonResponse(listOf(Sequence), 'Sequences'), ...errorResponses },
    }),
    { scope: 'sequences:read', rateClass: 'list' },
    async (c) => c.json(await listSequences(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/sequences',
      operationId: 'createSequence',
      tags: ['Sequences'],
      summary: 'Create a sequence',
      request: { body: jsonBody(CreateSequenceBody) },
      responses: { 201: jsonResponse(dataOf(Sequence), 'Created'), ...errorResponses },
    }),
    { scope: 'sequences:write', rateClass: 'write' },
    async (c) => c.json({ data: await createSequence(c.get('ctx'), c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/sequences/{id}',
      operationId: 'getSequence',
      tags: ['Sequences'],
      summary: 'Get a sequence',
      request: { params: IdParam, query: z.object({ include: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(Sequence), 'Sequence'), ...errorResponses },
    }),
    { scope: 'sequences:read', rateClass: 'get' },
    async (c) => c.json({ data: await getSequence(c.get('ctx'), c.req.valid('param').id, c.req.query('include')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'patch',
      path: '/v1/sequences/{id}',
      operationId: 'updateSequence',
      tags: ['Sequences'],
      summary: 'Update a sequence (name, enabled, tags)',
      request: { params: IdParam, body: jsonBody(UpdateSequenceBody) },
      responses: { 200: jsonResponse(dataOf(Sequence), 'Updated'), ...errorResponses },
    }),
    { scope: 'sequences:write', rateClass: 'write' },
    async (c) => c.json({ data: await updateSequence(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/sequences/{id}/actions/reorderSteps',
      operationId: 'reorderSequenceSteps',
      tags: ['Sequences'],
      summary: 'Reorder steps (the list must contain every step)',
      request: { params: IdParam, body: jsonBody(ReorderStepsBody) },
      responses: { 200: jsonResponse(dataOf(Sequence), 'Reordered'), 422: jsonResponse(z.any(), 'Incomplete list'), ...errorResponses },
    }),
    { scope: 'sequence-steps:write', rateClass: 'write' },
    async (c) => c.json({ data: await reorderSteps(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data.stepIds) }, 200),
  );
}
