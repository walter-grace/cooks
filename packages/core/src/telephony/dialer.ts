/**
 * Dialer: start calls (phone bridge or browser softphone), absorb Twilio webhooks, log
 * dispositions, and emit the upstream-compatible `call.logged` event.
 */
import { and, desc, eq, isNull } from 'drizzle-orm';
import { accounts, callDispositions, callTranscripts, calls, coachingScores, prospects, sequenceSteps, sequences, tasks, users } from '@cooks/db';
import type { Ctx } from '../context.js';
import { emitEvent } from '../events.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { fullName } from '../services/prospects.js';
import { completeTask } from '../services/tasks.js';
import { serializeCall, type CallRow } from '../services/calls.js';
import { isUuid, isoReq, memberIds, requireMember, uuidOr404 } from '../services/_shared.js';
import { requireTelephony, telephonyFor, type TelephonyDeps } from './connection.js';
import { dialTwiml, hangupTwiml, normalizePhone, voiceAccessToken } from './twilio.js';

export interface DialerDeps extends TelephonyDeps {
  publicUrl: string;
}

export const DEFAULT_DISPOSITIONS: Array<{ name: string; callOutcome: typeof callDispositions.$inferInsert['callOutcome']; order: number }> = [
  { name: 'Connected', callOutcome: 'connected', order: 1 },
  { name: 'Meeting booked', callOutcome: 'meeting_booked', order: 2 },
  { name: 'Left voicemail', callOutcome: 'left_voicemail', order: 3 },
  { name: 'No answer', callOutcome: 'no_answer', order: 4 },
  { name: 'Busy', callOutcome: 'busy', order: 5 },
  { name: 'Wrong number', callOutcome: 'wrong_number', order: 6 },
  { name: 'Not interested', callOutcome: 'other', order: 7 },
  { name: 'Call back later', callOutcome: 'other', order: 8 },
  { name: 'Do not call', callOutcome: 'do_not_call', order: 9 },
];

/** Seed the default disposition list once per workspace. */
export async function ensureDispositions(ctx: Ctx) {
  const ws = ctx.principal.workspaceId;
  const existing = await ctx.db.select().from(callDispositions).where(and(eq(callDispositions.workspaceId, ws), isNull(callDispositions.deletedAt)));
  if (existing.length) return existing;
  return ctx.db.insert(callDispositions).values(DEFAULT_DISPOSITIONS.map((d) => ({ ...d, workspaceId: ws }))).returning();
}

export async function createDisposition(ctx: Ctx, input: { name: string; callOutcome: typeof callDispositions.$inferInsert['callOutcome']; order?: number }) {
  const [row] = await ctx.db.insert(callDispositions).values({ workspaceId: ctx.principal.workspaceId, name: input.name, callOutcome: input.callOutcome, order: input.order ?? null }).returning();
  return row!;
}

async function dispositionFor(ctx: Ctx, by: { dispositionId?: string | null; outcome?: string | null; name?: string | null }) {
  const list = await ensureDispositions(ctx);
  if (by.dispositionId) {
    const d = list.find((x) => x.id === by.dispositionId);
    if (!d) throw unprocessable('callDisposition.id not found in this workspace', { field: 'callDisposition.id' });
    return d;
  }
  if (by.name) {
    const d = list.find((x) => x.name.toLowerCase() === by.name!.toLowerCase());
    if (d) return d;
  }
  if (by.outcome) {
    const d = list.find((x) => x.callOutcome === by.outcome);
    if (d) return d;
    throw unprocessable(`No disposition with outcome ${by.outcome}`, { field: 'outcome' });
  }
  return null;
}

/** Owner for a call: explicit, the task's, the caller, the prospect's owner, else the first workspace member (API keys). */
async function resolveOwner(ctx: Ctx, candidates: Array<string | null | undefined>) {
  for (const c of candidates) if (c) return requireMember(ctx, c, 'ownerId');
  const [first] = await memberIds(ctx);
  if (!first) throw unprocessable('ownerId is required');
  return first;
}

/* ---------- starting calls ---------- */

export interface DialInput {
  prospectId?: string;
  to?: string;
  mode?: 'bridge' | 'softphone';
  /** Bridge mode rings this number first; defaults to the user's profile phone. */
  repPhone?: string;
  fromNumber?: string;
  ownerId?: string;
  taskId?: string;
  machineDetection?: boolean;
}

const callbackUrl = (d: DialerDeps, path: string, ws: string, callId: string, extra: Record<string, string> = {}) => {
  const u = new URL(`${d.publicUrl.replace(/\/+$/, '')}/telephony/${path}`);
  u.searchParams.set('ws', ws);
  u.searchParams.set('call', callId);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
};

/**
 * Create the call row and, for bridge mode, place the rep leg through Twilio. Softphone mode
 * returns the parameters the browser passes to `device.connect()`; Twilio then calls back
 * `/telephony/voice` for TwiML.
 */
export async function startCall(ctx: Ctx, input: DialInput, d: DialerDeps) {
  const ws = ctx.principal.workspaceId;
  const tel = await requireTelephony(ctx, d);
  const mode = input.mode ?? (tel.apiKey && tel.row.twimlAppSid ? 'softphone' : 'bridge');
  if (mode === 'softphone' && !(tel.apiKey && tel.row.twimlAppSid)) throw unprocessable('Browser calling needs a Twilio API key pair and TwiML App SID under Settings → Dialer; use bridge mode or add them');
  const task = input.taskId ? (await ctx.db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.id, uuidOr404(input.taskId, 'Task')))).limit(1))[0] : undefined;
  if (input.taskId && !task) throw notFound('Task');
  const prospectId = input.prospectId ?? task?.prospectId ?? null;
  const [p] = prospectId ? await ctx.db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), eq(prospects.id, uuidOr404(prospectId, 'Prospect')), isNull(prospects.deletedAt))).limit(1) : [];
  if (prospectId && !p) throw notFound('Prospect');
  const to = normalizePhone(input.to ?? p?.phone ?? null);
  if (!to) throw unprocessable(p ? `${p.name ?? 'This prospect'} has no phone number` : 'to is required when no prospect is given', { field: 'to' });
  const ownerId = await resolveOwner(ctx, [input.ownerId, task?.ownerId, ctx.principal.userId, p?.ownerId]);
  const from = normalizePhone(input.fromNumber ?? tel.row.fromNumbers[0] ?? null);
  if (!from) throw unprocessable('No caller id: add a Twilio number under Settings → Dialer', { field: 'fromNumber' });
  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ownerId)).limit(1);
  let repPhone: string | null = null;
  if (mode === 'bridge') {
    repPhone = normalizePhone(input.repPhone ?? owner?.phone ?? null);
    if (!repPhone) throw unprocessable('Bridge mode needs your phone number: pass repPhone or set it on your user profile', { field: 'repPhone' });
  }
  const [row] = await ctx.db
    .insert(calls)
    .values({
      workspaceId: ws,
      prospectId: p?.id ?? null,
      accountId: p?.accountId ?? null,
      ownerId,
      sequenceId: task?.sequenceId ?? null,
      sequenceStateId: task?.sequenceStateId ?? null,
      sequenceStepId: task?.sequenceStepId ?? null,
      taskId: task?.id ?? null,
      source: task ? 'sequence' : 'dialer',
      direction: 'outbound',
      fromNumber: from,
      toNumber: to,
      status: 'initiated',
      time: ctx.clock.now(),
      provider: 'twilio',
      mode,
    })
    .returning();
  const call = row!;
  if (mode === 'bridge') {
    try {
      const leg = await tel.client.createCall({
        to: repPhone!,
        from,
        url: callbackUrl(d, 'voice/bridge', ws, call.id),
        statusCallback: callbackUrl(d, 'status', ws, call.id, { leg: 'rep' }),
        machineDetection: false,
      });
      await ctx.db.update(calls).set({ providerCallSid: leg.sid, status: 'ringing_rep' }).where(eq(calls.id, call.id));
    } catch (e) {
      await ctx.db.update(calls).set({ status: 'failed', notes: `Twilio: ${(e as Error).message}`, endedAt: ctx.clock.now() }).where(eq(calls.id, call.id));
      throw unprocessable(`Twilio could not place the call: ${(e as Error).message}`);
    }
  }
  return {
    call: serializeCall({ ...call, status: mode === 'bridge' ? 'ringing_rep' : 'initiated' }),
    mode,
    ...(mode === 'softphone' ? { connectParams: { To: to, callId: call.id, ws } } : { repPhone }),
  };
}

/** Short-lived Voice SDK token for the signed-in user (softphone). */
export async function softphoneToken(ctx: Ctx, d: DialerDeps, opts: { ttlSeconds?: number } = {}) {
  const tel = await requireTelephony(ctx, d);
  if (!tel.apiKey || !tel.row.twimlAppSid) throw unprocessable('Browser calling needs a Twilio API key pair and TwiML App SID under Settings → Dialer');
  const identity = `user_${(ctx.principal.userId ?? 'api').replace(/[^A-Za-z0-9_]/g, '')}`;
  return {
    token: voiceAccessToken({ accountSid: tel.row.accountSid, apiKeySid: tel.apiKey.sid, apiKeySecret: tel.apiKey.secret, identity, twimlAppSid: tel.row.twimlAppSid, ttlSeconds: opts.ttlSeconds ?? 3600, now: ctx.clock.now() }),
    identity,
    expiresIn: opts.ttlSeconds ?? 3600,
    fromNumbers: tel.row.fromNumbers,
    voiceUrl: `${d.publicUrl.replace(/\/+$/, '')}/telephony/voice?ws=${ctx.principal.workspaceId}`,
  };
}

/* ---------- Twilio webhooks (public, signature-validated by the route) ---------- */

async function callRow(ctx: Ctx, id: string) {
  if (!isUuid(id)) throw notFound('Call');
  const [row] = await ctx.db.select().from(calls).where(and(eq(calls.workspaceId, ctx.principal.workspaceId), eq(calls.id, id))).limit(1);
  if (!row) throw notFound('Call');
  return row;
}

/** Rep answered the bridge leg: dial the prospect, recording both channels. */
export async function bridgeTwiml(ctx: Ctx, callId: string, params: Record<string, string>, d: DialerDeps) {
  const row = await callRow(ctx, callId);
  const tel = await telephonyFor(ctx, d);
  if (!tel || !row.toNumber || !row.fromNumber) return hangupTwiml('This call is no longer available.');
  if (params.AnsweredBy && params.AnsweredBy.startsWith('machine')) return hangupTwiml();
  const [p] = row.prospectId ? await ctx.db.select({ name: prospects.name }).from(prospects).where(eq(prospects.id, row.prospectId)).limit(1) : [];
  await ctx.db.update(calls).set({ status: 'ringing' }).where(eq(calls.id, row.id));
  return dialTwiml({
    to: row.toNumber,
    callerId: row.fromNumber,
    record: tel.row.record,
    recordingStatusCallback: callbackUrl(d, 'recording', row.workspaceId, row.id),
    statusCallback: callbackUrl(d, 'status', row.workspaceId, row.id, { leg: 'prospect' }),
    sayFirst: `Connecting you to ${p?.name ?? 'the prospect'}.`,
  });
}

/** Browser softphone placed a call: Twilio asks what to do with it. */
export async function softphoneTwiml(ctx: Ctx, params: Record<string, string>, d: DialerDeps) {
  const callId = params.callId ?? '';
  const tel = await telephonyFor(ctx, d);
  if (!tel) return hangupTwiml('Telephony is not configured.');
  const row = await callRow(ctx, callId).catch(() => null);
  if (!row || !row.toNumber || !row.fromNumber) return hangupTwiml('Unknown call.');
  await ctx.db.update(calls).set({ providerCallSid: params.CallSid ?? row.providerCallSid, status: 'ringing' }).where(eq(calls.id, row.id));
  return dialTwiml({
    to: row.toNumber,
    callerId: row.fromNumber,
    record: tel.row.record,
    recordingStatusCallback: callbackUrl(d, 'recording', row.workspaceId, row.id),
    statusCallback: callbackUrl(d, 'status', row.workspaceId, row.id, { leg: 'prospect' }),
  });
}

const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

/** Call progress for either leg. The prospect leg drives the stored status and duration. */
export async function handleStatus(ctx: Ctx, callId: string, leg: 'rep' | 'prospect', params: Record<string, string>) {
  const row = await callRow(ctx, callId);
  const st = params.CallStatus ?? '';
  const now = ctx.clock.now();
  const patch: Partial<typeof calls.$inferInsert> = {};
  if (params.AnsweredBy) patch.amdResult = params.AnsweredBy;
  if (leg === 'prospect') {
    if (st === 'ringing' || st === 'initiated') patch.status = 'ringing';
    if (st === 'in-progress') {
      patch.status = 'in_progress';
      if (!row.loggedAt) patch.time = now;
      await emitEvent(ctx.db, { workspaceId: row.workspaceId, type: 'call.started', aggregateType: 'call', aggregateId: row.id, payload: { callId: row.id, prospectId: row.prospectId, ownerId: row.ownerId }, dedupeKey: `${row.id}:started` });
    }
    if (TERMINAL.has(st)) {
      patch.status = st === 'completed' ? 'completed' : st.replace('-', '_');
      patch.endedAt = now;
      const dur = Number(params.CallDuration ?? params.DialCallDuration ?? 0);
      if (!Number.isNaN(dur) && dur > 0) patch.durationSeconds = dur;
      await emitEvent(ctx.db, { workspaceId: row.workspaceId, type: 'call.completed', aggregateType: 'call', aggregateId: row.id, payload: { callId: row.id, prospectId: row.prospectId, ownerId: row.ownerId, status: patch.status, durationSeconds: patch.durationSeconds ?? row.durationSeconds }, dedupeKey: `${row.id}:completed` });
    }
  } else if (TERMINAL.has(st) && st !== 'completed' && (row.status === 'initiated' || row.status === 'ringing_rep')) {
    // Rep never picked up: the prospect was never dialed.
    patch.status = `rep_${st.replace('-', '_')}`;
    patch.endedAt = now;
  } else if (st === 'completed' && !TERMINAL.has(row.status) && row.status !== 'completed') {
    // Rep hung up; the prospect leg status callback usually arrives too, but close it defensively.
    patch.endedAt = now;
    const dur = Number(params.CallDuration ?? 0);
    if (!row.durationSeconds && dur > 0) patch.durationSeconds = dur;
    if (row.status === 'in_progress') patch.status = 'completed';
    else if (row.status === 'ringing' || row.status === 'ringing_rep') patch.status = 'canceled';
  }
  if (!row.providerCallSid && params.CallSid && leg === 'rep') patch.providerCallSid = params.CallSid;
  if (Object.keys(patch).length) await ctx.db.update(calls).set({ ...patch, updatedAt: now }).where(eq(calls.id, row.id));
  return { callId: row.id, status: patch.status ?? row.status };
}

/** Recording finished: remember the SID; the worker fetches, transcribes and coaches. */
export async function handleRecording(ctx: Ctx, callId: string, params: Record<string, string>, d: DialerDeps) {
  const row = await callRow(ctx, callId);
  if (params.RecordingStatus && params.RecordingStatus !== 'completed') return { callId: row.id, ignored: params.RecordingStatus };
  const sid = params.RecordingSid;
  if (!sid) return { callId: row.id, ignored: 'no sid' };
  const dur = Number(params.RecordingDuration ?? 0);
  const tel = await telephonyFor(ctx, d);
  const wantTranscript = !!tel?.row.transcribe;
  await ctx.db
    .update(calls)
    .set({ recordingSid: sid, recordingUrl: `${d.publicUrl.replace(/\/+$/, '')}/v1/calls/${row.id}/recording`, recordingDurationSeconds: Number.isNaN(dur) ? null : dur, transcriptStatus: wantTranscript ? 'queued' : 'none', updatedAt: ctx.clock.now() })
    .where(eq(calls.id, row.id));
  if (wantTranscript) await ctx.jobs.send('telephony.recording', { callId: row.id, workspaceId: row.workspaceId }, { singletonKey: `rec:${row.id}` });
  return { callId: row.id, recordingSid: sid, transcribe: wantTranscript };
}

/* ---------- logging ---------- */

export interface LogCallInput {
  callDisposition?: { id: string } | null;
  outcome?: string | null;
  dispositionName?: string | null;
  notes?: string | null;
  durationSeconds?: number | null;
}

/** Attach a disposition and notes, close any linked call task, and emit `call.logged`. */
export async function logCall(ctx: Ctx, callId: string, input: LogCallInput) {
  const row = await callRow(ctx, callId);
  if (row.loggedAt) throw conflict('This call is already logged');
  const disp = await dispositionFor(ctx, { dispositionId: input.callDisposition?.id, outcome: input.outcome, name: input.dispositionName });
  if (!disp) throw unprocessable('Pass callDisposition.id, outcome or dispositionName', { field: 'callDisposition' });
  const now = ctx.clock.now();
  const terminal = ['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(row.status) || row.status.startsWith('rep_');
  const [updated] = await ctx.db
    .update(calls)
    .set({
      callDispositionId: disp.id,
      notes: input.notes ?? row.notes,
      durationSeconds: input.durationSeconds ?? row.durationSeconds,
      status: terminal ? row.status : 'completed',
      endedAt: row.endedAt ?? now,
      loggedAt: now,
      updatedAt: now,
    })
    .where(eq(calls.id, row.id))
    .returning();
  if (row.taskId) {
    const [t] = await ctx.db.select().from(tasks).where(eq(tasks.id, row.taskId)).limit(1);
    if (t && !t.completed && t.status !== 'skipped') await completeTask(ctx, t.id).catch(() => undefined);
  }
  await emitEvent(ctx.db, { workspaceId: row.workspaceId, type: 'call.logged', aggregateType: 'call', aggregateId: row.id, payload: { callId: row.id, callData: await callLoggedPayload(ctx, updated!) } });
  return serializeCall(updated!, { callDisposition: { id: disp.id, name: disp.name, callOutcome: disp.callOutcome, order: disp.order, createdAt: isoReq(disp.createdAt), updatedAt: isoReq(disp.updatedAt) } });
}

export interface ManualCallInput {
  prospectId: string;
  ownerId?: string;
  direction?: 'inbound' | 'outbound';
  durationSeconds?: number;
  time?: string;
  to?: string;
  from?: string;
  taskId?: string;
  callDisposition?: { id: string } | null;
  outcome?: string | null;
  dispositionName?: string | null;
  notes?: string | null;
}

/** Log a call that happened outside the dialer (rep's own phone, another tool). */
export async function createManualCall(ctx: Ctx, input: ManualCallInput) {
  const ws = ctx.principal.workspaceId;
  const [p] = await ctx.db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), eq(prospects.id, uuidOr404(input.prospectId, 'Prospect')), isNull(prospects.deletedAt))).limit(1);
  if (!p) throw unprocessable('prospectId not found in this workspace', { field: 'prospectId' });
  const task = input.taskId ? (await ctx.db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.id, uuidOr404(input.taskId, 'Task')))).limit(1))[0] : undefined;
  const ownerId = await resolveOwner(ctx, [input.ownerId, task?.ownerId, ctx.principal.userId, p.ownerId]);
  const time = input.time ? new Date(input.time) : ctx.clock.now();
  if (Number.isNaN(time.getTime())) throw unprocessable('time must be ISO 8601', { field: 'time' });
  const [row] = await ctx.db
    .insert(calls)
    .values({
      workspaceId: ws,
      prospectId: p.id,
      accountId: p.accountId,
      ownerId,
      sequenceId: task?.sequenceId ?? null,
      sequenceStateId: task?.sequenceStateId ?? null,
      sequenceStepId: task?.sequenceStepId ?? null,
      taskId: task?.id ?? null,
      source: task ? 'sequence' : 'manual',
      direction: input.direction ?? 'outbound',
      fromNumber: normalizePhone(input.from) ?? null,
      toNumber: normalizePhone(input.to ?? p.phone) ?? null,
      status: 'completed',
      durationSeconds: input.durationSeconds ?? 0,
      time,
      endedAt: new Date(time.getTime() + (input.durationSeconds ?? 0) * 1000),
      provider: null,
      mode: 'manual',
    })
    .returning();
  return logCall(ctx, row!.id, { callDisposition: input.callDisposition, outcome: input.outcome, dispositionName: input.dispositionName, notes: input.notes });
}

/** Upstream-compatible `callData` (see spec: userData, prospectData, accountData, disposition, sequenceData…). */
export async function callLoggedPayload(ctx: Ctx, c: CallRow) {
  const [u] = c.ownerId ? await ctx.db.select().from(users).where(eq(users.id, c.ownerId)).limit(1) : [];
  const [p] = c.prospectId ? await ctx.db.select().from(prospects).where(eq(prospects.id, c.prospectId)).limit(1) : [];
  const [a] = c.accountId ? await ctx.db.select().from(accounts).where(eq(accounts.id, c.accountId)).limit(1) : [];
  const [d] = c.callDispositionId ? await ctx.db.select().from(callDispositions).where(eq(callDispositions.id, c.callDispositionId)).limit(1) : [];
  const [s] = c.sequenceId ? await ctx.db.select({ name: sequences.name }).from(sequences).where(eq(sequences.id, c.sequenceId)).limit(1) : [];
  const [st] = c.sequenceStepId ? await ctx.db.select({ id: sequenceSteps.id, name: sequenceSteps.name, order: sequenceSteps.order, action: sequenceSteps.action }).from(sequenceSteps).where(eq(sequenceSteps.id, c.sequenceStepId)).limit(1) : [];
  return {
    callId: c.id,
    workspaceId: c.workspaceId,
    userData: { userId: u?.id ?? null, email: u?.email ?? null, name: u?.name ?? null },
    prospectData: { prospectId: p?.id ?? null, name: p ? fullName(p.firstName, p.lastName, p.name) : null, phoneNumber: c.toNumber ?? p?.phone ?? null, email: p?.primaryEmail ?? null, linkedInUrl: p?.linkedInUrl ?? null },
    accountData: { accountId: a?.id ?? null, name: a?.name ?? null },
    callDirection: c.direction,
    status: 'completed',
    disposition: { id: d?.id ?? null, name: d?.name ?? null, callOutcome: d?.callOutcome ?? null },
    startedAt: c.time.toISOString(),
    durationSeconds: c.durationSeconds,
    recordingUrl: c.recordingUrl,
    notes: c.notes,
    transcriptUrl: c.transcriptStatus === 'ready' ? `${ctx.publicUrl.replace(/\/+$/, '')}/app/calls/${c.id}` : null,
    sequenceData: { sequenceName: s?.name ?? null, sequenceStep: st ? { id: st.id, name: st.name, order: st.order, action: st.action } : null },
    source: c.source,
    amdResult: c.amdResult,
  };
}

/** Transcript + coaching for one call (API `GET /v1/calls/{id}/insights`). */
export async function callInsights(ctx: Ctx, callId: string) {
  const row = await callRow(ctx, callId);
  const [tr] = await ctx.db.select().from(callTranscripts).where(eq(callTranscripts.callId, row.id)).orderBy(desc(callTranscripts.createdAt)).limit(1);
  const [co] = await ctx.db.select().from(coachingScores).where(eq(coachingScores.callId, row.id)).orderBy(desc(coachingScores.createdAt)).limit(1);
  return {
    callId: row.id,
    status: row.status,
    transcriptStatus: row.transcriptStatus,
    coachingStatus: row.coachingStatus,
    recordingUrl: row.recordingUrl,
    recordingDurationSeconds: row.recordingDurationSeconds,
    transcript: tr ? { provider: tr.provider, text: tr.text, summary: tr.summary, segments: tr.segments, stats: tr.stats, createdAt: isoReq(tr.createdAt) } : null,
    coaching: co ? { rubric: co.rubric, score: co.score === null ? null : Number(co.score), model: co.model, ...(co.feedback as Record<string, unknown>), createdAt: isoReq(co.createdAt) } : null,
  };
}

/** Re-run transcription/coaching (or run it for the first time) for a recorded call. */
export async function requestCoaching(ctx: Ctx, callId: string) {
  const row = await callRow(ctx, callId);
  if (!row.recordingSid) throw unprocessable('This call has no recording to analyse');
  await ctx.db.update(calls).set({ transcriptStatus: row.transcriptStatus === 'ready' ? row.transcriptStatus : 'queued', coachingStatus: 'queued', updatedAt: ctx.clock.now() }).where(eq(calls.id, row.id));
  const jobId = await ctx.jobs.send('telephony.recording', { callId: row.id, workspaceId: row.workspaceId, force: true }, { singletonKey: `rec:${row.id}:${Date.now()}` });
  return { queued: jobId !== null, callId: row.id };
}

/** Proxy the recording from Twilio so the UI can play it without exposing credentials. */
export async function recordingResponse(ctx: Ctx, callId: string, d: DialerDeps): Promise<Response> {
  const row = await callRow(ctx, callId);
  if (!row.recordingSid) throw notFound('Recording');
  const tel = await requireTelephony(ctx, d);
  const upstream = await tel.client.recordingStream(row.recordingSid, 'mp3');
  if (!upstream.ok) throw notFound('Recording');
  return new Response(upstream.body, { status: 200, headers: { 'content-type': upstream.headers.get('content-type') ?? 'audio/mpeg', 'cache-control': 'private, max-age=3600', ...(upstream.headers.get('content-length') ? { 'content-length': upstream.headers.get('content-length')! } : {}) } });
}
