import { createRoute, z } from '@hono/zod-openapi';
import { Call, CallDisposition, IdParam, PageParams, UpdatedAtLt, errorResponses, getCall, getCallDisposition, jsonResponse, listCallDispositions, listCalls, listOf, dataOf } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountCalls(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/calls',
      operationId: 'listCalls',
      tags: ['Calls'],
      summary: 'List calls',
      request: {
        query: z.object({
          ...PageParams,
          'filter[id]': z.string().optional(),
          'filter[time][gte]': z.string().optional(),
          'filter[time][lte]': z.string().optional(),
          'filter[createdAt][gte]': z.string().optional(),
          'filter[createdAt][lte]': z.string().optional(),
          'filter[prospect][id]': z.string().optional(),
          'filter[account][id]': z.string().optional(),
          'filter[callDisposition][id]': z.string().optional(),
          'filter[owner][id]': z.string().optional(),
          include: z.string().optional().openapi({ description: 'Allowed: prospect, sequence, sequenceStep, callDisposition, owner' }),
          ...UpdatedAtLt,
        }),
      },
      responses: { 200: jsonResponse(listOf(Call), 'Calls'), ...errorResponses },
    }),
    { scope: 'calls:read', rateClass: 'list' },
    async (c) => c.json(await listCalls(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/calls/{id}',
      operationId: 'getCall',
      tags: ['Calls'],
      summary: 'Get a call',
      request: { params: IdParam, query: z.object({ include: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(Call), 'Call'), ...errorResponses },
    }),
    { scope: 'calls:read', rateClass: 'get' },
    async (c) => c.json({ data: await getCall(c.get('ctx'), c.req.valid('param').id, c.req.query('include')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/callDispositions',
      operationId: 'listCallDispositions',
      tags: ['Call Dispositions'],
      summary: 'List call dispositions',
      request: { query: z.object({ ...PageParams, 'filter[id]': z.string().optional(), 'filter[name]': z.string().optional() }) },
      responses: { 200: jsonResponse(listOf(CallDisposition), 'Dispositions'), ...errorResponses },
    }),
    { scope: 'call-dispositions:read', rateClass: 'list' },
    async (c) => c.json(await listCallDispositions(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/callDispositions/{id}',
      operationId: 'getCallDisposition',
      tags: ['Call Dispositions'],
      summary: 'Get a call disposition',
      request: { params: IdParam },
      responses: { 200: jsonResponse(dataOf(CallDisposition), 'Disposition'), ...errorResponses },
    }),
    { scope: 'call-dispositions:read', rateClass: 'get' },
    async (c) => c.json({ data: await getCallDisposition(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
}
