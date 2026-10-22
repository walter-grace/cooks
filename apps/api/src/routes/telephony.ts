/**
 * Dialer routes. `/v1/*` routes are authenticated; `/telephony/*` are Twilio webhooks
 * validated with the workspace's auth token (X-Twilio-Signature).
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { eq } from 'drizzle-orm';
import {
  Call,
  CallDisposition,
  IdParam,
  bridgeTwiml,
  callInsights,
  connectTelephony,
  createDisposition,
  createManualCall,
  dataOf,
  disconnectTelephony,
  ensureDispositions,
  errorResponses,
  getTelephony,
  handleRecording,
  handleStatus,
  hangupTwiml,
  jsonBody,
  jsonResponse,
  logCall,
  recordingResponse,
  requestCoaching,
  serializeDisposition,
  serializeTelephony,
  softphoneToken,
  softphoneTwiml,
  startCall,
  systemPrincipal,
  telephonyFor,
  updateTelephonySettings,
  validateTwilioSignature,
  type Clock,
  type Ctx,
  type DialerDeps,
  type JobsPort,
} from '@cooks/core';
import { workspaces, type Db } from '@cooks/db';
import { register, type Registrar } from '../register.js';
import type { AppEnv } from '../types.js';

const Telephony = z
  .object({
    provider: z.string().nullable(),
    status: z.enum(['connected', 'disconnected']),
    accountSid: z.string().nullable(),
    accountSidLast4: z.string().optional(),
    fromNumbers: z.array(z.string()),
    softphone: z.boolean(),
    record: z.boolean(),
    transcribe: z.boolean(),
    coach: z.boolean(),
    updatedAt: z.string().nullable(),
  })
  .openapi('TelephonyConnection');
const ConnectBody = z.object({
  data: z.object({
    accountSid: z.string().min(10),
    authToken: z.string().min(10),
    apiKeySid: z.string().optional(),
    apiKeySecret: z.string().optional(),
    twimlAppSid: z.string().optional(),
    fromNumbers: z.array(z.string()).optional(),
    record: z.boolean().optional(),
    transcribe: z.boolean().optional(),
    coach: z.boolean().optional(),
  }),
});
const Disposition = z.object({ callDisposition: z.object({ id: z.string() }).optional(), outcome: z.string().optional(), dispositionName: z.string().optional(), notes: z.string().max(10_000).optional() });
const Outcome = z.enum(['connected', 'not_connected', 'meeting_booked', 'left_voicemail', 'no_answer', 'busy', 'wrong_number', 'do_not_call', 'other']);

export function mountTelephony(reg: Registrar, d: DialerDeps) {
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/telephony', operationId: 'getTelephony', tags: ['Dialer'], summary: 'Twilio connection status', responses: { 200: jsonResponse(dataOf(Telephony), 'Connection'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: serializeTelephony(await getTelephony(c.get('ctx'))) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'put', path: '/v1/workspace/telephony', operationId: 'connectTelephony', tags: ['Dialer'], summary: 'Connect Twilio (admins)', description: 'Account SID + Auth Token enable bridge calling. Add an API key pair and a TwiML App SID (voice URL `/telephony/voice?ws=<workspaceId>`) for browser calling.', request: { body: jsonBody(ConnectBody) }, responses: { 200: jsonResponse(dataOf(Telephony), 'Connected'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await connectTelephony(c.get('ctx'), c.req.valid('json').data, d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'patch', path: '/v1/workspace/telephony', operationId: 'updateTelephony', tags: ['Dialer'], summary: 'Change caller ids, recording, transcription or coaching', request: { body: jsonBody(z.object({ data: z.object({ fromNumbers: z.array(z.string()).optional(), record: z.boolean().optional(), transcribe: z.boolean().optional(), coach: z.boolean().optional() }) })) }, responses: { 200: jsonResponse(dataOf(Telephony), 'Updated'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await updateTelephonySettings(c.get('ctx'), c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/workspace/telephony', operationId: 'disconnectTelephony', tags: ['Dialer'], summary: 'Disconnect Twilio', responses: { 204: { description: 'Disconnected' }, ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => {
      await disconnectTelephony(c.get('ctx'));
      return c.body(null, 204);
    },
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/telephony/token', operationId: 'createSoftphoneToken', tags: ['Dialer'], summary: 'Voice SDK access token for the browser softphone', request: { body: { content: { 'application/json': { schema: z.object({ data: z.object({ ttlSeconds: z.number().int().min(60).max(86_400).optional() }).optional() }) } }, required: false, description: 'Optional ttl' } }, responses: { 200: jsonResponse(dataOf(z.object({ token: z.string(), identity: z.string(), expiresIn: z.number(), fromNumbers: z.array(z.string()), voiceUrl: z.string() })), 'Token'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'default', extension: true },
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { data?: { ttlSeconds?: number } };
      return c.json({ data: await softphoneToken(c.get('ctx'), d, body.data ?? {}) }, 200);
    },
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/calls/actions/dial',
      operationId: 'dialCall',
      tags: ['Calls', 'Dialer'],
      summary: 'Start a call to a prospect or number',
      description: 'Bridge mode rings the rep first (repPhone or profile phone), then the prospect. Softphone mode returns connectParams for the Twilio Voice SDK in the browser.',
      request: { body: jsonBody(z.object({ data: z.object({ prospectId: z.string().optional(), to: z.string().optional(), mode: z.enum(['bridge', 'softphone']).optional(), repPhone: z.string().optional(), fromNumber: z.string().optional(), ownerId: z.string().optional(), taskId: z.string().optional() }) })) },
      responses: { 201: jsonResponse(dataOf(z.object({ call: Call, mode: z.string(), connectParams: z.record(z.string(), z.string()).optional(), repPhone: z.string().nullable().optional() })), 'Call started'), ...errorResponses },
    }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await startCall(c.get('ctx'), c.req.valid('json').data, d) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/calls',
      operationId: 'createCall',
      tags: ['Calls'],
      summary: 'Log a call that happened outside the dialer',
      request: { body: jsonBody(z.object({ data: z.object({ prospectId: z.string(), ownerId: z.string().optional(), direction: z.enum(['inbound', 'outbound']).optional(), durationSeconds: z.number().int().min(0).optional(), time: z.string().optional(), to: z.string().optional(), from: z.string().optional(), taskId: z.string().optional(), ...Disposition.shape, outcome: Outcome.optional() }) })) },
      responses: { 201: jsonResponse(dataOf(Call), 'Logged'), ...errorResponses },
    }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await createManualCall(c.get('ctx'), c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/calls/{id}/actions/log', operationId: 'logCall', tags: ['Calls'], summary: 'Log the disposition and notes for a call (fires call.logged)', request: { params: IdParam, body: jsonBody(z.object({ data: Disposition.extend({ outcome: Outcome.optional(), durationSeconds: z.number().int().min(0).optional() }) })) }, responses: { 200: jsonResponse(dataOf(Call), 'Logged'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await logCall(c.get('ctx'), c.req.valid('param').id, c.req.valid('json').data) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/calls/{id}/insights', operationId: 'getCallInsights', tags: ['Calls', 'Coaching'], summary: 'Transcript, talk stats and AI coaching for a call', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(z.record(z.string(), z.unknown())), 'Insights'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await callInsights(c.get('ctx'), c.req.valid('param').id) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/calls/{id}/actions/coach', operationId: 'coachCall', tags: ['Calls', 'Coaching'], summary: 'Run (or re-run) transcription and coaching for a recorded call', request: { params: IdParam }, responses: { 202: jsonResponse(z.object({ queued: z.boolean(), callId: z.string() }), 'Queued'), ...errorResponses } }),
    { scope: 'agents:run', rateClass: 'default', extension: true },
    async (c) => c.json(await requestCoaching(c.get('ctx'), c.req.valid('param').id), 202),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/calls/{id}/recording', operationId: 'getCallRecording', tags: ['Calls'], summary: 'Stream the call recording (audio/mpeg)', request: { params: IdParam }, responses: { 200: { description: 'Audio' }, ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => recordingResponse(c.get('ctx'), c.req.valid('param').id, d) as never,
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/callDispositions', operationId: 'createCallDisposition', tags: ['Call Dispositions'], summary: 'Add a disposition (the default set is created on first use)', request: { body: jsonBody(z.object({ data: z.object({ name: z.string().min(1).max(80), callOutcome: Outcome, order: z.number().int().optional() }) })) }, responses: { 201: jsonResponse(dataOf(CallDisposition), 'Created'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => {
      await ensureDispositions(c.get('ctx'));
      return c.json({ data: serializeDisposition(await createDisposition(c.get('ctx'), c.req.valid('json').data)) }, 201);
    },
  );
}

/** Twilio webhooks. Each carries `?ws=<workspaceId>&call=<callId>`; the body is form-encoded. */
export function mountTelephonyWebhooks(app: OpenAPIHono<AppEnv>, deps: { db: Db; jobs: JobsPort; clock: Clock; publicUrl: string; dialer: DialerDeps; trustSignature?: boolean }) {
  const ctxFor = (ws: string): Ctx => ({ db: deps.db, principal: systemPrincipal(ws), jobs: deps.jobs, clock: deps.clock, traceId: 'twilio', publicUrl: deps.publicUrl });
  const parse = async (c: { req: { parseBody(): Promise<Record<string, unknown>>; header(n: string): string | undefined; url: string; query(n: string): string | undefined } }) => {
    const ws = c.req.query('ws') ?? '';
    const [w] = ws && /^[0-9a-f-]{36}$/i.test(ws) ? await deps.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws)).limit(1) : [];
    if (!w) return null;
    const raw = await c.req.parseBody();
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') params[k] = v;
    const ctx = ctxFor(ws);
    if (!deps.trustSignature) {
      const tel = await telephonyFor(ctx, deps.dialer);
      if (!tel) return null;
      // Rebuild the public URL Twilio signed (proxies may rewrite host/scheme).
      const u = new URL(c.req.url);
      const pub = new URL(deps.publicUrl);
      u.protocol = pub.protocol;
      u.host = pub.host;
      if (!validateTwilioSignature(tel.authToken, u.toString(), params, c.req.header('x-twilio-signature'))) return null;
    }
    return { ctx, params, callId: c.req.query('call') ?? '' };
  };
  const xml = (c: { body: (b: string, s: number, h: Record<string, string>) => Response }, s: string, status = 200) => c.body(s, status, { 'content-type': 'text/xml; charset=utf-8' });

  app.post('/telephony/voice', async (c) => {
    const r = await parse(c);
    if (!r) return xml(c, hangupTwiml('Unauthorized.'), 403);
    return xml(c, await softphoneTwiml(r.ctx, r.params, deps.dialer));
  });
  app.post('/telephony/voice/bridge', async (c) => {
    const r = await parse(c);
    if (!r) return xml(c, hangupTwiml('Unauthorized.'), 403);
    return xml(c, await bridgeTwiml(r.ctx, r.callId, r.params, deps.dialer).catch(() => hangupTwiml('This call is no longer available.')));
  });
  app.post('/telephony/status', async (c) => {
    const r = await parse(c);
    if (!r) return c.text('forbidden', 403);
    const leg = c.req.query('leg') === 'rep' ? 'rep' : 'prospect';
    await handleStatus(r.ctx, r.callId, leg, r.params).catch(() => undefined);
    return c.body(null, 204);
  });
  app.post('/telephony/recording', async (c) => {
    const r = await parse(c);
    if (!r) return c.text('forbidden', 403);
    await handleRecording(r.ctx, r.callId, r.params, deps.dialer).catch(() => undefined);
    return c.body(null, 204);
  });
}
