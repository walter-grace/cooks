import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateTaskBody,
  IdParam,
  PageParams,
  Task,
  UpdateTaskBody,
  UpdatedAtLt,
  completeTask,
  createTask,
  dataOf,
  deleteTask,
  errorResponses,
  getTask,
  jsonBody,
  jsonResponse,
  listOf,
  listTasks,
  skipTask,
  updateTask,
} from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountTasks(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/tasks',
      operationId: 'listTasks',
      tags: ['Tasks'],
      summary: 'List tasks',
      request: {
        query: z.object({
          ...PageParams,
          'filter[id]': z.string().optional(),
          'filter[sequence][id]': z.string().optional(),
          'filter[sequenceStep][id]': z.string().optional(),
          'filter[prospect][id]': z.string().optional(),
          'filter[account][id]': z.string().optional(),
          'filter[owner][id]': z.string().optional(),
          'filter[action]': z.string().optional(),
          'filter[status]': z.string().optional(),
          'filter[priority]': z.enum(['low', 'normal', 'high', 'urgent']).optional(),
          'filter[dueAt][gte]': z.string().optional(),
          'filter[dueAt][lte]': z.string().optional(),
          'filter[completed]': z.string().optional(),
          'filter[sequenceState][state]': z.string().optional(),
          include: z.string().optional().openapi({ description: 'Allowed: prospect' }),
          ...UpdatedAtLt,
        }),
      },
      responses: { 200: jsonResponse(listOf(Task), 'Tasks'), ...errorResponses },
    }),
    { scope: 'tasks:read', rateClass: 'list' },
    async (c) => c.json(await listTasks(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/tasks',
      operationId: 'createTask',
      tags: ['Tasks'],
      summary: 'Create a one-off task',
      request: { body: jsonBody(CreateTaskBody) },
      responses: { 201: jsonResponse(dataOf(Task), 'Created'), ...errorResponses },
    }),
    { scope: 'tasks:write', rateClass: 'write' },
    async (c) => c.json({ data: await createTask(c.get('ctx'), c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/tasks/{id}',
      operationId: 'getTask',
      tags: ['Tasks'],
      summary: 'Get a task',
      request: { params: IdParam, query: z.object({ include: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(Task), 'Task'), ...errorResponses },
    }),
    { scope: 'tasks:read', rateClass: 'get' },
    async (c) => c.json({ data: await getTask(c.get('ctx'), c.req.valid('param').id, c.req.query('include')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'patch',
      path: '/v1/tasks/{id}',
      operationId: 'updateTask',
      tags: ['Tasks'],
      summary: 'Update dueAt, ownerId, priority or note',
      request: { params: IdParam, body: jsonBody(UpdateTaskBody) },
      responses: { 200: jsonResponse(dataOf(Task), 'Updated'), ...errorResponses },
    }),
    { scope: 'tasks:write', rateClass: 'write' },
    async (c) => c.json({ data: await updateTask(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'delete',
      path: '/v1/tasks/{id}',
      operationId: 'deleteTask',
      tags: ['Tasks'],
      summary: 'Delete a task',
      request: { params: IdParam },
      responses: { 204: { description: 'Deleted' }, ...errorResponses },
    }),
    { scope: 'tasks:write', rateClass: 'write' },
    async (c) => {
      await deleteTask(c.get('ctx'), c.req.valid('param').id);
      return c.body(null, 204);
    },
  );
  for (const [verb, fn] of [
    ['complete', completeTask],
    ['skip', skipTask],
  ] as const) {
    register(
      reg,
      createRoute({
        method: 'post',
        path: `/v1/tasks/{id}/${verb}`,
        operationId: `${verb}Task`,
        tags: ['Tasks'],
        summary: `${verb === 'complete' ? 'Complete' : 'Skip'} a task (advances its enrollment)`,
        request: { params: IdParam },
        responses: { 200: jsonResponse(dataOf(Task), 'Task'), ...errorResponses },
      }),
      { scope: 'tasks:write', rateClass: 'write' },
      async (c) => c.json({ data: await fn(c.get('ctx'), c.req.valid('param').id) }, 200),
    );
  }
}
