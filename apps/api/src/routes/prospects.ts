import { createRoute, z } from '@hono/zod-openapi';
import {
  CreateNoteBody,
  CreateProspectBody,
  IdParam,
  Note,
  PageParams,
  Prospect,
  SyncProspectsBody,
  SyncProspectsResponse,
  UpdateProspectBody,
  UpdatedAtLte,
  createNote,
  createProspect,
  dataOf,
  errorResponses,
  getProspect,
  jsonBody,
  jsonResponse,
  listOf,
  listProspects,
  noCrmConnection,
  serializeSequenceStateRow,
  updateProspect,
} from '@cooks/core';
import { register, type Registrar } from '../register.js';
import { listArgs } from './_util.js';

export function mountProspects(reg: Registrar) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/prospects',
      operationId: 'listProspects',
      tags: ['Prospects'],
      summary: 'List prospects',
      request: {
        query: z.object({
          ...PageParams,
          'filter[id]': z.string().optional(),
          'filter[name]': z.string().optional(),
          'filter[title]': z.string().optional(),
          'filter[primaryEmail]': z.string().optional(),
          'filter[crmId]': z.string().optional(),
          'filter[sequence][id]': z.string().optional(),
          'filter[account][id]': z.string().optional(),
          ...UpdatedAtLte,
          include: z.string().optional().openapi({ description: 'Comma-separated. Allowed: sequenceStates' }),
          includeCRMCustomFields: z.string().optional(),
        }),
      },
      responses: { 200: jsonResponse(listOf(Prospect), 'Prospects'), ...errorResponses },
    }),
    { scope: 'prospects:read', rateClass: 'list' },
    async (c) => c.json(await listProspects(c.get('ctx'), listArgs(c), serializeSequenceStateRow), 200),
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/prospects/{id}',
      operationId: 'getProspect',
      tags: ['Prospects'],
      summary: 'Get a prospect',
      request: { params: IdParam, query: z.object({ include: z.string().optional(), includeCRMCustomFields: z.string().optional() }) },
      responses: { 200: jsonResponse(dataOf(Prospect), 'Prospect'), ...errorResponses },
    }),
    { scope: 'prospects:read', rateClass: 'get' },
    async (c) => {
      const q = c.req.query();
      return c.json({ data: await getProspect(c.get('ctx'), c.req.valid('param').id, { include: q.include, includeCRMCustomFields: q.includeCRMCustomFields }, serializeSequenceStateRow) }, 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/prospects',
      operationId: 'createProspect',
      tags: ['Prospects'],
      summary: 'Create a prospect',
      request: { body: jsonBody(CreateProspectBody) },
      responses: { 201: jsonResponse(dataOf(Prospect), 'Created'), ...errorResponses },
    }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await createProspect(c.get('ctx'), c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'patch',
      path: '/v1/prospects/{id}',
      operationId: 'updateProspect',
      tags: ['Prospects'],
      summary: 'Update a prospect',
      request: { params: IdParam, body: jsonBody(UpdateProspectBody) },
      responses: { 200: jsonResponse(dataOf(Prospect), 'Updated'), ...errorResponses },
    }),
    { scope: 'prospects:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await updateProspect(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/prospects/{id}/notes',
      operationId: 'createProspectNote',
      tags: ['Notes'],
      summary: 'Create a CRM note on a prospect',
      request: { params: IdParam, body: jsonBody(CreateNoteBody) },
      responses: { 201: jsonResponse(dataOf(Note), 'Created'), ...errorResponses },
    }),
    { scope: 'notes:write', rateClass: 'noteWrite' },
    async (c) => {
      const body = c.req.valid('json').data;
      const note = await createNote(c.get('ctx'), { associatedType: 'prospect', associatedId: c.req.valid('param').id, ...body });
      return c.json({ data: note }, 201);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/integrations/prospects/sync',
      operationId: 'syncProspects',
      tags: ['Prospects'],
      summary: 'Pull prospects from the connected CRM by external id',
      request: { body: jsonBody(SyncProspectsBody) },
      responses: { 200: jsonResponse(SyncProspectsResponse, 'Sync results'), ...errorResponses },
    }),
    { scope: 'prospects:write', rateClass: 'sync' },
    async (c) => {
      // CRM connectors arrive in the CRM phase; until then the documented failure mode applies.
      throw noCrmConnection(c.req.valid('json').data.type);
    },
  );
}
