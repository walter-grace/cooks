import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateSequenceStateBody,
  IdParam,
  PageParams,
  SequenceState,
  UpdateSequenceStateBody,
  UpdatedAtLt,
  createSequenceState,
  dataOf,
  deleteSequenceState,
  errorResponses,
  finishSequenceState,
  getSequenceState,
  jsonBody,
  jsonResponse,
  listOf,
  listSequenceStates,
  pauseSequenceState,
  resumeSequenceState,
  updateSequenceState,
} from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export { serializeSequenceStateRow } from '@cooks/core';

export function mountSequenceStates(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/sequenceStates',
      operationId: 'listSequenceStates',
      tags: ['Sequence States'],
      summary: 'List enrollments',
      request: {
        query: z.object({
          ...PageParams,
          'filter[sequence][id]': z.string().optional(),
          'filter[prospect][id]': z.string().optional(),
          'filter[account][id]': z.string().optional(),
          'filter[state]': z.enum(['active', 'paused', 'finished', 'pending_start']).optional(),
          include: z.string().optional().openapi({ description: 'Allowed: sequence, prospect, creator, sequenceStep' }),
          ...UpdatedAtLt,
        }),
      },
      responses: { 200: jsonResponse(listOf(SequenceState), 'Enrollments'), ...errorResponses },
    }),
    { scope: 'sequence-states:read', rateClass: 'list' },
    async (c) => c.json(await listSequenceStates(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/sequenceStates',
      operationId: 'createSequenceState',
      tags: ['Sequence States'],
      summary: 'Enroll a prospect in a sequence',
      request: { body: jsonBody(CreateSequenceStateBody) },
      responses: { 201: jsonResponse(dataOf(SequenceState), 'Enrolled'), 409: jsonResponse(z.any(), 'Already enrolled'), 422: jsonResponse(z.any(), 'Cannot enroll'), ...errorResponses },
    }),
    { scope: 'sequence-states:write', rateClass: 'write' },
    async (c) => c.json({ data: await createSequenceState(c.get('ctx'), c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/sequenceStates/{id}',
      operationId: 'getSequenceState',
      tags: ['Sequence States'],
      summary: 'Get an enrollment',
      request: { params: IdParam, query: z.object({ include: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(SequenceState), 'Enrollment'), ...errorResponses },
    }),
    { scope: 'sequence-states:read', rateClass: 'get' },
    async (c) => c.json({ data: await getSequenceState(c.get('ctx'), c.req.valid('param').id, c.req.query('include')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'patch',
      path: '/v1/sequenceStates/{id}',
      operationId: 'updateSequenceState',
      tags: ['Sequence States'],
      summary: 'Replace emailOverrides',
      request: { params: IdParam, body: jsonBody(UpdateSequenceStateBody) },
      responses: { 200: jsonResponse(dataOf(SequenceState), 'Updated'), ...errorResponses },
    }),
    { scope: 'sequence-states:write', rateClass: 'write' },
    async (c) => c.json({ data: await updateSequenceState(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data.emailOverrides) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'delete',
      path: '/v1/sequenceStates/{id}',
      operationId: 'deleteSequenceState',
      tags: ['Sequence States'],
      summary: 'Remove the prospect from the sequence',
      request: { params: IdParam },
      responses: { 204: { description: 'Removed' }, ...errorResponses },
    }),
    { scope: 'sequence-states:write', rateClass: 'write' },
    async (c) => {
      await deleteSequenceState(c.get('ctx'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/sequenceStates/{id}/actions/finish',
      operationId: 'finishSequenceState',
      tags: ['Sequence States'],
      summary: 'Finish an enrollment (idempotent)',
      request: { params: IdParam },
      responses: { 204: { description: 'Finished' }, ...errorResponses },
    }),
    { scope: 'sequence-states:write', rateClass: 'write' },
    async (c) => {
      await finishSequenceState(c.get('ctx'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/sequenceStates/{id}/actions/pause',
      operationId: 'pauseSequenceState',
      tags: ['Sequence States'],
      summary: 'Pause an enrollment',
      request: { params: IdParam },
      responses: { 200: jsonResponse(dataOf(SequenceState), 'Paused'), ...errorResponses },
    }),
    { scope: 'sequence-states:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await pauseSequenceState(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/sequenceStates/{id}/actions/resume',
      operationId: 'resumeSequenceState',
      tags: ['Sequence States'],
      summary: 'Resume a paused enrollment',
      request: { params: IdParam },
      responses: { 200: jsonResponse(dataOf(SequenceState), 'Resumed'), ...errorResponses },
    }),
    { scope: 'sequence-states:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await resumeSequenceState(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
}
