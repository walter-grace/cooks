/**
 * Parallel dialer routes (`/v1/dialSessions`, compliance settings). Webhooks the carrier calls
 * live next to the other Twilio webhooks in telephony.ts so they share signature validation.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
  IdParam,
  abandonmentStats,
  currentDialSession,
  dataOf,
  dialNextBatch,
  endDialSession,
  errorResponses,
  getDialSession,
  getParallelSettings,
  hangupConnectedLine,
  jsonBody,
  jsonResponse,
  listDialSessions,
  queueDialLines,
  setParallelSettings,
  startDialSession,
  updateDialSession,
  type DialerDeps,
} from '@cooks/core';
import { register, type Registrar } from '../register.js';

const Line = z
  .object({
    id: z.string(),
    batch: z.number(),
    status: z.string(),
    to: z.string().nullable(),
    prospect: z.object({ id: z.string(), name: z.string().nullable(), title: z.string().nullable(), phone: z.string().nullable(), account: z.string().nullable() }).nullable(),
    callId: z.string().nullable(),
    taskId: z.string().nullable(),
    callbackTaskId: z.string().nullable(),
    answeredBy: z.string().nullable(),
    skipReason: z.string().nullable(),
    endReason: z.string().nullable(),
    answeredAt: z.string().nullable(),
    connectedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    durationSeconds: z.number().nullable(),
    createdAt: z.string(),
  })
  .openapi('DialLine');
const Session = z
  .object({
    id: z.string(),
    status: z.string().describe('waiting_rep | ready | dialing | connected | wrapping | ended'),
    repMode: z.string(),
    repPhone: z.string().nullable(),
    fromNumber: z.string(),
    conferenceName: z.string(),
    maxLines: z.number(),
    batch: z.number(),
    complianceMode: z.string(),
    autoDial: z.boolean(),
    owner: z.object({ id: z.string() }).nullable(),
    repJoinedAt: z.string().nullable(),
    connectedLineId: z.string().nullable(),
    connectedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
    endReason: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
    stats: z.record(z.string(), z.number()),
    lines: z.array(Line),
    connectParams: z.record(z.string(), z.string()).optional().describe('Browser mode: pass to device.connect({ params })'),
  })
  .openapi('DialSession');
const Compliance = z
  .object({
    complianceMode: z.enum(['b2b', 'consumer']),
    confirmed: z.boolean(),
    confirmedBy: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    maxLines: z.number(),
    maxAllowedLines: z.number(),
    abandonedCallMessage: z.string().nullable(),
    onUnknown: z.enum(['hangup', 'connect']),
    ringTimeoutSeconds: z.number(),
    amd: z.object({ speechThresholdMs: z.number().optional(), speechEndThresholdMs: z.number().optional(), silenceTimeoutMs: z.number().optional(), timeoutSeconds: z.number().optional() }),
    abandonment: z.object({ windowDays: z.number(), humansAnswered: z.number(), dropped: z.number(), ratePct: z.number().nullable(), safeHarborMaxPct: z.number() }).optional(),
  })
  .openapi('ParallelDialerSettings');
const Targets = { prospectIds: z.array(z.string()).max(200).optional(), taskIds: z.array(z.string()).max(200).optional() };

export function mountParallelDialer(reg: Registrar, d: DialerDeps) {
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/dialer/compliance', operationId: 'getParallelDialerSettings', tags: ['Dialer'], summary: 'Parallel dialer compliance mode, limits, AMD tuning and the 30-day abandonment rate', responses: { 200: jsonResponse(dataOf(Compliance), 'Settings'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: { ...(await getParallelSettings(c.get('ctx'))), abandonment: await abandonmentStats(c.get('ctx'), 30) } }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'put',
      path: '/v1/workspace/dialer/compliance',
      operationId: 'setParallelDialerSettings',
      tags: ['Dialer'],
      summary: 'Choose and confirm B2B or consumer mode (admins); set lines, AMD tuning, abandoned-call message',
      description: 'Dropping a second live answer is an abandoned call under the FTC Telemarketing Sales Rule (16 CFR 310.4(b)(1)(iv)) when the callee is a consumer. An admin must pick a mode and send confirm: true before any session can start. Changing the mode clears the confirmation. Consumer mode caps lines at 2, needs an abandoned-call message (seller name and number, played to dropped humans), and falls back to one line while the 30-day abandonment rate is at or above 3%.',
      request: { body: jsonBody(z.object({ data: z.object({ complianceMode: z.enum(['b2b', 'consumer']).optional(), confirm: z.boolean().optional(), maxLines: z.number().int().min(1).max(6).optional(), abandonedCallMessage: z.string().max(500).nullable().optional(), onUnknown: z.enum(['hangup', 'connect']).optional(), ringTimeoutSeconds: z.number().int().min(15).max(60).optional(), amd: z.object({ speechThresholdMs: z.number().int().min(1000).max(6000).optional(), speechEndThresholdMs: z.number().int().min(500).max(5000).optional(), silenceTimeoutMs: z.number().int().min(2000).max(10_000).optional(), timeoutSeconds: z.number().int().min(3).max(59).optional() }).optional() }) })) },
      responses: { 200: jsonResponse(dataOf(Compliance), 'Updated'), ...errorResponses },
    }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await setParallelSettings(c.get('ctx'), c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/dialSessions',
      operationId: 'startDialSession',
      tags: ['Dialer'],
      summary: 'Start a parallel dial session (rep joins first, then batches of prospects are dialed)',
      description: 'Browser mode returns connectParams for the Twilio Voice SDK; the rep\'s browser leg joins a silent conference. Phone mode rings repPhone and drops the rep into the same room. Prospects passed here are preflighted (phone, do-not-call, quiet hours) and queued; call POST /v1/dialSessions/{id}/actions/dial to ring a batch. Refused with COMPLIANCE_UNCONFIRMED until an admin confirms the compliance mode.',
      request: { body: jsonBody(z.object({ data: z.object({ repMode: z.enum(['browser', 'phone']).optional(), repPhone: z.string().optional(), fromNumber: z.string().optional(), ownerId: z.string().optional(), maxLines: z.number().int().min(1).max(6).optional(), autoDial: z.boolean().optional(), ...Targets }) })) },
      responses: { 201: jsonResponse(dataOf(Session), 'Session'), ...errorResponses },
    }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await startDialSession(c.get('ctx'), c.req.valid('json').data, d) }, 201),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/dialSessions', operationId: 'listDialSessions', tags: ['Dialer'], summary: 'Recent dial sessions', request: { query: z.object({ open: z.enum(['true', 'false']).optional(), ownerId: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }) }, responses: { 200: jsonResponse(z.object({ data: z.array(Session) }), 'Sessions'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'list', extension: true },
    async (c) => {
      const q = c.req.valid('query');
      return c.json({ data: await listDialSessions(c.get('ctx'), { open: q.open === 'true', ownerId: q.ownerId, limit: q.limit }) }, 200);
    },
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/dialSessions/current', operationId: 'getCurrentDialSession', tags: ['Dialer'], summary: 'The signed-in rep\'s open session, if any', responses: { 200: jsonResponse(z.object({ data: Session.nullable() }), 'Session or null'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await currentDialSession(c.get('ctx')) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/dialSessions/{id}', operationId: 'getDialSession', tags: ['Dialer'], summary: 'Session status with every line (poll this while dialing)', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(Session), 'Session'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await getDialSession(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'patch', path: '/v1/dialSessions/{id}', operationId: 'updateDialSession', tags: ['Dialer'], summary: 'Change auto-dial or lines per batch mid-session', request: { params: IdParam, body: jsonBody(z.object({ data: z.object({ autoDial: z.boolean().optional(), maxLines: z.number().int().min(1).max(6).optional() }) })) }, responses: { 200: jsonResponse(dataOf(Session), 'Session'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await updateDialSession(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/dialSessions/{id}/actions/queue', operationId: 'queueDialLines', tags: ['Dialer'], summary: 'Add prospects or call tasks to the session (preflighted, not dialed yet)', request: { params: IdParam, body: jsonBody(z.object({ data: z.object(Targets) })) }, responses: { 200: jsonResponse(dataOf(Session), 'Session'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await queueDialLines(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/dialSessions/{id}/actions/dial',
      operationId: 'dialNextBatch',
      tags: ['Dialer'],
      summary: 'Ring the next batch of lines at once; the first human answer is bridged to the rep',
      description: 'Needs the rep in the room (status ready or wrapping). Returns 409 LINE_CONNECTED while a conversation is live and BATCH_IN_PROGRESS while a batch is ringing, 422 NO_QUEUED_LINES when nothing is left. Optional prospectIds/taskIds are queued first.',
      request: { params: IdParam, body: { content: { 'application/json': { schema: z.object({ data: z.object({ lines: z.number().int().min(1).max(6).optional(), ...Targets }).optional() }) } }, required: false, description: 'Optional batch size and extra targets' } },
      responses: { 200: jsonResponse(dataOf(Session), 'Session'), ...errorResponses },
    }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { data?: { lines?: number; prospectIds?: string[]; taskIds?: string[] } };
      return c.json({ data: await dialNextBatch(c.get('ctx'), c.req.valid('param').id, body.data ?? {}, d) }, 200);
    },
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/dialSessions/{id}/actions/hangup', operationId: 'hangupDialLine', tags: ['Dialer'], summary: 'End the live conversation; the rep stays in the room', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(z.object({ sessionId: z.string(), lineId: z.string(), hangingUp: z.boolean() })), 'Hanging up'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await hangupConnectedLine(c.get('ctx'), c.req.valid('param').id, d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/dialSessions/{id}/actions/end', operationId: 'endDialSession', tags: ['Dialer'], summary: 'End the session: hang up every line and close the room', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(Session), 'Ended'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await endDialSession(c.get('ctx'), c.req.valid('param').id, d, 'ended_by_rep') }, 200),
  );
}
