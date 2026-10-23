/**
 * Dialer routes. `/v1/*` routes are authenticated; `/telephony/*` are Twilio webhooks
 * validated with the workspace's auth token (X-Twilio-Signature).
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { UpgradeWebSocket } from 'hono/ws';
import { eq } from 'drizzle-orm';
import {
  Call,
  CallDisposition,
  IdParam,
  bridgeTwiml,
  buySpekoNumber,
  callInsights,
  callTranscript,
  connectSpeko,
  connectTelephony,
  dialerBalance,
  dialerOverview,
  disconnectSpeko,
  handleSpekoWebhook,
  hangupAiCall,
  placeAiCall,
  searchSpekoNumbers,
  setDialerProvider,
  spekoFor,
  spekoNumbers,
  updateSpekoSettings,
  verifyStandardWebhook,
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
  parallelAmd,
  parallelConferenceEvent,
  parallelProspectStatus,
  parallelProspectVoice,
  parallelRepStatus,
  parallelRepVoice,
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
  createGateSocket,
  speechProviderFrom,
} from '@cooks/core';

/** Concurrent Media Streams sockets this process accepts (one per answered leg). */
const GATE_MAX_SOCKETS = 64;
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
  /* ---------- Speko: AI-voiced calls ---------- */
  const SpekoSettingsBody = z.object({
    fromNumber: z.string().nullable().optional(),
    fromNumbers: z.array(z.string()).optional(),
    systemPrompt: z.string().max(8000).optional(),
    firstMessage: z.string().max(1000).optional(),
    maxDurationSeconds: z.number().int().min(30).max(14_400).optional().describe('Capped server-side at 600'),
    dailySpendCapUsd: z.number().min(0).max(10_000).optional(),
    language: z.string().max(16).optional(),
    voice: z.string().max(120).nullable().optional(),
    agentId: z.string().max(120).nullable().optional(),
    onMachine: z.enum(['hangup', 'leave_message', 'agent_decides']).optional(),
    voicemailMessage: z.string().max(1000).nullable().optional(),
    webhookSecret: z.string().max(512).nullable().optional().describe('Standard Webhooks signing secret for /telephony/speko/webhook'),
    coach: z.boolean().optional(),
  });
  const Speko = z.record(z.string(), z.unknown()).openapi('SpekoConnection');
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/dialer', operationId: 'getDialer', tags: ['Dialer'], summary: 'Both dialer connections and which one the Call button uses', responses: { 200: jsonResponse(dataOf(z.object({ provider: z.string().nullable(), twilio: Telephony, speko: Speko })), 'Dialer'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await dialerOverview(c.get('ctx'), d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'put', path: '/v1/workspace/dialer/provider', operationId: 'setDialerProvider', tags: ['Dialer'], summary: 'Choose the dialer (admins): twilio for rep calls, speko for AI calls', request: { body: jsonBody(z.object({ data: z.object({ provider: z.enum(['twilio', 'speko']) }) })) }, responses: { 200: jsonResponse(dataOf(z.object({ provider: z.string() })), 'Chosen'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: { provider: await setDialerProvider(c.get('ctx'), c.req.valid('json').data.provider) } }, 200),
  );
  register(
    reg,
    createRoute({ method: 'put', path: '/v1/workspace/telephony/speko', operationId: 'connectSpeko', tags: ['Dialer'], summary: 'Connect Speko for AI-voiced calls (admins)', description: 'Paste a Speko API key (sk_live_…), or omit it to use the server\'s SPEKO_API_KEY. The key is verified, encrypted with COOKS_KEK and never returned.', request: { body: jsonBody(z.object({ data: SpekoSettingsBody.extend({ apiKey: z.string().min(8).optional() }) })) }, responses: { 200: jsonResponse(dataOf(Speko), 'Connected'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await connectSpeko(c.get('ctx'), c.req.valid('json').data, d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'patch', path: '/v1/workspace/telephony/speko', operationId: 'updateSpeko', tags: ['Dialer'], summary: 'Change the AI call script, caller id, duration or daily spend cap', request: { body: jsonBody(z.object({ data: SpekoSettingsBody })) }, responses: { 200: jsonResponse(dataOf(Speko), 'Updated'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await updateSpekoSettings(c.get('ctx'), c.req.valid('json').data, d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'delete', path: '/v1/workspace/telephony/speko', operationId: 'disconnectSpeko', tags: ['Dialer'], summary: 'Disconnect Speko', responses: { 204: { description: 'Disconnected' }, ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => {
      await disconnectSpeko(c.get('ctx'));
      return c.body(null, 204);
    },
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/telephony/speko/balance', operationId: 'getDialerBalance', tags: ['Dialer'], summary: 'Speko credit balance, today\'s AI call spend and the daily cap', responses: { 200: jsonResponse(dataOf(z.record(z.string(), z.unknown())), 'Balance'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await dialerBalance(c.get('ctx'), d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/telephony/speko/numbers', operationId: 'listSpekoNumbers', tags: ['Dialer'], summary: 'Phone numbers owned on Speko', responses: { 200: jsonResponse(z.object({ data: z.array(z.record(z.string(), z.unknown())) }), 'Numbers'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await spekoNumbers(c.get('ctx'), d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/workspace/telephony/speko/numbers/available', operationId: 'searchSpekoNumbers', tags: ['Dialer'], summary: 'Search numbers available to buy on Speko (shows setup and monthly price)', request: { query: z.object({ country: z.string().optional(), areaCode: z.string().optional(), numberType: z.string().optional(), locality: z.string().optional(), state: z.string().optional(), limit: z.coerce.number().int().min(1).max(50).optional() }) }, responses: { 200: jsonResponse(z.object({ data: z.array(z.record(z.string(), z.unknown())) }), 'Available'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await searchSpekoNumbers(c.get('ctx'), d, c.req.valid('query')) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/workspace/telephony/speko/numbers', operationId: 'buySpekoNumber', tags: ['Dialer'], summary: 'Buy a Speko number (PAID; admins; requires confirm: true)', request: { body: jsonBody(z.object({ data: z.object({ e164: z.string(), confirm: z.boolean().optional(), label: z.string().max(80).optional(), expectedUpfrontCostUsd: z.number().min(0).optional(), expectedMonthlyCostUsd: z.number().min(0).optional(), makeDefault: z.boolean().optional() }) })) }, responses: { 201: jsonResponse(dataOf(z.record(z.string(), z.unknown())), 'Bought'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await buySpekoNumber(c.get('ctx'), d, c.req.valid('json').data) }, 201),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/calls/actions/aiCall',
      operationId: 'placeAiCall',
      tags: ['Calls', 'Dialer'],
      summary: 'Place an AI-voiced call through Speko',
      description: 'A 2xx means the call is queued, not answered. The worker polls Speko until the call ends, then stores outcome (answered, voicemail, no_answer, failed), transcript, summary, cost and recording, logs a disposition (closing the linked task) and queues coaching. Refused with 422 and a code when the prospect is on the do-not-call list (DO_NOT_CALL), outside 08:00–21:00 local time (QUIET_HOURS), over the daily spend cap (SPEND_CAP), or when Speko rejects it (e.g. INSUFFICIENT_CREDITS).',
      request: { body: jsonBody(z.object({ data: z.object({ prospectId: z.string().optional(), to: z.string().optional(), taskId: z.string().optional(), ownerId: z.string().optional(), systemPrompt: z.string().max(8000).optional(), firstMessage: z.string().max(1000).optional(), maxDurationSeconds: z.number().int().min(30).max(14_400).optional(), fromNumber: z.string().optional(), language: z.string().max(16).optional(), voice: z.string().max(120).optional(), agentId: z.string().max(120).optional(), onMachine: z.enum(['hangup', 'leave_message', 'agent_decides']).optional(), voicemailMessage: z.string().max(1000).optional() }) })) },
      responses: { 202: jsonResponse(dataOf(z.object({ call: Call, status: z.literal('queued'), maxDurationSeconds: z.number(), timezone: z.string(), estimatedUsd: z.number() })), 'Queued'), ...errorResponses },
    }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await placeAiCall(c.get('ctx'), c.req.valid('json').data, d) }, 202),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/calls/{id}/actions/hangup', operationId: 'hangupCall', tags: ['Calls', 'Dialer'], summary: 'End a running AI call', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(z.object({ callId: z.string(), status: z.string(), ended: z.boolean() })), 'Ending'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await hangupAiCall(c.get('ctx'), c.req.valid('param').id, d) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/calls/{id}/transcript', operationId: 'getCallTranscript', tags: ['Calls', 'Coaching'], summary: 'Transcript, outcome, summary and cost for a call', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(z.record(z.string(), z.unknown())), 'Transcript'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: await callTranscript(c.get('ctx'), c.req.valid('param').id) }, 200),
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
export function mountTelephonyWebhooks(app: OpenAPIHono<AppEnv>, deps: { db: Db; jobs: JobsPort; clock: Clock; publicUrl: string; dialer: DialerDeps; trustSignature?: boolean; upgradeWebSocket?: UpgradeWebSocket; fetchImpl?: typeof fetch }) {
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
  /* ---------- parallel dialer (all signed; idempotent through dial_events) ---------- */
  const sess = (c: { req: { query(n: string): string | undefined } }) => ({ session: c.req.query('session') ?? '', line: c.req.query('line') ?? '' });
  app.post('/telephony/parallel/rep/voice', async (c) => {
    const r = await parse(c);
    if (!r) return xml(c, hangupTwiml('Unauthorized.'), 403);
    return xml(c, await parallelRepVoice(r.ctx, sess(c).session, r.params, deps.dialer).catch(() => hangupTwiml('This dial session is no longer available.')));
  });
  app.post('/telephony/parallel/rep/status', async (c) => {
    const r = await parse(c);
    if (!r) return c.text('forbidden', 403);
    await parallelRepStatus(r.ctx, sess(c).session, r.params, deps.dialer).catch(() => undefined);
    return c.body(null, 204);
  });
  app.post('/telephony/parallel/conference', async (c) => {
    const r = await parse(c);
    if (!r) return c.text('forbidden', 403);
    await parallelConferenceEvent(r.ctx, sess(c).session, r.params, deps.dialer).catch(() => undefined);
    return c.body(null, 204);
  });
  app.post('/telephony/parallel/prospect/voice', async (c) => {
    const r = await parse(c);
    if (!r) return xml(c, hangupTwiml(), 403);
    const { session, line } = sess(c);
    return xml(c, await parallelProspectVoice(r.ctx, session, line, r.params, deps.dialer).catch(() => hangupTwiml()));
  });
  // Speech gate: Twilio forks each answered prospect leg's audio here (<Start><Stream>). The socket
  // authenticates through the signed token in the stream's custom parameters, not the HTTP upgrade.
  if (deps.upgradeWebSocket) {
    const provider = speechProviderFrom(deps.dialer.speech);
    let open = 0;
    app.get(
      '/telephony/parallel/stream',
      deps.upgradeWebSocket(() => {
        let sock: ReturnType<typeof createGateSocket> | null = null;
        return {
          onOpen(_evt, ws) {
            if (open >= GATE_MAX_SOCKETS) return ws.close(1013, 'busy');
            open += 1;
            sock = createGateSocket({ db: deps.db, jobs: deps.jobs, clock: deps.clock, publicUrl: deps.publicUrl, dialer: deps.dialer, provider, fetchImpl: deps.fetchImpl, close: () => ws.close(), log: (m) => console.log(`[speech] ${m}`) });
          },
          onMessage(evt) {
            void sock?.message(evt.data as string | ArrayBuffer);
          },
          onClose() {
            open = Math.max(0, open - 1);
            sock?.close();
            sock = null;
          },
          onError() {
            sock?.close();
          },
        };
      }),
    );
  }
  app.post('/telephony/parallel/prospect/amd', async (c) => {
    const r = await parse(c);
    if (!r) return c.text('forbidden', 403);
    const { session, line } = sess(c);
    await parallelAmd(r.ctx, session, line, r.params, deps.dialer).catch(() => undefined);
    return c.body(null, 204);
  });
  app.post('/telephony/parallel/prospect/status', async (c) => {
    const r = await parse(c);
    if (!r) return c.text('forbidden', 403);
    const { session, line } = sess(c);
    await parallelProspectStatus(r.ctx, session, line, r.params, deps.dialer).catch(() => undefined);
    return c.body(null, 204);
  });
  /** Speko `call.*` events (Standard Webhooks signature when the workspace stored a secret). Only ever triggers a poll. */
  app.post('/telephony/speko/webhook', async (c) => {
    const ws = c.req.query('ws') ?? '';
    const [w] = ws && /^[0-9a-f-]{36}$/i.test(ws) ? await deps.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, ws)).limit(1) : [];
    if (!w) return c.text('forbidden', 403);
    const ctx = ctxFor(ws);
    const sp = await spekoFor(ctx, deps.dialer);
    if (!sp) return c.text('forbidden', 403);
    const raw = await c.req.text();
    if (sp.webhookSecret && !deps.trustSignature) {
      const ok = verifyStandardWebhook(sp.webhookSecret, { id: c.req.header('webhook-id'), timestamp: c.req.header('webhook-timestamp'), signature: c.req.header('webhook-signature') }, raw, deps.clock.now());
      if (!ok) return c.text('forbidden', 403);
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return c.text('bad request', 400);
    }
    const r = await handleSpekoWebhook(ctx, body).catch(() => ({ ignored: 'error' }));
    return c.json(r, 200);
  });
}
