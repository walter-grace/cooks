import { createRoute, z } from '@hono/zod-openapi';
import {
  Account,
  CreateAccountBody,
  CreateNoteBody,
  IdParam,
  Note,
  PageParams,
  UpdatedAtLt,
  createAccount,
  createNote,
  dataOf,
  errorResponses,
  getAccount,
  jsonBody,
  jsonResponse,
  listAccounts,
  listOf,
  updateAccount,
} from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountAccounts(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/accounts',
      operationId: 'listAccounts',
      tags: ['Accounts'],
      summary: 'List accounts',
      request: {
        query: z.object({
          ...PageParams,
          'filter[id]': z.string().optional(),
          'filter[name]': z.string().optional(),
          'filter[domain]': z.string().optional(),
          'filter[crmId]': z.string().optional(),
          ...UpdatedAtLt,
          includeCRMCustomFields: z.string().optional(),
        }),
      },
      responses: { 200: jsonResponse(listOf(Account), 'Accounts'), ...errorResponses },
    }),
    { scope: 'accounts:read', rateClass: 'list' },
    async (c) => c.json(await listAccounts(c.get('ctx'), listArgs(c)), 200),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/accounts/{id}',
      operationId: 'getAccount',
      tags: ['Accounts'],
      summary: 'Get an account',
      request: { params: IdParam, query: z.object({ includeCRMCustomFields: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(Account), 'Account'), ...errorResponses },
    }),
    { scope: 'accounts:read', rateClass: 'get' },
    async (c) => c.json({ data: await getAccount(c.get('ctx'), c.req.valid('param').id, c.req.query('includeCRMCustomFields')) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/accounts',
      operationId: 'createAccount',
      tags: ['Accounts'],
      summary: 'Create an account',
      request: { body: jsonBody(CreateAccountBody) },
      responses: { 201: jsonResponse(dataOf(Account), 'Created'), ...errorResponses },
    }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await createAccount(c.get('ctx'), c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'patch',
      path: '/v1/accounts/{id}',
      operationId: 'updateAccount',
      tags: ['Accounts'],
      summary: 'Update an account',
      request: { params: IdParam, body: jsonBody(CreateAccountBody) },
      responses: { 200: jsonResponse(dataOf(Account), 'Updated'), ...errorResponses },
    }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await updateAccount(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/accounts/{id}/notes',
      operationId: 'createAccountNote',
      tags: ['Notes'],
      summary: 'Create a CRM note on an account',
      request: { params: IdParam, body: jsonBody(CreateNoteBody) },
      responses: { 201: jsonResponse(dataOf(Note), 'Created'), ...errorResponses },
    }),
    { scope: 'notes:write', rateClass: 'noteWrite' },
    async (c) => {
      const body = c.req.valid('json').data;
      const note = await createNote(c.get('ctx'), { associatedType: 'account', associatedId: c.req.valid('param').id, ...body });
      return c.json({ data: note }, 201);
    },
  );
}
