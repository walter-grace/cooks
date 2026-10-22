import { createRoute, z } from '@hono/zod-openapi';
import { EmailTemplate, IdParam, PageParams, UpdatedAtLt, dataOf, errorResponses, getEmailTemplate, jsonResponse, listEmailTemplates, listOf } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountEmailTemplates(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/emailTemplates',
      operationId: 'listEmailTemplates',
      tags: ['Email Templates'],
      summary: 'List email templates',
      request: { query: z.object({ ...PageParams, 'filter[owner][id]': z.string().optional(), 'filter[archived]': z.string().optional(), ...UpdatedAtLt }) },
      responses: { 200: jsonResponse(listOf(EmailTemplate), 'Templates'), ...errorResponses },
    }),
    { scope: 'email-templates:read', rateClass: 'list' },
    async (c) => c.json(await listEmailTemplates(c.get('ctx'), listArgs(c)), 200),
  );
  // Upstream quirk preserved: the single-item path is singular.
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/emailTemplate/{id}',
      operationId: 'getEmailTemplate',
      tags: ['Email Templates'],
      summary: 'Get an email template',
      request: { params: IdParam },
      responses: { 200: jsonResponse(dataOf(EmailTemplate), 'Template'), ...errorResponses },
    }),
    { scope: 'email-templates:read', rateClass: 'get' },
    async (c) => c.json({ data: await getEmailTemplate(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
}
