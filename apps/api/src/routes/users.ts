import { createRoute, z } from '@hono/zod-openapi';
import { IdParam, PageParams, UpdatedAtLt, User, dataOf, errorResponses, getUser, jsonResponse, listOf, listUsers } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountUsers(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/users',
      operationId: 'listUsers',
      tags: ['Users'],
      summary: 'List workspace users',
      request: {
        query: z.object({
          ...PageParams,
          'filter[name]': z.string().optional(),
          'filter[email]': z.string().optional(),
          'filter[crmId]': z.string().optional(),
          ...UpdatedAtLt,
        }),
      },
      responses: { 200: jsonResponse(listOf(User), 'Users'), ...errorResponses },
    }),
    { scope: 'users:read', rateClass: 'list' },
    async (c) => c.json(await listUsers(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/users/{id}',
      operationId: 'getUser',
      tags: ['Users'],
      summary: 'Get a user',
      request: { params: IdParam },
      responses: { 200: jsonResponse(dataOf(User), 'User'), ...errorResponses },
    }),
    { scope: 'users:read', rateClass: 'get' },
    async (c) => c.json({ data: await getUser(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
}
