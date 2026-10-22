import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateStepBody,
  IdParam,
  PageParams,
  SequenceStep,
  UpdateStepBody,
  UpdatedAtLt,
  assertCanDeleteStep,
  createSequenceStep,
  dataOf,
  deleteSequenceStep,
  errorResponses,
  getSequenceStep,
  jsonBody,
  jsonResponse,
  listOf,
  listSequenceSteps,
  updateSequenceStep,
} from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountSequenceSteps(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/sequenceSteps',
      operationId: 'listSequenceSteps',
      tags: ['Sequence Steps'],
      summary: 'List sequence steps',
      request: {
        query: z.object({
          ...PageParams,
          'filter[id]': z.string().optional(),
          'filter[sequence][id]': z.string().optional(),
          include: z.string().optional().openapi({ description: 'Allowed: template' }),
          ...UpdatedAtLt,
        }),
      },
      responses: { 200: jsonResponse(listOf(SequenceStep), 'Steps'), ...errorResponses },
    }),
    { scope: 'sequence-steps:read', rateClass: 'list' },
    async (c) => c.json(await listSequenceSteps(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/sequenceSteps',
      operationId: 'createSequenceStep',
      tags: ['Sequence Steps'],
      summary: 'Create a step (interval sequences only)',
      request: { body: jsonBody(CreateStepBody) },
      responses: { 201: jsonResponse(dataOf(SequenceStep), 'Created'), ...errorResponses },
    }),
    { scope: 'sequence-steps:write', rateClass: 'write' },
    async (c) => c.json({ data: await createSequenceStep(c.get('ctx'), c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/sequenceSteps/{id}',
      operationId: 'getSequenceStep',
      tags: ['Sequence Steps'],
      summary: 'Get a step',
      request: { params: IdParam, query: z.object({ include: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(SequenceStep), 'Step'), ...errorResponses },
    }),
    { scope: 'sequence-steps:read', rateClass: 'get' },
    async (c) => c.json({ data: await getSequenceStep(c.get('ctx'), c.req.valid('param').id, c.req.query('include')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'patch',
      path: '/v1/sequenceSteps/{id}',
      operationId: 'updateSequenceStep',
      tags: ['Sequence Steps'],
      summary: 'Update a step (channel cannot change)',
      request: { params: IdParam, body: jsonBody(UpdateStepBody) },
      responses: { 200: jsonResponse(dataOf(SequenceStep), 'Updated'), ...errorResponses },
    }),
    { scope: 'sequence-steps:write', rateClass: 'write' },
    async (c) => c.json({ data: await updateSequenceStep(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'delete',
      path: '/v1/sequenceSteps/{id}',
      operationId: 'deleteSequenceStep',
      tags: ['Sequence Steps'],
      summary: 'Delete a step',
      request: { params: IdParam },
      responses: { 204: { description: 'Deleted' }, ...errorResponses },
    }),
    { scope: 'sequence-steps:write', rateClass: 'write' },
    async (c) => {
      const ctx = c.get('ctx');
      await deleteSequenceStep(ctx, c.req.valid('param').id, (seq) => assertCanDeleteStep(ctx, seq));
      return c.body(null, 204);
    },
  );
}
