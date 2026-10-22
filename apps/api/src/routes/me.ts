import { createRoute, z } from '@hono/zod-openapi';
import { Me, dataOf, errorResponses, jsonResponse, getMe } from '@cooks/core';
import { register, type Registrar } from '../register.js';

export function mountMe(reg: Registrar, opts: { publicIps: string[] }) {
  register(
    reg,
    createRoute({
      method: 'get',
      path: '/v1/me',
      operationId: 'getMe',
      tags: ['Introspection'],
      summary: 'Inspect the authenticated principal',
      responses: { 200: jsonResponse(dataOf(Me), 'The caller'), ...errorResponses },
    }),
    { rateClass: 'default' },
    (c) => c.json({ data: getMe(c.get('ctx')) }, 200),
  );

  reg.app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/public-ip-list',
      operationId: 'getPublicIpList',
      tags: ['Introspection'],
      summary: 'Outbound IP addresses used for webhooks and CRM sync',
      security: [],
      responses: { 200: jsonResponse(z.object({ addresses: z.array(z.string()) }), 'IP list') },
    }),
    (c) => c.json({ addresses: opts.publicIps }, 200),
  );
}
