/**
 * Inkbox channel routes: connection, identities, messages (SMS / iMessage), the unified inbox,
 * the import endpoint, hosted calls, and the public webhook receiver.
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import {
  Call,
  IdParam,
  connectInkbox,
  dataOf,
  disconnectInkbox,
  errorResponses,
  handleInkboxEvent,
  identitySigningKey,
  importInboundMessage,
  inkboxFor,
  inkboxOverview,
  jsonBody,
  jsonResponse,
  listIdentities,
  listInbox,
  listMessages,
  mapIdentityUser,
  messagingStats,
  placeInkboxCall,
  sendMessage,
  subscribeInkboxWebhooks,
  syncInkboxIdentities,
  systemPrincipal,
  verifyInkboxBearer,
  verifyInkboxSignature,
  type ChannelDeps,
  type Clock,
  type Ctx,
  type JobsPort,
} from '@cooks/core';
import { workspaces, type Db } from '@cooks/db';
import { register, type Registrar } from '../register.js';
import type { AppEnv } from '../types.js';

const Any = z.record(z.string(), z.unknown());
const Message = Any.openapi('Message');
const InboxItem = Any.openapi('InboxItem');

export function mountChannels(reg: Registrar, d: ChannelDeps) {
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/channels/inkbox', operationId: 'getInkbox', tags: ['Channels'], summary: 'Inkbox connection and identities', responses: { 200: jsonResponse(dataOf(Any), 'Inkbox'), ...errorResponses } }),
    { scope: 'emails:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: { ...(await inkboxOverview(c.get('ctx'), d)), stats: await messagingStats(c.get('ctx')) } }, 200),
  );
  register(
    reg,
    createRoute({ method: 'put', path: '/v1/workspace/channels/inkbox', operationId: 'connectInkbox', tags: ['Channels'], summary: 'Connect Inkbox (admins): API key, encrypted; identities are pulled', request: { body: jsonBody(z.object({ data: z.object({ apiKey: z.string().min(8), webhookToken: z.string().min(8).max(4096).optional() }) })) }, responses: { 200: jsonResponse(dataOf(Any), 'Connected'), ...errorResponses } }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await connectInkbox(c.get('ctx'), c.req.valid('json').data, d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/workspace/channels/inkbox', operationId: 'disconnectInkbox', tags: ['Channels'], summary: 'Disconnect Inkbox', responses: { 204: { description: 'Disconnected' }, ...errorResponses } }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => {
      await disconnectInkbox(c.get('ctx'));
      return c.body(null, 204);
    },
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/workspace/channels/inkbox/actions/sync', operationId: 'syncInkboxIdentities', tags: ['Channels'], summary: 'Re-pull identities from Inkbox', responses: { 200: jsonResponse(dataOf(Any), 'Synced'), ...errorResponses } }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => {
      await syncInkboxIdentities(c.get('ctx'), d);
      return c.json({ data: await inkboxOverview(c.get('ctx'), d) }, 200);
    },
  );
  register(
    reg,
    createRoute({ method: 'put', path: '/v1/workspace/channels/inkbox/identities/{id}/user', operationId: 'mapInkboxIdentity', tags: ['Channels'], summary: 'Map an identity to the Cooks user it sends as (creates its mailbox)', request: { params: IdParam, body: jsonBody(z.object({ data: z.object({ userId: z.string().nullable() }) })) }, responses: { 200: jsonResponse(dataOf(Any), 'Mapped'), ...errorResponses } }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await mapIdentityUser(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data.userId) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/workspace/channels/inkbox/identities/{id}/actions/subscribe', operationId: 'subscribeInkboxIdentity', tags: ['Channels'], summary: 'Subscribe the identity to Cooks\' webhook (mail, text, iMessage, call, A2A events)', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(Any), 'Subscribed'), ...errorResponses } }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await subscribeInkboxWebhooks(c.get('ctx'), c.req.valid('param').id, d) }, 200),
  );

  /* ---------- messages ---------- */
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/messages', operationId: 'listMessages', tags: ['Messages'], summary: 'SMS, iMessage and agent-to-agent messages', request: { query: z.object({ 'filter[prospect][id]': z.string().optional(), 'filter[channel]': z.enum(['sms', 'imessage', 'a2a']).optional(), 'filter[direction]': z.enum(['inbound', 'outbound']).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), before: z.string().optional() }) }, responses: { 200: jsonResponse(z.object({ data: z.array(Message) }), 'Messages'), ...errorResponses } }),
    { scope: 'emails:read', rateClass: 'list', extension: true },
    async (c) => {
      const q = c.req.valid('query');
      return c.json({ data: await listMessages(c.get('ctx'), { prospectId: q['filter[prospect][id]'], channel: q['filter[channel]'], direction: q['filter[direction]'], limit: q.limit, before: q.before }) }, 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/messages',
      operationId: 'sendMessage',
      tags: ['Messages'],
      summary: 'Send an SMS or iMessage through Inkbox',
      description: 'Runs the consent and contact-rule preflight first: do-not-contact or STOP on file, 08:00–21:00 in the recipient\'s zone, SMS opt-in for US numbers, and outbound contact rules. Blocked sends return 422 with the reason and stay on the prospect as a blocked message.',
      request: { body: jsonBody(z.object({ data: z.object({ channel: z.enum(['sms', 'imessage']), prospectId: z.string().optional(), to: z.string().optional(), text: z.string().min(1).max(1600), mediaUrls: z.array(z.string().url()).max(10).optional(), ownerId: z.string().optional(), identityId: z.string().optional(), taskId: z.string().optional(), send: z.boolean().optional() }) })) },
      responses: { 201: jsonResponse(dataOf(z.object({ message: Message, outcome: Any })), 'Sent'), ...errorResponses },
    }),
    { scope: 'emails:send', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await sendMessage(c.get('ctx'), c.req.valid('json').data, d) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/messages/import',
      operationId: 'importMessage',
      tags: ['Messages'],
      summary: 'Record an inbound email, SMS or iMessage that arrived outside Cooks',
      description: 'The shared inbound entry point: matches the sender to a prospect by email or phone, threads onto the enrollment and runs the reply pipeline (stop or pause the sequence, reply task, reply stats, signals). STOP texts opt the prospect out. Idempotent on providerId.',
      request: { body: jsonBody(z.object({ data: z.object({ channel: z.enum(['email', 'sms', 'imessage']), providerId: z.string().min(1).max(512), from: z.string().min(1), to: z.string().optional(), subject: z.string().max(998).optional(), text: z.string().max(200_000), html: z.string().max(500_000).optional(), mediaUrls: z.array(z.string()).optional(), messageId: z.string().optional(), inReplyTo: z.string().optional(), threadId: z.string().optional(), conversationId: z.string().optional(), receivedAt: z.string().datetime({ offset: true }).optional(), autoSubmitted: z.boolean().optional(), identityId: z.string().optional(), provider: z.string().max(40).optional() }) })) },
      responses: { 201: jsonResponse(dataOf(Any), 'Recorded'), 200: jsonResponse(dataOf(Any), 'Already recorded'), ...errorResponses },
    }),
    { scope: 'emails:write', rateClass: 'write', extension: true },
    async (c) => {
      const b = c.req.valid('json').data;
      const r = await importInboundMessage(c.get('ctx'), { ...b, date: b.receivedAt ? new Date(b.receivedAt) : undefined, provider: b.provider ?? 'import' }, { classify: true });
      const dup = r.outcome.kind === 'duplicate';
      return c.json({ data: r }, dup ? 200 : 201);
    },
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/inbox', operationId: 'listInbox', tags: ['Messages'], summary: 'Unified inbox: email, SMS, iMessage, agent messages and calls, newest first', request: { query: z.object({ 'filter[prospect][id]': z.string().optional(), 'filter[direction]': z.enum(['inbound', 'outbound']).optional(), kinds: z.string().optional().describe('Comma list of email, sms, imessage, a2a, call'), limit: z.coerce.number().int().min(1).max(200).optional(), before: z.string().optional() }) }, responses: { 200: jsonResponse(z.object({ data: z.array(InboxItem), nextBefore: z.string().nullable() }), 'Inbox'), ...errorResponses } }),
    { scope: 'emails:read', rateClass: 'list', extension: true },
    async (c) => {
      const q = c.req.valid('query');
      const r = await listInbox(c.get('ctx'), { prospectId: q['filter[prospect][id]'], direction: q['filter[direction]'], kinds: q.kinds?.split(',').map((k) => k.trim()).filter(Boolean), limit: q.limit, before: q.before });
      return c.json({ data: r.items, nextBefore: r.nextBefore }, 200);
    },
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/prospects/{id}/inbox', operationId: 'getProspectInbox', tags: ['Messages', 'Prospects'], summary: 'One prospect\'s unified inbox', request: { params: IdParam, query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.string().optional() }) }, responses: { 200: jsonResponse(z.object({ data: z.array(InboxItem), nextBefore: z.string().nullable() }), 'Inbox'), ...errorResponses } }),
    { scope: 'emails:read', rateClass: 'list', extension: true },
    async (c) => {
      const r = await listInbox(c.get('ctx'), { prospectId: c.req.valid('param').id, ...c.req.valid('query') });
      return c.json({ data: r.items, nextBefore: r.nextBefore }, 200);
    },
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/calls/actions/inkboxCall', operationId: 'placeInkboxCall', tags: ['Calls', 'Channels'], summary: 'Place a hosted Inkbox call from a task brief (queued; finished by call.ended)', request: { body: jsonBody(z.object({ data: z.object({ prospectId: z.string().optional(), to: z.string().optional(), reason: z.string().min(1).max(2000), onVoicemail: z.enum(['leave_message', 'hang_up', 'ignore']).optional(), voicemailMessage: z.string().max(1000).optional(), identityId: z.string().optional(), ownerId: z.string().optional(), taskId: z.string().optional() }) })) }, responses: { 202: jsonResponse(dataOf(z.object({ call: Call, status: z.literal('queued') })), 'Queued'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await placeInkboxCall(c.get('ctx'), c.req.valid('json').data, d) }, 202),
  );
}

/** Public receiver for Inkbox deliveries: `POST /webhooks/inkbox?ws=<workspace id>`. */
export function mountInkboxWebhook(app: OpenAPIHono<AppEnv>, deps: { db: Db; jobs: JobsPort; clock: Clock; publicUrl: string; channels: ChannelDeps; trustSignature?: boolean; classify?: boolean }) {
  app.post('/webhooks/inkbox', async (c) => {
    const ws = c.req.query('ws') ?? '';
    const [w] = ws && /^[0-9a-f-]{36}$/i.test(ws) ? await deps.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws)).limit(1) : [];
    if (!w) return c.json({ error: 'unknown workspace' }, 403);
    const ctx: Ctx = { db: deps.db, principal: systemPrincipal(ws), jobs: deps.jobs, clock: deps.clock, traceId: 'inkbox', publicUrl: deps.publicUrl };
    const h = await inkboxFor(ctx, deps.channels);
    if (!h) return c.json({ error: 'inkbox not connected' }, 403);
    const raw = await c.req.text();
    // 1. bearer secret on every delivery (subscription auth_token)
    if (!h.webhookToken || !verifyInkboxBearer(h.webhookToken, c.req.header('authorization'))) return c.json({ error: 'bad bearer token' }, 401);
    let body: { id?: string; event_type?: string; timestamp?: string; data?: Record<string, unknown> };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ error: 'bad json' }, 400);
    }
    if (!body?.event_type || typeof body.data !== 'object') return c.json({ error: 'bad envelope' }, 400);
    // 2. identity signature when the identity has a stored signing key
    if (!deps.trustSignature) {
      const ids = await listIdentities(ctx);
      const named = ((body.data as { agent_identities?: Array<{ id?: string }> }).agent_identities ?? []).map((i) => i.id).filter(Boolean) as string[];
      const candidates = ids.filter((i) => i.signingKeyEncrypted && (named.length === 0 || named.includes(i.externalId)));
      if (candidates.length) {
        const hdr = { requestId: c.req.header('x-inkbox-request-id'), timestamp: c.req.header('x-inkbox-timestamp'), signature: c.req.header('x-inkbox-signature') };
        const ok = candidates.some((i) => {
          const key = identitySigningKey(i, deps.channels);
          return !!key && verifyInkboxSignature(key, hdr, raw, deps.clock.now());
        });
        if (!ok) return c.json({ error: 'bad signature' }, 401);
      }
    }
    const r = await handleInkboxEvent(ctx, { id: body.id, event_type: body.event_type, timestamp: body.timestamp, data: body.data as Record<string, unknown> }, deps.channels, { classify: deps.classify ?? true }).catch((e: Error) => ({ error: e.message }));
    return c.json(r, 200);
  });
}
