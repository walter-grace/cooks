import { createRoute, z } from '@hono/zod-openapi';
import { CreateEmailBody, Email, IdParam, ImportEmailBody, ImportEmailResponse, PageParams, UpdatedAtLt, createEmail, dataOf, errorResponses, getEmail, importEmail, jsonBody, jsonResponse, listEmails, listOf } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountEmails(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/emails',
      operationId: 'listEmails',
      tags: ['Emails'],
      summary: 'List emails',
      request: {
        query: z.object({
          ...PageParams,
          'filter[id]': z.string().optional(),
          'filter[prospect][id]': z.string().optional(),
          'filter[task][id]': z.string().optional(),
          'filter[account][id]': z.string().optional(),
          'filter[status]': z.string().optional(),
          include: z.string().optional().openapi({ description: 'Allowed: prospect, task, sequence, sequenceStep' }),
          ...UpdatedAtLt,
        }),
      },
      responses: { 200: jsonResponse(listOf(Email), 'Emails'), ...errorResponses },
    }),
    { scope: 'emails:read', rateClass: 'list' },
    async (c) => c.json(await listEmails(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/emails',
      operationId: 'createEmail',
      tags: ['Emails'],
      summary: 'Create a manual email (draft + task); send=true queues it through the owner mailbox',
      request: { body: jsonBody(CreateEmailBody) },
      responses: { 201: jsonResponse(dataOf(Email), 'Created'), ...errorResponses },
    }),
    { scope: 'emails:write', rateClass: 'write' },
    async (c) => c.json({ data: await createEmail(c.get('ctx'), c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/emails/import',
      operationId: 'importEmail',
      tags: ['Emails'],
      summary: 'Record an email sent or received outside Cooks',
      description:
        'Outbound imports become sent emails linked to the prospect\'s active enrollment, so a later reply matched by Message-ID or thread closes it. Inbound imports run the same pipeline as synced mail: reply or out-of-office detection, the workspace reply policy (finish or pause the enrollment), a high-priority reply task, reply statistics and signals. Repeated imports of the same messageId or externalId return the existing row with 200.',
      request: { body: jsonBody(ImportEmailBody) },
      responses: { 201: jsonResponse(ImportEmailResponse, 'Imported'), 200: jsonResponse(ImportEmailResponse, 'Already recorded'), ...errorResponses },
    }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => {
      const r = await importEmail(c.get('ctx'), c.req.valid('json').data);
      return c.json({ data: r.email, meta: { created: r.created, outcome: r.outcome } }, r.created ? 201 : 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/emails/{id}',
      operationId: 'getEmail',
      tags: ['Emails'],
      summary: 'Get an email',
      request: { params: IdParam, query: z.object({ include: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(Email), 'Email'), ...errorResponses },
    }),
    { scope: 'emails:read', rateClass: 'get' },
    async (c) => c.json({ data: await getEmail(c.get('ctx'), c.req.valid('param').id, c.req.query('include')) }, 200),
  );
}
