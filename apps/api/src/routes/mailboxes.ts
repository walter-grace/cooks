import { createRoute, z } from '@hono/zod-openapi';
import { CreateMailboxBody, IdParam, Mailbox, PageParams, UpdatedAtLt, createMailbox, dataOf, errorResponses, getMailbox, jsonBody, jsonResponse, listMailboxes, listOf } from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountMailboxes(reg: Registrar, opts: { kek?: string }) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/mailboxes',
      operationId: 'listMailboxes',
      tags: ['Mailboxes'],
      summary: 'List mailboxes',
      request: { query: z.object({ ...PageParams, 'filter[userId]': z.string().optional(), include: z.string().optional().openapi({ description: 'Allowed: user' }), ...UpdatedAtLt }) },
      responses: { 200: jsonResponse(listOf(Mailbox), 'Mailboxes'), ...errorResponses },
    }),
    { scope: 'mailboxes:read', rateClass: 'list' },
    async (c) => c.json(await listMailboxes(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/mailboxes/{id}',
      operationId: 'getMailbox',
      tags: ['Mailboxes'],
      summary: 'Get a mailbox',
      request: { params: IdParam, query: z.object({ include: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(Mailbox), 'Mailbox'), ...errorResponses },
    }),
    { scope: 'mailboxes:read', rateClass: 'get' },
    async (c) => c.json({ data: await getMailbox(c.get('ctx'), c.req.valid('param').id, c.req.query('include')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/mailboxes',
      operationId: 'createMailbox',
      tags: ['Mailboxes'],
      summary: 'Connect an SMTP mailbox for a user',
      request: { body: jsonBody(CreateMailboxBody) },
      responses: { 201: jsonResponse(dataOf(Mailbox), 'Created'), ...errorResponses },
    }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await createMailbox(c.get('ctx'), c.req.valid('json').data, opts.kek) }, 201),
  );
}
