/**
 * Practice calls: a rep rehearses against an AI prospect. `/v1/practice/*` are authenticated
 * routes; `/practice/stream` is the microphone WebSocket, authenticated by the signed token the
 * session start returned (sent in the first message, not the upgrade).
 */
import { createRoute, z } from '@hono/zod-openapi';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Clock, JobsPort, PracticeConfig } from '@cooks/core';
import { IdParam, createPracticeSocket, dataOf, endPractice, errorResponses, jsonBody, jsonResponse, listPracticeScenarios, loadPracticeCall, practiceStatus, serializeCall, startPractice, voicePartnerFrom } from '@cooks/core';
import type { CallRow } from '@cooks/core';
import type { Db } from '@cooks/db';
import { register, type Registrar } from '../register.js';
import type { AppEnv } from '../types.js';

export interface PracticeRouteDeps {
  db: Db;
  jobs: JobsPort;
  clock: Clock;
  publicUrl: string;
  kek?: string;
  practice?: PracticeConfig;
}

/** Open practice sockets per process; each one holds a partner session. */
export const PRACTICE_MAX_SOCKETS = 20;

const Loose = z.record(z.string(), z.unknown());
const StartBody = z.object({ data: z.object({ scenarioId: z.string().max(64).optional(), prospectId: z.string().optional() }).default({}) });

export function mountPractice(reg: Registrar, d: PracticeRouteDeps) {
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/practice/status', operationId: 'getPracticeStatus', tags: ['Practice'], summary: 'Is a practice partner configured?', responses: { 200: jsonResponse(dataOf(Loose), 'Status'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: { ...practiceStatus(d.practice), scenarios: listPracticeScenarios().length } }, 200),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/practice/scenarios', operationId: 'listPracticeScenarios', tags: ['Practice'], summary: 'Built-in practice scenarios', responses: { 200: jsonResponse(dataOf(z.array(Loose)), 'Scenarios'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'list', extension: true },
    async (c) => c.json({ data: listPracticeScenarios() }, 200),
  );
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/practice/sessions',
      operationId: 'startPracticeSession',
      tags: ['Practice'],
      summary: 'Start a practice call',
      description: 'Creates a call record with `source: practice` and returns the token the browser presents on `/practice/stream`. Pass `scenarioId` for a built-in scenario or `prospectId` to rehearse a real call.',
      request: { body: jsonBody(StartBody) },
      responses: { 201: jsonResponse(dataOf(Loose), 'Session'), ...errorResponses },
    }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await startPractice(c.get('ctx'), c.req.valid('json').data, { kek: d.kek, practice: d.practice }) }, 201),
  );
  register(
    reg,
    createRoute({ method: 'get', path: '/v1/practice/sessions/{id}', operationId: 'getPracticeSession', tags: ['Practice'], summary: 'A practice call', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(Loose), 'Call'), ...errorResponses } }),
    { scope: 'calls:read', rateClass: 'get', extension: true },
    async (c) => c.json({ data: serializeCall((await loadPracticeCall(c.get('ctx'), c.req.valid('param').id)) as unknown as CallRow) }, 200),
  );
  register(
    reg,
    createRoute({ method: 'post', path: '/v1/practice/sessions/{id}/actions/end', operationId: 'endPracticeSession', tags: ['Practice'], summary: 'End a practice call', description: 'Finalises the transcript and queues coaching. The socket does this itself on stop; call it when the browser went away.', request: { params: IdParam }, responses: { 200: jsonResponse(dataOf(Loose), 'Call'), ...errorResponses } }),
    { scope: 'calls:write', rateClass: 'write', extension: true },
    async (c) => c.json({ data: await endPractice(c.get('ctx'), c.req.valid('param').id, { endReason: 'ended_by_api' }) }, 200),
  );
}

export function mountPracticeSocket(app: OpenAPIHono<AppEnv>, d: PracticeRouteDeps & { upgradeWebSocket?: UpgradeWebSocket }) {
  if (!d.upgradeWebSocket) return;
  const partner = voicePartnerFrom(d.practice);
  const maxSeconds = practiceStatus(d.practice).maxSeconds;
  let open = 0;
  app.get(
    '/practice/stream',
    d.upgradeWebSocket(() => {
      let sock: ReturnType<typeof createPracticeSocket> | null = null;
      return {
        onOpen(_evt, ws) {
          if (open >= PRACTICE_MAX_SOCKETS) return ws.close(1013, 'busy');
          open += 1;
          sock = createPracticeSocket({ db: d.db, jobs: d.jobs, clock: d.clock, publicUrl: d.publicUrl, kek: d.kek, partner, maxSeconds, send: (data) => ws.send(typeof data === 'string' ? data : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)), close: () => ws.close(), log: (m) => console.log(`[practice] ${m}`) });
        },
        onMessage(evt) {
          const data = evt.data as string | ArrayBuffer | Uint8Array | Blob;
          if (data instanceof Blob) void data.arrayBuffer().then((b) => sock?.message(b));
          else void sock?.message(data);
        },
        onClose() {
          open = Math.max(0, open - 1);
          sock?.close();
        },
        onError() {
          sock?.close();
        },
      };
    }),
  );
}
