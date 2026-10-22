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
  getProspectResearch,
  requestResearch,
  syncHubspotContacts,
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
      const note = await createNote(c.get('ctx'), { associatedType: 'prospect', associatedId: c.req.valid('param').id, ...body }, reg.crmDeps);
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
      const { type, records } = c.req.valid('json').data;
      if (type === 'hubspot') return c.json(await syncHubspotContacts(c.get('ctx'), records, reg.crmDeps), 200);
      throw noCrmConnection(type);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/prospects/{id}/actions/research',
      operationId: 'researchProspect',
      tags: ['Prospects'],
      summary: 'Queue a web-grounded research brief for this prospect and their company',
      request: { params: IdParam, body: { content: { 'application/json': { schema: z.object({ data: z.object({ focus: z.string().max(500).optional(), force: z.boolean().optional() }).optional() }) } }, required: false, description: 'Optional focus' } },
      responses: { 202: jsonResponse(z.object({ queued: z.boolean(), prospectId: z.string() }), 'Queued'), ...errorResponses },
    }),
    { scope: 'agents:run', rateClass: 'default', extension: true },
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { data?: { focus?: string; force?: boolean } };
      return c.json(await requestResearch(c.get('ctx'), c.req.valid('param').id, body.data ?? {}), 202);
    },
  );
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/prospects/{id}/research',
      operationId: 'getProspectResearch',
      tags: ['Prospects'],
      summary: 'Latest research brief with signals and source citations',
      request: { params: IdParam },
      responses: { 200: jsonResponse(dataOf(z.record(z.string(), z.unknown())), 'Brief or {status:"none"}'), ...errorResponses },
    }),
    { scope: 'prospects:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await getProspectResearch(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
}
