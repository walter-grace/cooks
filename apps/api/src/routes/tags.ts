import { createRoute, z } from '@hono/zod-openapi';
import { CreateTagBody, IdParam, PageParams, Tag, createTag, dataOf, errorResponses, getTag, jsonBody, jsonResponse, listOf, listTags } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountTags(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/tags',
      operationId: 'listTags',
      tags: ['Tags'],
      summary: 'List tags',
      request: { query: z.object({ ...PageParams, 'filter[name]': z.string().optional() }) },
      responses: { 200: jsonResponse(listOf(Tag), 'Tags'), ...errorResponses },
    }),
    { scope: 'tags:read', rateClass: 'list' },
    async (c) => c.json(await listTags(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/tags',
      operationId: 'createTag',
      tags: ['Tags'],
      summary: 'Create a tag (idempotent by case-insensitive name)',
      request: { body: jsonBody(CreateTagBody) },
      responses: { 200: jsonResponse(dataOf(Tag), 'Existing tag'), 201: jsonResponse(dataOf(Tag), 'Created'), ...errorResponses },
    }),
    { scope: 'tags:write', rateClass: 'write' },
    async (c) => {
      const { tag, created } = await createTag(c.get('ctx'), c.req.valid('json').data.name);
      return c.json({ data: tag }, created ? 201 : 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/tags/{id}',
      operationId: 'getTag',
      tags: ['Tags'],
      summary: 'Get a tag',
      request: { params: IdParam },
      responses: { 200: jsonResponse(dataOf(Tag), 'Tag'), ...errorResponses },
    }),
    { scope: 'tags:read', rateClass: 'get' },
    async (c) => c.json({ data: await getTag(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
}
