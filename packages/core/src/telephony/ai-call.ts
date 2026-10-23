/**
 * AI-voiced calls through Speko: place with safety checks (DNC, quiet hours, duration cap, daily
 * spend cap), poll until the call ends, then store transcript, outcome, cost and recording, log
 * the disposition (which closes the task and fires call.logged), and queue coaching.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { DateTime } from 'luxon';
import { accounts, callDispositions, callTranscripts, calls, prospects, tasks, telephonyConnections, users, workspaces } from '@cooks/db';
import type { Ctx } from '../context.js';
import { DialerError, type CallOutcome, type CallScript, type ProviderCallState } from '../dialer/providers/index.js';
import { pickZone } from '../engine/scheduling.js';
import { emitEvent } from '../events.js';
import { notFound, unprocessable } from '../errors.js';
import { serializeCall, type CallRow } from '../services/calls.js';
import { fullName } from '../services/prospects.js';
import { isoReq, memberIds, requireMember, uuidOr404 } from '../services/_shared.js';
import { MAX_AI_CALL_SECONDS, requireSpeko, spekoFor, type TelephonyDeps } from './connection.js';
import { logCall } from './dialer.js';
import { normalizePhone } from './twilio.js';

export interface AiCallDeps extends TelephonyDeps {
  publicUrl: string;
}

/** Calls are only placed between these local hours (prospect's zone). */
export const CALL_HOURS = { start: 8, end: 21 };
/** Rough per-minute estimate used for the spend cap while a call is still running. */
export const EST_USD_PER_MINUTE = 0.2;
/** How long after the hard cap we keep waiting for the provider before forcing a hangup. */
const GRACE_SECONDS = 180;
export const POLL_INTERVAL_SECONDS = 10;

export function withinCallHours(now: Date, tz: string): boolean {
  const dt = DateTime.fromJSDate(now).setZone(tz);
  return dt.isValid && dt.hour >= CALL_HOURS.start && dt.hour < CALL_HOURS.end;
}

/** Next moment calls are allowed in `tz` (today 08:00 or tomorrow 08:00). */
export function nextCallWindow(now: Date, tz: string): Date {
  let dt = DateTime.fromJSDate(now).setZone(tz);
  if (dt.hour >= CALL_HOURS.end) dt = dt.plus({ days: 1 });
  return dt.set({ hour: CALL_HOURS.start, minute: 0, second: 0, millisecond: 0 }).toJSDate();
}

/** `{{ a.b }}` substitution over a flat map; unknown keys become empty strings so scripts never leak braces. */
export function fillScript(tpl: string, vars: Record<string, string | null | undefined>): string {
  return tpl.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_, k: string) => (vars[k] ?? '').toString()).replace(/\s{2,}/g, ' ').trim();
}

export interface AiCallInput {
  prospectId?: string;
  to?: string;
  taskId?: string;
  ownerId?: string;
  systemPrompt?: string;
  firstMessage?: string;
  maxDurationSeconds?: number;
  fromNumber?: string;
  language?: string;
  voice?: string;
  agentId?: string;
  onMachine?: 'hangup' | 'leave_message' | 'agent_decides';
  voicemailMessage?: string;
}

async function callRow(ctx: Ctx, id: string): Promise<CallRow> {
  const [row] = await ctx.db.select().from(calls).where(and(eq(calls.workspaceId, ctx.principal.workspaceId), eq(calls.id, uuidOr404(id, 'Call')), isNull(calls.deletedAt))).limit(1);
  if (!row) throw notFound('Call');
  return row;
}

async function resolveOwner(ctx: Ctx, candidates: Array<string | null | undefined>) {
  for (const c of candidates) if (c) return requireMember(ctx, c, 'ownerId');
  const [first] = await memberIds(ctx);
  if (!first) throw unprocessable('ownerId is required');
  return first;
}

/** Speko calls that already cost money today (UTC), plus a running estimate for calls still in flight. */
export async function spekoSpendToday(ctx: Ctx, now: Date): Promise<{ spentUsd: number; inFlight: number }> {
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const rows = await ctx.db
    .select({ cost: calls.costUsd, status: calls.status, aiConfig: calls.aiConfig })
    .from(calls)
    .where(and(eq(calls.workspaceId, ctx.principal.workspaceId), eq(calls.provider, 'speko'), gte(calls.createdAt, dayStart), isNull(calls.deletedAt)));
  let spentUsd = 0;
  let inFlight = 0;
  for (const r of rows) {
    if (r.cost !== null) spentUsd += Number(r.cost);
    else if (['queued', 'ringing', 'in_progress', 'initiated'].includes(r.status)) {
      inFlight += 1;
      spentUsd += (Number((r.aiConfig as { maxDurationSeconds?: number } | null)?.maxDurationSeconds ?? 120) / 60) * EST_USD_PER_MINUTE;
    }
  }
  return { spentUsd: Math.round(spentUsd * 10_000) / 10_000, inFlight };
}

/** True when the prospect has ever been logged with a Do-not-call disposition. */
export const dncOutcome = async (ctx: Ctx, prospectId: string) => {
  const [hit] = await ctx.db
    .select({ id: calls.id })
    .from(calls)
    .innerJoin(callDispositions, eq(callDispositions.id, calls.callDispositionId))
    .where(and(eq(calls.workspaceId, ctx.principal.workspaceId), eq(calls.prospectId, prospectId), eq(callDispositions.callOutcome, 'do_not_call')))
    .limit(1);
  return !!hit;
};

/**
 * Place an AI call. Safety checks run before any provider request; a provider rejection is
 * stored on the call row with the rep-facing message and re-thrown as a 422 with Speko's code.
 */
export async function placeAiCall(ctx: Ctx, input: AiCallInput, d: AiCallDeps) {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const sp = await requireSpeko(ctx, d);
  const task = input.taskId ? (await ctx.db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.id, uuidOr404(input.taskId, 'Task')))).limit(1))[0] : undefined;
  if (input.taskId && !task) throw notFound('Task');
  const prospectId = input.prospectId ?? task?.prospectId ?? null;
  const [p] = prospectId ? await ctx.db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), eq(prospects.id, uuidOr404(prospectId, 'Prospect')), isNull(prospects.deletedAt))).limit(1) : [];
  if (prospectId && !p) throw notFound('Prospect');
  const [account] = p?.accountId ? await ctx.db.select().from(accounts).where(eq(accounts.id, p.accountId)).limit(1) : [];
  const to = normalizePhone(input.to ?? p?.phone ?? null);
  if (!to) throw unprocessable(p ? `${p.name ?? 'This prospect'} has no phone number` : 'to is required when no prospect is given', { field: 'to' });
  const ownerId = await resolveOwner(ctx, [input.ownerId, task?.ownerId, ctx.principal.userId, p?.ownerId]);
  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ownerId)).limit(1);
  const [w] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ws)).limit(1);

  // ---- safety
  if (p?.doNotContact || (p && (await dncOutcome(ctx, p.id)))) throw unprocessable(`${p!.name ?? 'This prospect'} is on the do-not-call list`, { code: 'DO_NOT_CALL' });
  const tz = pickZone(p?.timezone, account?.timezone, owner?.timezone, w?.settings.timezone);
  if (!withinCallHours(now, tz)) {
    const next = nextCallWindow(now, tz);
    throw unprocessable(`Outside calling hours for ${tz} (${CALL_HOURS.start}:00 to ${CALL_HOURS.end}:00 local). Next window opens ${DateTime.fromJSDate(next).setZone(tz).toFormat('ccc HH:mm ZZZZ')}.`, { code: 'QUIET_HOURS', timezone: tz, nextWindowAt: next.toISOString() });
  }
  const maxDurationSeconds = Math.min(Math.max(30, input.maxDurationSeconds ?? sp.settings.maxDurationSeconds), MAX_AI_CALL_SECONDS);
  const cap = sp.settings.dailySpendCapUsd;
  const spend = await spekoSpendToday(ctx, now);
  const estimate = (maxDurationSeconds / 60) * EST_USD_PER_MINUTE;
  if (cap > 0 && spend.spentUsd + estimate > cap) throw unprocessable(`Daily AI call budget reached ($${spend.spentUsd.toFixed(2)} of $${cap.toFixed(2)} today). Raise the cap under Settings → Dialer or try tomorrow.`, { code: 'SPEND_CAP', spentUsd: spend.spentUsd, capUsd: cap });
  const from = normalizePhone(input.fromNumber ?? sp.settings.fromNumber ?? sp.row.fromNumbers[0] ?? null);
  if (!from) throw unprocessable('No caller id: pick or buy a Speko number under Settings → Dialer', { field: 'fromNumber' });

  // ---- script
  const vars: Record<string, string | null | undefined> = {
    'prospect.firstName': p?.firstName ?? (p?.name ?? '').split(' ')[0],
    'prospect.lastName': p?.lastName,
    'prospect.name': p ? fullName(p.firstName, p.lastName, p.name) : null,
    'prospect.title': p?.title,
    'prospect.email': p?.primaryEmail,
    'account.name': account?.name,
    'account.domain': account?.domain,
    'owner.name': owner?.name,
    'owner.email': owner?.email,
    'owner.calendarUrl': owner?.calendarUrl,
    'workspace.name': w?.name,
  };
  const script: CallScript = {
    systemPrompt: fillScript(input.systemPrompt ?? sp.settings.systemPrompt, vars),
    firstMessage: fillScript(input.firstMessage ?? sp.settings.firstMessage, vars),
    language: input.language ?? sp.settings.language,
    voice: input.voice ?? sp.settings.voice ?? undefined,
    agentId: input.agentId ?? sp.settings.agentId ?? undefined,
    onMachine: input.onMachine ?? sp.settings.onMachine,
    voicemailMessage: input.voicemailMessage ?? (sp.settings.voicemailMessage ? fillScript(sp.settings.voicemailMessage, vars) : undefined),
  };

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
      time: now,
      provider: 'speko',
      mode: 'ai',
      aiConfig: { ...script, maxDurationSeconds, timezone: tz, from },
    })
    .returning();
  const call = row!;
  try {
    const placed = await sp.provider.placeCall({ callId: call.id, to, from, prospectId: p?.id ?? null, script, maxDurationSeconds, metadata: { workspaceId: ws, ownerId } });
    const [updated] = await ctx.db.update(calls).set({ spekoSessionId: placed.providerCallId, providerCallSid: placed.providerCallId, status: 'queued', updatedAt: now }).where(eq(calls.id, call.id)).returning();
    await ctx.jobs.send('telephony.ai_poll', { callId: call.id, workspaceId: ws, attempt: 1 }, { startAfter: new Date(now.getTime() + POLL_INTERVAL_SECONDS * 1000), singletonKey: `aipoll:${call.id}:1` });
    return { call: serializeCall(updated!), status: 'queued' as const, maxDurationSeconds, timezone: tz, estimatedUsd: Math.round(estimate * 100) / 100 };
  } catch (e) {
    const err = e instanceof DialerError ? e : new DialerError('speko', 'UNKNOWN', (e as Error).message, 502, true);
    await ctx.db.update(calls).set({ status: 'failed', outcome: 'failed', endReason: err.code, notes: `Speko: ${err.message}`, endedAt: now, updatedAt: now }).where(eq(calls.id, call.id));
    throw unprocessable(err.message, { code: err.code, provider: 'speko', retryable: err.retryable, ...(err.details ?? {}) });
  }
}

/** Talk statistics in the shape the coaching rubric and the call page expect, from provider transcript entries. */
export function transcriptStats(segments: Array<{ speaker: 'rep' | 'prospect'; start: number; end: number; text: string }>) {
  const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
  const dur = (s: { start: number; end: number }) => Math.max(0, s.end - s.start);
  const rep = segments.filter((s) => s.speaker === 'rep');
  const pro = segments.filter((s) => s.speaker === 'prospect');
  const repSec = rep.reduce((a, s) => a + dur(s), 0);
  const proSec = pro.reduce((a, s) => a + dur(s), 0);
  const repWords = rep.reduce((a, s) => a + words(s.text), 0);
  let longest = 0;
  let run = 0;
  let switches = 0;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (i > 0 && segments[i - 1]!.speaker !== s.speaker) switches++;
    run = i > 0 && segments[i - 1]!.speaker === s.speaker && s.speaker === 'rep' ? run + dur(s) : s.speaker === 'rep' ? dur(s) : 0;
    longest = Math.max(longest, run);
  }
  const q = (list: typeof segments) => list.reduce((a, s) => a + (s.text.match(/\?/g)?.length ?? 0), 0);
  const total = repSec + proSec;
  return {
    talkRatio: total > 0 ? Math.round((repSec / total) * 100) / 100 : 0,
    repSeconds: Math.round(repSec),
    prospectSeconds: Math.round(proSec),
    longestRepMonologueSeconds: Math.round(longest),
    repQuestions: q(rep),
    prospectQuestions: q(pro),
    repWordsPerMinute: repSec > 0 ? Math.round(repWords / (repSec / 60)) : 0,
    interruptionsByRep: 0,
    interruptionsByProspect: 0,
    switches,
    stereo: true,
    source: 'provider_transcript',
  };
}

const STATUS_FOR: Record<CallOutcome, string> = { answered: 'completed', voicemail: 'completed', no_answer: 'no_answer', failed: 'failed' };
const DISPOSITION_FOR: Record<CallOutcome, string> = { answered: 'connected', voicemail: 'left_voicemail', no_answer: 'no_answer', failed: 'not_connected' };

/** Write everything the provider reported for a finished call and log the disposition. */
async function finalizeAiCall(ctx: Ctx, row: CallRow, state: ProviderCallState, d: AiCallDeps, coach: boolean) {
  const now = ctx.clock.now();
  const outcome: CallOutcome = state.outcome ?? 'failed';
  const transcript = state.transcript ?? [];
  const sp = await spekoFor(ctx, d);
  let recordingUrl: string | null = null;
  if (sp && row.spekoSessionId && state.recordingStatus !== 'suppressed' && state.recordingStatus !== 'discarded') {
    recordingUrl = (await sp.provider.getRecording(row.spekoSessionId).catch(() => null)) ? `${d.publicUrl.replace(/\/+$/, '')}/v1/calls/${row.id}/recording` : null;
  }
  const endedAt = state.endedAt ? new Date(state.endedAt) : now;
  const duration = state.durationSeconds ?? (row.time ? Math.max(0, Math.round((endedAt.getTime() - row.time.getTime()) / 1000)) : 0);
  await ctx.db
    .update(calls)
    .set({
      status: STATUS_FOR[outcome],
      outcome,
      endReason: state.endReason ?? null,
      endedAt,
      durationSeconds: duration,
      costUsd: state.costUsd !== null && state.costUsd !== undefined ? state.costUsd.toFixed(4) : null,
      transcript,
      summary: state.summary ?? null,
      recordingUrl,
      recordingDurationSeconds: recordingUrl ? duration : null,
      transcriptStatus: transcript.length ? 'ready' : 'none',
      coachingStatus: coach && transcript.length ? 'queued' : 'none',
      updatedAt: now,
    })
    .where(eq(calls.id, row.id));
  if (transcript.length) {
    const t0 = transcript[0]?.startedAt ? new Date(transcript[0].startedAt).getTime() : null;
    const sec = (iso: string | null | undefined) => (iso && t0 ? Math.max(0, (new Date(iso).getTime() - t0) / 1000) : 0);
    const segments = transcript.filter((t) => t.role !== 'system').map((t) => ({ speaker: t.role === 'agent' ? ('rep' as const) : ('prospect' as const), start: sec(t.startedAt), end: sec(t.endedAt ?? t.startedAt), text: t.text }));
    await ctx.db.delete(callTranscripts).where(eq(callTranscripts.callId, row.id));
    await ctx.db.insert(callTranscripts).values({ workspaceId: row.workspaceId, callId: row.id, provider: 'speko', segments, text: segments.map((s) => `${s.speaker === 'rep' ? 'Agent' : 'Prospect'}: ${s.text}`).join('\n'), summary: state.summary ?? null, stats: transcriptStats(segments) });
    if (coach) await ctx.jobs.send('ai.coach_call', { callId: row.id, workspaceId: row.workspaceId }, { singletonKey: `coach:${row.id}` });
  }
  await emitEvent(ctx.db, { workspaceId: row.workspaceId, type: 'call.completed', aggregateType: 'call', aggregateId: row.id, payload: { callId: row.id, prospectId: row.prospectId, ownerId: row.ownerId, status: STATUS_FOR[outcome], outcome, durationSeconds: duration, costUsd: state.costUsd ?? null, provider: 'speko' }, dedupeKey: `${row.id}:completed` });
  if (!row.loggedAt) {
    const notes = [state.summary, state.endReason ? `End reason: ${state.endReason}` : null].filter(Boolean).join('\n') || null;
    await logCall(ctx, row.id, { outcome: DISPOSITION_FOR[outcome], notes }).catch(() => undefined);
  }
  return { done: true as const, status: STATUS_FOR[outcome], outcome };
}

/**
 * One polling step. Returns `done: false` with the next delay while the call runs; the worker
 * re-enqueues. Forces a hangup if the provider never reports an end past the hard cap.
 */
export async function pollAiCall(ctx: Ctx, callId: string, d: AiCallDeps, opts: { attempt?: number } = {}): Promise<{ done: boolean; status: string; outcome?: CallOutcome; nextDelaySeconds?: number }> {
  const row = await callRow(ctx, callId);
  if (row.provider !== 'speko' || !row.spekoSessionId) return { done: true, status: row.status };
  if (!['initiated', 'queued', 'ringing', 'in_progress'].includes(row.status)) return { done: true, status: row.status, outcome: (row.outcome as CallOutcome | null) ?? undefined };
  const sp = await requireSpeko(ctx, d);
  const now = ctx.clock.now();
  const coach = sp.row.coach;
  let state: ProviderCallState;
  try {
    state = await sp.provider.getCall(row.spekoSessionId);
  } catch (e) {
    if (e instanceof DialerError && e.status === 404) {
      await ctx.db.update(calls).set({ status: 'failed', outcome: 'failed', endReason: 'session_not_found', endedAt: now, updatedAt: now }).where(eq(calls.id, row.id));
      return { done: true, status: 'failed', outcome: 'failed' };
    }
    throw e;
  }
  const maxSeconds = Number((row.aiConfig as { maxDurationSeconds?: number } | null)?.maxDurationSeconds ?? MAX_AI_CALL_SECONDS);
  const age = (now.getTime() - row.createdAt.getTime()) / 1000;
  if (state.status !== 'ended' && age > maxSeconds + GRACE_SECONDS) {
    await sp.provider.hangup(row.spekoSessionId).catch(() => undefined);
    return finalizeAiCall(ctx, row, { ...state, status: 'ended', outcome: state.status === 'in_progress' ? 'answered' : 'failed', endReason: state.endReason ?? 'timeout', endedAt: now.toISOString() }, d, coach);
  }
  if (state.status === 'ended') return finalizeAiCall(ctx, row, state, d, coach);
  const patch: Partial<typeof calls.$inferInsert> = { updatedAt: now };
  if (state.status === 'ringing' && row.status !== 'ringing' && row.status !== 'in_progress') patch.status = 'ringing';
  if (state.status === 'in_progress' && row.status !== 'in_progress') {
    patch.status = 'in_progress';
    patch.time = now;
    await emitEvent(ctx.db, { workspaceId: row.workspaceId, type: 'call.started', aggregateType: 'call', aggregateId: row.id, payload: { callId: row.id, prospectId: row.prospectId, ownerId: row.ownerId, provider: 'speko' }, dedupeKey: `${row.id}:started` });
  }
  if (Object.keys(patch).length > 1) await ctx.db.update(calls).set(patch).where(eq(calls.id, row.id));
  const attempt = opts.attempt ?? 1;
  return { done: false, status: patch.status ?? row.status, nextDelaySeconds: attempt < 3 ? POLL_INTERVAL_SECONDS : Math.min(30, POLL_INTERVAL_SECONDS * 2) };
}

export async function hangupAiCall(ctx: Ctx, callId: string, d: AiCallDeps) {
  const row = await callRow(ctx, callId);
  if (row.provider !== 'speko' || !row.spekoSessionId) throw unprocessable('Only AI calls can be ended from here');
  if (!['queued', 'ringing', 'in_progress', 'initiated'].includes(row.status)) return { callId: row.id, status: row.status, ended: false };
  const sp = await requireSpeko(ctx, d);
  await sp.provider.hangup(row.spekoSessionId);
  await ctx.jobs.send('telephony.ai_poll', { callId: row.id, workspaceId: row.workspaceId, attempt: 1 }, { startAfter: new Date(ctx.clock.now().getTime() + 3000), singletonKey: `aipoll:${row.id}:hangup:${Date.now()}` });
  return { callId: row.id, status: row.status, ended: true };
}

/** Stream a Speko recording through the API so the UI never sees the signed URL or the key. */
export async function aiRecordingResponse(ctx: Ctx, row: CallRow, d: AiCallDeps): Promise<Response> {
  if (!row.spekoSessionId) throw notFound('Recording');
  const sp = await requireSpeko(ctx, d);
  const ref = await sp.provider.getRecording(row.spekoSessionId);
  if (!ref) throw notFound('Recording');
  const upstream = await (d.fetchImpl ?? fetch)(ref.url, { redirect: 'follow' });
  if (!upstream.ok) throw notFound('Recording');
  const type = upstream.headers.get('content-type') ?? 'audio/mpeg';
  return new Response(upstream.body, { status: 200, headers: { 'content-type': type.startsWith('audio/') || type.includes('octet') ? type : 'audio/mpeg', 'cache-control': 'private, max-age=240' } });
}

/** Transcript + outcome for one call, provider-neutral (MCP `cooks_get_call_transcript`). */
export async function callTranscript(ctx: Ctx, callId: string) {
  const row = await callRow(ctx, callId);
  const [tr] = await ctx.db.select().from(callTranscripts).where(eq(callTranscripts.callId, row.id)).orderBy(desc(callTranscripts.createdAt)).limit(1);
  const entries = row.transcript?.length
    ? row.transcript
    : ((tr?.segments ?? []) as Array<{ speaker: string; start: number; end: number; text: string }>).map((s, i) => ({ index: i, role: s.speaker === 'rep' ? ('agent' as const) : ('user' as const), text: s.text, startedAt: new Date(row.time.getTime() + s.start * 1000).toISOString(), endedAt: new Date(row.time.getTime() + s.end * 1000).toISOString() }));
  return {
    callId: row.id,
    provider: row.provider,
    status: row.status,
    outcome: row.outcome,
    endReason: row.endReason,
    summary: row.summary ?? tr?.summary ?? null,
    durationSeconds: row.durationSeconds,
    costUsd: row.costUsd === null ? null : Number(row.costUsd),
    recordingUrl: row.recordingUrl,
    transcriptStatus: row.transcriptStatus,
    coachingStatus: row.coachingStatus,
    loggedAt: row.loggedAt ? isoReq(row.loggedAt) : null,
    transcript: entries,
    text: tr?.text ?? entries.map((e) => `${e.role === 'agent' ? 'Agent' : e.role === 'user' ? 'Prospect' : 'System'}: ${e.text}`).join('\n'),
  };
}

/* ---------- Speko numbers and balance ---------- */

export async function spekoNumbers(ctx: Ctx, d: AiCallDeps) {
  const sp = await requireSpeko(ctx, d);
  const list = await sp.client.listNumbers();
  return list.map((n) => ({ id: n.id, e164: normalizePhone(n.e164) ?? n.e164, label: n.label ?? null, direction: n.direction ?? null, source: n.source ?? null, status: n.setupStatus?.status ?? 'unknown', outboundReady: n.setupStatus?.outboundReady ?? null, issues: n.setupStatus?.issues ?? [], nextChargeAt: n.nextChargeAt ?? null, suspensionReason: n.suspensionReason ?? null, isDefault: (sp.settings.fromNumber ?? sp.row.fromNumbers[0]) === (normalizePhone(n.e164) ?? n.e164) }));
}

export async function searchSpekoNumbers(ctx: Ctx, d: AiCallDeps, q: { country?: string; areaCode?: string; numberType?: string; locality?: string; state?: string; limit?: number }) {
  const sp = await requireSpeko(ctx, d);
  return sp.client.searchNumbers({ country: q.country ?? 'US', ...q, limit: q.limit ?? 10 });
}

/** PAID. Requires an admin and `confirm: true`; the UI shows the quoted price first. */
export async function buySpekoNumber(ctx: Ctx, d: AiCallDeps, input: { e164: string; confirm?: boolean; label?: string; expectedUpfrontCostUsd?: number; expectedMonthlyCostUsd?: number; makeDefault?: boolean }) {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw unprocessable('Only admins can buy phone numbers', { code: 'ADMIN_REQUIRED' });
  if (input.confirm !== true) throw unprocessable('Buying a number is a paid action: confirm the setup and monthly price by passing confirm: true', { code: 'CONFIRM_REQUIRED' });
  const sp = await requireSpeko(ctx, d);
  const e164 = normalizePhone(input.e164) ?? input.e164;
  let bought;
  try {
    bought = await sp.client.buyNumber({ e164, direction: 'both', label: input.label ?? 'Cooks', expectedUpfrontCostUsd: input.expectedUpfrontCostUsd, expectedMonthlyCostUsd: input.expectedMonthlyCostUsd });
  } catch (e) {
    if (e instanceof DialerError) throw unprocessable(e.message, { code: e.code, provider: 'speko', ...(e.details ?? {}) });
    throw e;
  }
  const num = normalizePhone(bought.e164) ?? bought.e164;
  const fromNumbers = [...new Set([...sp.row.fromNumbers, num])];
  const settings = { ...(sp.row.settings as Record<string, unknown>), ...(input.makeDefault || !sp.settings.fromNumber ? { fromNumber: num } : {}) };
  await ctx.db.update(telephonyConnections).set({ fromNumbers, settings, updatedAt: ctx.clock.now() }).where(eq(telephonyConnections.id, sp.row.id));
  return { id: bought.id, e164: num, label: bought.label ?? null, status: bought.setupStatus?.status ?? 'unknown', outboundReady: bought.setupStatus?.outboundReady ?? null, issues: bought.setupStatus?.issues ?? [], nextChargeAt: bought.nextChargeAt ?? null, isDefault: settings.fromNumber === num };
}

export async function dialerBalance(ctx: Ctx, d: AiCallDeps) {
  const sp = await spekoFor(ctx, d);
  if (!sp) return { provider: 'speko' as const, connected: false, balanceUsd: null, currency: 'USD', spentTodayUsd: 0, inFlight: 0, dailySpendCapUsd: null as number | null, updatedAt: null as string | null };
  const [bal, spend] = await Promise.all([sp.client.balance().catch(() => ({ balanceUsd: null, currency: 'USD', updatedAt: null })), spekoSpendToday(ctx, ctx.clock.now())]);
  return { provider: 'speko' as const, connected: true, balanceUsd: bal.balanceUsd, currency: bal.currency, spentTodayUsd: spend.spentUsd, inFlight: spend.inFlight, dailySpendCapUsd: sp.settings.dailySpendCapUsd, updatedAt: bal.updatedAt ?? null };
}

/* ---------- webhook ---------- */

/** Standard Webhooks: `v1,<base64 HMAC-SHA256(secret, "<id>.<timestamp>.<body>")>`; secrets may carry a `whsec_` prefix. */
export function verifyStandardWebhook(secret: string, headers: { id?: string | null; timestamp?: string | null; signature?: string | null }, rawBody: string, now = new Date(), toleranceSeconds = 300): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > toleranceSeconds) return false;
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = /^[A-Za-z0-9+/=_-]+$/.test(raw) && raw.length % 4 === 0 ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8');
  const expected = createHmac('sha256', key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  for (const part of headers.signature.split(/\s+/)) {
    const [v, sig] = part.split(',');
    if (v !== 'v1' || !sig) continue;
    const got = Buffer.from(sig, 'base64');
    if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
  }
  return false;
}

/** A Speko `call.*` event: find the call by session id and poll right away instead of waiting for the next tick. */
export async function handleSpekoWebhook(ctx: Ctx, body: Record<string, unknown>) {
  const sessionId = (body.call_id ?? body.session_id ?? (body.call as Record<string, unknown> | undefined)?.id) as string | undefined;
  if (!sessionId) return { ignored: 'no session id' };
  const [row] = await ctx.db.select({ id: calls.id, status: calls.status }).from(calls).where(and(eq(calls.workspaceId, ctx.principal.workspaceId), eq(calls.spekoSessionId, sessionId))).limit(1);
  if (!row) return { ignored: 'unknown session' };
  if (!['initiated', 'queued', 'ringing', 'in_progress'].includes(row.status)) return { callId: row.id, ignored: 'already final' };
  await ctx.jobs.send('telephony.ai_poll', { callId: row.id, workspaceId: ctx.principal.workspaceId, attempt: 1 }, { singletonKey: `aipoll:${row.id}:wh:${String(body.type ?? 'event')}:${Date.now()}` });
  return { callId: row.id, queued: true };
}
