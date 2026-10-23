/**
 * Parallel dialer ("power dialer"): the rep waits in a carrier conference while Cooks dials
 * several prospects at once with asynchronous answering-machine detection. The first leg the
 * carrier reports as HUMAN is bridged into the conference with no beep or announcement; every
 * sibling leg is hung up at once; a second human who answers in the race window is dropped and
 * turned into a callback task; machines are hung up and logged, never connected.
 *
 * "First human wins" is one UPDATE on dial_sessions guarded by `connected_line_id IS NULL`. Two
 * AMD callbacks for two humans can race all they like: exactly one of those statements returns a
 * row. Carrier webhooks are idempotent through dial_events (unique dedupe key per receipt).
 *
 * Carrier primitives live behind ParallelCarrier (dialer/providers/types.ts); Twilio is the first.
 */
import { and, desc, eq, gte, inArray, isNull, lt } from 'drizzle-orm';
import { accounts, calls, dialEvents, dialLines, dialSessions, prospects, tasks, users, uuidv7, workspaces, type Db } from '@cooks/db';
import type { Ctx } from '../context.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import { emitEvent } from '../events.js';
import { pickZone } from '../engine/scheduling.js';
import { systemPrincipal } from '../principal.js';
import { DialerError, TwilioProvider, type ParallelCarrier } from '../dialer/providers/index.js';
import { fullName } from '../services/prospects.js';
import { createTask } from '../services/tasks.js';
import { isoReq, memberIds, requireMember, uuidOr404 } from '../services/_shared.js';
import { CALL_HOURS, dncOutcome, withinCallHours } from './ai-call.js';
import { getParallelSettings, requireTelephony, telephonyFor, type TelephonyDeps } from './connection.js';
import { logCall, type DialerDeps } from './dialer.js';
import { hangupTwiml, normalizePhone } from './twilio.js';

export type DialSessionRow = typeof dialSessions.$inferSelect;
export type DialLineRow = typeof dialLines.$inferSelect;

/** Line states that still hold a carrier leg. */
const LIVE_LINE = ['dialing', 'ringing', 'answered', 'connected'] as const;
/** Line states before a verdict: a human here can still win. */
const RACING_LINE = ['dialing', 'ringing', 'answered'] as const;
const OPEN_SESSION = ['waiting_rep', 'ready', 'dialing', 'connected', 'wrapping'] as const;
/** Callback tasks for dropped humans are due this soon. */
const CALLBACK_MINUTES = 15;
/** Sessions with no carrier activity for this long are closed by the sweep. */
export const SESSION_IDLE_MINUTES = 120;
/** Twilio's AMD verdict normally arrives within the timeout; hold a little longer, then let go. */
const HOLD_GRACE_SECONDS = 10;

const cb = (d: DialerDeps, path: string, q: Record<string, string>) => {
  const u = new URL(`${d.publicUrl.replace(/\/+$/, '')}/telephony/parallel/${path}`);
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  return u.toString();
};

/* ------------------------------------------------------------------ carrier */

interface Carrier {
  carrier: ParallelCarrier;
  record: boolean;
  fromNumbers: string[];
  softphone: boolean;
}

async function carrierFor(ctx: Ctx, d: DialerDeps): Promise<Carrier> {
  const tel = await requireTelephony(ctx, d);
  return { carrier: new TwilioProvider(tel.client), record: tel.row.record, fromNumbers: tel.row.fromNumbers, softphone: !!(tel.apiKey && tel.row.twimlAppSid) };
}
async function carrierOrNull(ctx: Ctx, d: DialerDeps): Promise<Carrier | null> {
  const tel = await telephonyFor(ctx, d);
  if (!tel) return null;
  return { carrier: new TwilioProvider(tel.client), record: tel.row.record, fromNumbers: tel.row.fromNumbers, softphone: !!(tel.apiKey && tel.row.twimlAppSid) };
}

/* -------------------------------------------------------------------- rows */

async function sessionRow(ctx: Ctx, id: string): Promise<DialSessionRow> {
  const [row] = await ctx.db.select().from(dialSessions).where(and(eq(dialSessions.workspaceId, ctx.principal.workspaceId), eq(dialSessions.id, uuidOr404(id, 'Dial session')))).limit(1);
  if (!row) throw notFound('Dial session');
  return row;
}
async function lineRow(ctx: Ctx, id: string): Promise<DialLineRow> {
  const [row] = await ctx.db.select().from(dialLines).where(and(eq(dialLines.workspaceId, ctx.principal.workspaceId), eq(dialLines.id, uuidOr404(id, 'Dial line')))).limit(1);
  if (!row) throw notFound('Dial line');
  return row;
}
const touch = (now: Date) => ({ lastActivityAt: now, updatedAt: now });

/**
 * Record a carrier receipt. Returns false when the same receipt was already processed, which
 * makes every webhook handler a no-op on redelivery.
 */
export async function recordDialEvent(ctx: Ctx, sessionId: string | null, dedupeKey: string, kind: string, payload: Record<string, unknown>): Promise<boolean> {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) if (!/token|secret|signature|auth/i.test(k)) safe[k] = v;
  const inserted = await ctx.db.insert(dialEvents).values({ workspaceId: ctx.principal.workspaceId, sessionId, dedupeKey, kind, payload: safe }).onConflictDoNothing().returning({ id: dialEvents.id });
  return inserted.length > 0;
}

/* ------------------------------------------------------------- serializers */

export interface DialSessionView {
  id: string;
  status: string;
  repMode: string;
  repPhone: string | null;
  fromNumber: string;
  conferenceName: string;
  maxLines: number;
  batch: number;
  complianceMode: string;
  autoDial: boolean;
  owner: { id: string } | null;
  repJoinedAt: string | null;
  connectedLineId: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  updatedAt: string;
  stats: Record<string, number>;
  lines: DialLineView[];
  connectParams?: Record<string, string>;
}
export interface DialLineView {
  id: string;
  batch: number;
  status: string;
  to: string | null;
  prospect: { id: string; name: string | null; title: string | null; phone: string | null; account: string | null } | null;
  callId: string | null;
  taskId: string | null;
  callbackTaskId: string | null;
  answeredBy: string | null;
  skipReason: string | null;
  endReason: string | null;
  answeredAt: string | null;
  connectedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  createdAt: string;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function lineStats(lines: DialLineRow[]): Record<string, number> {
  const s: Record<string, number> = { total: lines.length, queued: 0, skipped: 0, dialed: 0, live: 0, humans: 0, connected: 0, dropped: 0, voicemail: 0, noAnswer: 0, busy: 0, failed: 0, canceled: 0, completed: 0 };
  for (const l of lines) {
    if (l.status === 'queued') s.queued!++;
    else if (l.status === 'skipped') s.skipped!++;
    else s.dialed!++;
    if ((LIVE_LINE as readonly string[]).includes(l.status)) s.live!++;
    if (l.answeredBy === 'human') s.humans!++;
    if (l.status === 'connected' || l.status === 'completed') s.connected!++;
    if (l.status === 'completed') s.completed!++;
    if (l.status === 'dropped') s.dropped!++;
    if (l.status === 'voicemail') s.voicemail!++;
    if (l.status === 'no_answer') s.noAnswer!++;
    if (l.status === 'busy') s.busy!++;
    if (l.status === 'failed') s.failed!++;
    if (l.status === 'canceled') s.canceled!++;
  }
  return s;
}

async function viewOf(ctx: Ctx, s: DialSessionRow, extra: { connectParams?: Record<string, string> } = {}): Promise<DialSessionView> {
  const lines = await ctx.db.select().from(dialLines).where(eq(dialLines.sessionId, s.id)).orderBy(dialLines.createdAt);
  const pids = [...new Set(lines.map((l) => l.prospectId).filter((x): x is string => !!x))];
  const ps = pids.length ? await ctx.db.select({ id: prospects.id, firstName: prospects.firstName, lastName: prospects.lastName, name: prospects.name, title: prospects.title, phone: prospects.phone, accountId: prospects.accountId }).from(prospects).where(inArray(prospects.id, pids)) : [];
  const aids = [...new Set(ps.map((p) => p.accountId).filter((x): x is string => !!x))];
  const as = aids.length ? await ctx.db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(inArray(accounts.id, aids)) : [];
  const am = new Map(as.map((a) => [a.id, a.name]));
  const pm = new Map(ps.map((p) => [p.id, { id: p.id, name: fullName(p.firstName, p.lastName, p.name), title: p.title, phone: p.phone, account: p.accountId ? (am.get(p.accountId) ?? null) : null }]));
  return {
    id: s.id,
    status: s.status,
    repMode: s.repMode,
    repPhone: s.repPhone,
    fromNumber: s.fromNumber,
    conferenceName: s.conferenceName,
    maxLines: s.maxLines,
    batch: s.batch,
    complianceMode: s.complianceMode,
    autoDial: s.autoDial,
    owner: s.ownerId ? { id: s.ownerId } : null,
    repJoinedAt: iso(s.repJoinedAt),
    connectedLineId: s.connectedLineId,
    connectedAt: iso(s.connectedAt),
    endedAt: iso(s.endedAt),
    endReason: s.endReason,
    createdAt: isoReq(s.createdAt),
    updatedAt: isoReq(s.updatedAt),
    stats: lineStats(lines),
    lines: lines.map((l) => ({
      id: l.id,
      batch: l.batch,
      status: l.status,
      to: l.toNumber,
      prospect: l.prospectId ? (pm.get(l.prospectId) ?? { id: l.prospectId, name: null, title: null, phone: null, account: null }) : null,
      callId: l.callId,
      taskId: l.taskId,
      callbackTaskId: l.callbackTaskId,
      answeredBy: l.answeredBy,
      skipReason: l.skipReason,
      endReason: l.endReason,
      answeredAt: iso(l.answeredAt),
      connectedAt: iso(l.connectedAt),
      endedAt: iso(l.endedAt),
      durationSeconds: l.durationSeconds,
      createdAt: isoReq(l.createdAt),
    })),
    ...(extra.connectParams ? { connectParams: extra.connectParams } : {}),
  };
}

/* ---------------------------------------------------------------- starting */

export interface StartDialSessionInput {
  /** browser: the rep joins through the Voice SDK; phone: the carrier rings the rep first. */
  repMode?: 'browser' | 'phone';
  repPhone?: string;
  fromNumber?: string;
  ownerId?: string;
  maxLines?: number;
  autoDial?: boolean;
  prospectIds?: string[];
  taskIds?: string[];
}

/**
 * Open a session. Refuses until an admin has confirmed the compliance mode. Browser mode returns
 * `connectParams` for `device.connect()`; phone mode rings the rep now. Prospects passed here are
 * queued (and preflighted) but nothing is dialed until the rep is in the room and asks for a batch.
 */
export async function startDialSession(ctx: Ctx, input: StartDialSessionInput, d: DialerDeps): Promise<DialSessionView> {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const settings = await getParallelSettings(ctx);
  if (!settings.confirmed) throw unprocessable('An admin must confirm the parallel dialer compliance mode (B2B or consumer) under Settings → Dialer before sessions can start', { code: 'COMPLIANCE_UNCONFIRMED' });
  const c = await carrierFor(ctx, d);
  const repMode = input.repMode ?? (c.softphone ? 'browser' : 'phone');
  if (repMode === 'browser' && !c.softphone) throw unprocessable('Browser mode needs a Twilio API key pair and TwiML App SID under Settings → Dialer; use repMode "phone"', { code: 'NO_SOFTPHONE' });
  const ownerId = await resolveOwner(ctx, [input.ownerId, ctx.principal.userId]);
  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ownerId)).limit(1);
  let repPhone: string | null = null;
  if (repMode === 'phone') {
    repPhone = normalizePhone(input.repPhone ?? owner?.phone ?? null);
    if (!repPhone) throw unprocessable('Phone mode needs your phone number: pass repPhone or set it on your profile', { field: 'repPhone' });
  }
  const from = normalizePhone(input.fromNumber ?? c.fromNumbers[0] ?? null);
  if (!from) throw unprocessable('No caller id: add a Twilio number under Settings → Dialer (or TWILIO_FROM_NUMBER)', { field: 'fromNumber' });
  const open = await ctx.db.select({ id: dialSessions.id }).from(dialSessions).where(and(eq(dialSessions.workspaceId, ws), eq(dialSessions.ownerId, ownerId), inArray(dialSessions.status, [...OPEN_SESSION]))).limit(1);
  if (open.length) throw conflict('You already have an open dial session; end it first', { sessionId: open[0]!.id });
  const maxLines = Math.min(settings.maxAllowedLines, Math.max(1, input.maxLines ?? settings.maxLines));
  const id = uuidv7(now.getTime());
  const conferenceName = `cooks-${id}`;
  const [row] = await ctx.db
    .insert(dialSessions)
    .values({
      id,
      workspaceId: ws,
      ownerId,
      provider: 'twilio',
      status: 'waiting_rep',
      repMode,
      repPhone,
      fromNumber: from,
      conferenceName,
      maxLines,
      complianceMode: settings.complianceMode,
      autoDial: input.autoDial ?? false,
      options: { amd: settings.amd, ringTimeoutSeconds: settings.ringTimeoutSeconds, onUnknown: settings.onUnknown, abandonedCallMessage: settings.abandonedCallMessage, record: c.record },
      lastActivityAt: now,
    })
    .returning();
  const session = row!;
  if (repMode === 'phone') {
    try {
      const leg = await c.carrier.dialRep({ to: repPhone!, from, conference: conferenceName, callbacks: { voiceUrl: cb(d, 'rep/voice', { ws, session: id }), statusUrl: cb(d, 'rep/status', { ws, session: id }) } });
      await ctx.db.update(dialSessions).set({ repCallSid: leg.providerCallId, ...touch(now) }).where(eq(dialSessions.id, id));
    } catch (e) {
      const msg = e instanceof DialerError ? e.message : (e as Error).message;
      await ctx.db.update(dialSessions).set({ status: 'ended', endedAt: now, endReason: `rep_dial_failed: ${msg}`, ...touch(now) }).where(eq(dialSessions.id, id));
      throw unprocessable(`Could not ring your phone: ${msg}`, { code: e instanceof DialerError ? e.code : 'REP_DIAL_FAILED' });
    }
  }
  if (input.prospectIds?.length || input.taskIds?.length) await queueDialLines(ctx, id, { prospectIds: input.prospectIds, taskIds: input.taskIds });
  const fresh = await sessionRow(ctx, id);
  return viewOf(ctx, fresh, repMode === 'browser' ? { connectParams: { kind: 'parallel', sessionId: id, ws } } : {});
}

async function resolveOwner(ctx: Ctx, candidates: Array<string | null | undefined>) {
  for (const c of candidates) if (c) return requireMember(ctx, c, 'ownerId');
  const [first] = await memberIds(ctx);
  if (!first) throw unprocessable('ownerId is required');
  return first;
}

/* ----------------------------------------------------------------- queueing */

export interface QueueLinesInput {
  prospectIds?: string[];
  taskIds?: string[];
}

/**
 * Add prospects to the session. Each one is preflighted: no phone, do-not-call (flag or
 * disposition), outside 08:00–21:00 local, or already in the session → stored as `skipped`
 * with the reason so the rep sees why, and never dialed.
 */
export async function queueDialLines(ctx: Ctx, sessionId: string, input: QueueLinesInput): Promise<DialSessionView> {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const s = await sessionRow(ctx, sessionId);
  if (s.status === 'ended') throw conflict('This dial session has ended');
  const [w] = await ctx.db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ws)).limit(1);
  const [owner] = await ctx.db.select({ timezone: users.timezone }).from(users).where(eq(users.id, s.ownerId)).limit(1);
  const existing = await ctx.db.select({ prospectId: dialLines.prospectId, status: dialLines.status }).from(dialLines).where(eq(dialLines.sessionId, s.id));
  const already = new Set(existing.filter((l) => l.status === 'queued' || (LIVE_LINE as readonly string[]).includes(l.status)).map((l) => l.prospectId));
  const targets: Array<{ prospectId: string; taskId: string | null }> = [];
  for (const tid of input.taskIds ?? []) {
    const [t] = await ctx.db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.id, uuidOr404(tid, 'Task')))).limit(1);
    if (!t) throw notFound('Task');
    if (!t.prospectId) throw unprocessable(`Task ${tid} has no prospect`, { field: 'taskIds' });
    targets.push({ prospectId: t.prospectId, taskId: t.id });
  }
  for (const pid of input.prospectIds ?? []) if (!targets.some((t) => t.prospectId === pid)) targets.push({ prospectId: uuidOr404(pid, 'Prospect'), taskId: null });
  if (!targets.length) throw unprocessable('Pass prospectIds or taskIds', { field: 'prospectIds' });
  const rows: Array<typeof dialLines.$inferInsert> = [];
  for (const t of targets) {
    const [p] = await ctx.db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), eq(prospects.id, t.prospectId), isNull(prospects.deletedAt))).limit(1);
    if (!p) throw unprocessable(`Prospect ${t.prospectId} not found in this workspace`, { field: 'prospectIds' });
    const [a] = p.accountId ? await ctx.db.select({ timezone: accounts.timezone }).from(accounts).where(eq(accounts.id, p.accountId)).limit(1) : [];
    const to = normalizePhone(p.phone);
    let skip: string | null = null;
    if (already.has(p.id)) skip = 'duplicate';
    else if (!to) skip = 'no_phone';
    else if (p.doNotContact || (await dncOutcome(ctx, p.id))) skip = 'do_not_call';
    else if (!withinCallHours(now, pickZone(p.timezone, a?.timezone, owner?.timezone, w?.settings.timezone))) skip = 'quiet_hours';
    if (!skip) already.add(p.id);
    rows.push({ workspaceId: ws, sessionId: s.id, batch: 0, prospectId: p.id, taskId: t.taskId, toNumber: to, status: skip ? 'skipped' : 'queued', skipReason: skip });
  }
  await ctx.db.insert(dialLines).values(rows);
  await ctx.db.update(dialSessions).set(touch(now)).where(eq(dialSessions.id, s.id));
  return viewOf(ctx, await sessionRow(ctx, s.id));
}

/* ------------------------------------------------------------------ dialing */

export interface DialBatchInput extends QueueLinesInput {
  /** Lines for this batch (defaults to the session's maxLines). */
  lines?: number;
}

/**
 * Dial the next batch. The rep must be in the room and no conversation may be live. Consumer
 * mode drops to one line while the 30-day abandonment rate is at or above the 3% safe harbor.
 */
export async function dialNextBatch(ctx: Ctx, sessionId: string, input: DialBatchInput, d: DialerDeps): Promise<DialSessionView> {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  let s = await sessionRow(ctx, sessionId);
  if (s.status === 'ended') throw conflict('This dial session has ended', { code: 'SESSION_ENDED' });
  if (s.status === 'waiting_rep') throw unprocessable(s.repMode === 'browser' ? 'Join the session from the browser first (connect the Voice SDK with connectParams)' : 'Answer the call on your phone first', { code: 'REP_NOT_JOINED' });
  if (s.status === 'connected') throw conflict('A conversation is live; hang up or log it before dialing the next batch', { code: 'LINE_CONNECTED' });
  if (s.status === 'dialing') throw conflict('A batch is already ringing', { code: 'BATCH_IN_PROGRESS' });
  if (input.prospectIds?.length || input.taskIds?.length) {
    await queueDialLines(ctx, s.id, input);
    s = await sessionRow(ctx, s.id);
  }
  const c = await carrierFor(ctx, d);
  let n = Math.min(s.maxLines, Math.max(1, input.lines ?? s.maxLines));
  if (s.complianceMode === 'consumer') {
    const rate = await abandonmentStats(ctx, 30);
    if (rate.ratePct !== null && rate.ratePct >= rate.safeHarborMaxPct) n = 1;
  }
  const queued = await ctx.db.select().from(dialLines).where(and(eq(dialLines.sessionId, s.id), eq(dialLines.status, 'queued'))).orderBy(dialLines.createdAt).limit(n);
  if (!queued.length) throw unprocessable('No prospects queued; add some with prospectIds or taskIds', { code: 'NO_QUEUED_LINES' });
  // Leftovers from an earlier batch that never settled must not win later.
  const stale = await ctx.db.select().from(dialLines).where(and(eq(dialLines.sessionId, s.id), inArray(dialLines.status, [...RACING_LINE])));
  for (const l of stale) await settleLine(ctx, l, 'canceled', 'superseded', now, c).catch(() => undefined);
  const batch = s.batch + 1;
  await ctx.db.update(dialSessions).set({ batch, status: 'dialing', connectedLineId: null, connectedAt: null, ...touch(now) }).where(eq(dialSessions.id, s.id));
  const opts = s.options as { amd?: Record<string, unknown>; ringTimeoutSeconds?: number };
  await Promise.all(
    queued.map(async (l) => {
      const [t] = l.taskId ? await ctx.db.select().from(tasks).where(eq(tasks.id, l.taskId)).limit(1) : [];
      const [p] = l.prospectId ? await ctx.db.select({ accountId: prospects.accountId }).from(prospects).where(eq(prospects.id, l.prospectId)).limit(1) : [];
      const [call] = await ctx.db
        .insert(calls)
        .values({
          workspaceId: ws,
          prospectId: l.prospectId,
          accountId: p?.accountId ?? null,
          ownerId: s.ownerId,
          sequenceId: t?.sequenceId ?? null,
          sequenceStateId: t?.sequenceStateId ?? null,
          sequenceStepId: t?.sequenceStepId ?? null,
          taskId: l.taskId,
          source: t ? 'sequence' : 'dialer',
          direction: 'outbound',
          fromNumber: s.fromNumber,
          toNumber: l.toNumber,
          status: 'initiated',
          time: now,
          provider: 'twilio',
          mode: 'parallel',
        })
        .returning();
      try {
        const leg = await c.carrier.dialProspect({
          lineId: l.id,
          to: l.toNumber!,
          from: s.fromNumber,
          ringTimeoutSeconds: opts.ringTimeoutSeconds ?? 25,
          amd: opts.amd ?? {},
          callbacks: { voiceUrl: cb(d, 'prospect/voice', { ws, session: s.id, line: l.id }), statusUrl: cb(d, 'prospect/status', { ws, session: s.id, line: l.id }), amdUrl: cb(d, 'prospect/amd', { ws, session: s.id, line: l.id }) },
        });
        await ctx.db.update(dialLines).set({ status: 'dialing', batch, callId: call!.id, providerCallSid: leg.providerCallId, updatedAt: now }).where(eq(dialLines.id, l.id));
        await ctx.db.update(calls).set({ providerCallSid: leg.providerCallId, status: 'ringing', updatedAt: now }).where(eq(calls.id, call!.id));
      } catch (e) {
        const msg = e instanceof DialerError ? e.message : (e as Error).message;
        await ctx.db.update(dialLines).set({ status: 'failed', batch, callId: call!.id, endReason: `dial_failed: ${msg}`, endedAt: now, updatedAt: now }).where(eq(dialLines.id, l.id));
        await ctx.db.update(calls).set({ status: 'failed', notes: msg, endedAt: now, updatedAt: now }).where(eq(calls.id, call!.id));
      }
    }),
  );
  await afterLineSettled(ctx, s.id, d);
  return viewOf(ctx, await sessionRow(ctx, s.id));
}

/* ------------------------------------------------------------- the winner */

/**
 * The atomic claim. Only a session that is still `dialing` with an empty winner slot for this
 * batch can be claimed, and Postgres evaluates the WHERE under the row lock, so concurrent
 * callers see exactly one returned row between them.
 */
async function claimWinner(ctx: Ctx, s: DialSessionRow, line: DialLineRow, now: Date): Promise<boolean> {
  const won = await ctx.db
    .update(dialSessions)
    .set({ connectedLineId: line.id, connectedAt: now, status: 'connected', ...touch(now) })
    .where(and(eq(dialSessions.id, s.id), isNull(dialSessions.connectedLineId), eq(dialSessions.status, 'dialing'), eq(dialSessions.batch, line.batch)))
    .returning({ id: dialSessions.id });
  return won.length === 1;
}

async function connectWinner(ctx: Ctx, s: DialSessionRow, line: DialLineRow, now: Date, c: Carrier, d: DialerDeps) {
  await ctx.db.update(dialLines).set({ status: 'connected', connectedAt: now, updatedAt: now }).where(eq(dialLines.id, line.id));
  if (line.callId) {
    await ctx.db.update(calls).set({ status: 'in_progress', time: now, amdResult: line.answeredBy, updatedAt: now }).where(eq(calls.id, line.callId));
    await emitEvent(ctx.db, { workspaceId: s.workspaceId, type: 'call.started', aggregateType: 'call', aggregateId: line.callId, payload: { callId: line.callId, prospectId: line.prospectId, ownerId: s.ownerId, dialSessionId: s.id }, dedupeKey: `${line.callId}:started` });
  }
  const siblings = await ctx.db.select().from(dialLines).where(and(eq(dialLines.sessionId, s.id), eq(dialLines.batch, line.batch), inArray(dialLines.status, [...RACING_LINE])));
  const others = siblings.filter((x) => x.id !== line.id);
  // Bridge the winner and drop every sibling at the same time: the rep hears the prospect as
  // early as possible and no sibling human is left waiting.
  // Siblings still ringing are canceled now; the callee never knows. A sibling that has already picked
  // up keeps its silent hold until AMD answers (a few seconds at most): a machine becomes a voicemail hit,
  // a person is dropped with the notice and a callback task. Hanging up blind would count every fast
  // answering machine as an abandoned person.
  const results = await Promise.allSettled([
    c.carrier.joinConference(line.providerCallSid!, s.conferenceName, { statusCallback: cb(d, 'conference', { ws: s.workspaceId, session: s.id }), label: `line:${line.id}` }),
    ...others.filter((x) => x.status !== 'answered').map((x) => settleLine(ctx, x, 'canceled', 'sibling_connected', now, c)),
  ]);
  if (results[0]!.status === 'rejected') {
    // The bridge failed: free the slot so another human can still win, and let the rep know.
    const msg = (results[0] as PromiseRejectedResult).reason instanceof Error ? ((results[0] as PromiseRejectedResult).reason as Error).message : 'join failed';
    await ctx.db.update(dialLines).set({ status: 'failed', endReason: `join_failed: ${msg}`, endedAt: now, updatedAt: now }).where(eq(dialLines.id, line.id));
    if (line.callId) await ctx.db.update(calls).set({ status: 'failed', notes: msg, endedAt: now, updatedAt: now }).where(eq(calls.id, line.callId));
    await ctx.db.update(dialSessions).set({ connectedLineId: null, connectedAt: null, status: 'ready', ...touch(now) }).where(eq(dialSessions.id, s.id));
    return;
  }
  if (c.record && s.repCallSid && line.callId) {
    const rec = await c.carrier.startRecording(s.repCallSid, `${d.publicUrl.replace(/\/+$/, '')}/telephony/recording?ws=${s.workspaceId}&call=${line.callId}`).catch(() => null);
    if (rec) await ctx.db.update(dialLines).set({ recordingSid: rec, updatedAt: now }).where(eq(dialLines.id, line.id));
  }
}

/**
 * A human answered but another line already won: hang up now (consumer mode plays the
 * seller-identification message first) and leave the rep a high-priority callback task.
 */
async function dropLine(ctx: Ctx, s: DialSessionRow, line: DialLineRow, reason: string, now: Date, c: Carrier) {
  const opts = s.options as { abandonedCallMessage?: string | null };
  if (line.providerCallSid) {
    if (s.complianceMode === 'consumer' && opts.abandonedCallMessage) await c.carrier.sayAndHangup(line.providerCallSid, opts.abandonedCallMessage).catch(() => c.carrier.hangupLeg(line.providerCallSid!, 'answered').catch(() => undefined));
    else await c.carrier.hangupLeg(line.providerCallSid, 'answered').catch(() => undefined);
  }
  let callbackTaskId: string | null = null;
  if (line.prospectId) {
    const t = await createTask(ctx, {
      action: 'call',
      dueAt: new Date(now.getTime() + CALLBACK_MINUTES * 60_000).toISOString(),
      ownerId: s.ownerId,
      prospectId: line.prospectId,
      priority: 'high',
      note: reason === 'late_answer' ? 'Answered a parallel dial after another call connected first. Call back.' : 'Picked up during a parallel dial while another call connected first. Call back and apologise for the dropped call.',
    }).catch(() => null);
    callbackTaskId = t?.id ?? null;
  }
  await ctx.db.update(dialLines).set({ status: 'dropped', endReason: reason, endedAt: now, callbackTaskId, updatedAt: now }).where(eq(dialLines.id, line.id));
  if (line.callId) await ctx.db.update(calls).set({ status: 'abandoned', outcome: null, endReason: reason, amdResult: line.answeredBy, endedAt: now, notes: 'Dropped: another line connected first', updatedAt: now }).where(eq(calls.id, line.callId));
}

/** Hang up a leg that is still in the race and record why. */
async function settleLine(ctx: Ctx, line: DialLineRow, status: string, reason: string, now: Date, c: Carrier) {
  await ctx.db.update(dialLines).set({ status, endReason: reason, endedAt: now, updatedAt: now }).where(eq(dialLines.id, line.id));
  if (line.callId) await ctx.db.update(calls).set({ status: status === 'canceled' ? 'canceled' : status, endReason: reason, endedAt: now, updatedAt: now }).where(eq(calls.id, line.callId));
  if (line.providerCallSid) await c.carrier.hangupLeg(line.providerCallSid, line.status === 'answered' ? 'answered' : 'ringing');
}

/** Machine, fax or unresolved: hang up, mark the line, and (optionally) log the call as not reached. */
async function finishNotHuman(ctx: Ctx, s: DialSessionRow, line: DialLineRow, status: 'voicemail' | 'no_answer' | 'failed', now: Date, c: Carrier) {
  if (line.providerCallSid) await c.carrier.hangupLeg(line.providerCallSid, 'answered').catch(() => undefined);
  await ctx.db.update(dialLines).set({ status, endReason: line.answeredBy ?? status, endedAt: now, updatedAt: now }).where(eq(dialLines.id, line.id));
  if (line.callId) {
    await ctx.db.update(calls).set({ status, outcome: status === 'voicemail' ? 'voicemail' : status === 'no_answer' ? 'no_answer' : 'failed', amdResult: line.answeredBy, endReason: line.answeredBy ?? status, endedAt: now, updatedAt: now }).where(eq(calls.id, line.callId));
    if (status !== 'failed') await autoLog(ctx, line.callId, status === 'voicemail' ? 'left_voicemail_detected' : 'no_answer');
  }
}

/** Dispositions for unattended outcomes. Voicemail hits log as "No answer" (nothing was left). */
async function autoLog(ctx: Ctx, callId: string, kind: 'left_voicemail_detected' | 'no_answer' | 'busy') {
  const outcome = kind === 'busy' ? 'busy' : 'no_answer';
  await logCall(ctx, callId, { outcome, notes: kind === 'left_voicemail_detected' ? 'Answering machine detected by the parallel dialer; no message left.' : undefined }).catch(() => undefined);
}

/**
 * After any line settles: when no line in the current batch is still racing or connected, the
 * session is ready again; with autoDial on and prospects left, the next batch goes out.
 */
async function afterLineSettled(ctx: Ctx, sessionId: string, d: DialerDeps) {
  const s = await sessionRow(ctx, sessionId);
  if (s.status !== 'dialing' && s.status !== 'connected' && s.status !== 'wrapping') return;
  const live = await ctx.db.select({ id: dialLines.id, status: dialLines.status }).from(dialLines).where(and(eq(dialLines.sessionId, s.id), eq(dialLines.batch, s.batch), inArray(dialLines.status, [...LIVE_LINE])));
  if (live.length) return;
  const now = ctx.clock.now();
  if (s.status === 'dialing' || s.status === 'wrapping') {
    await ctx.db.update(dialSessions).set({ status: s.status === 'wrapping' ? 'wrapping' : 'ready', ...touch(now) }).where(eq(dialSessions.id, s.id));
    if (s.autoDial && s.status === 'dialing') {
      const [q] = await ctx.db.select({ id: dialLines.id }).from(dialLines).where(and(eq(dialLines.sessionId, s.id), eq(dialLines.status, 'queued'))).limit(1);
      if (q) await dialNextBatch(ctx, s.id, {}, d).catch(() => undefined);
    }
  }
}

/* ----------------------------------------------------------------- webhooks */

/** Rep leg (phone mode) answered, or the browser leg hit the TwiML App: join the room and wait in silence. */
export async function parallelRepVoice(ctx: Ctx, sessionId: string, params: Record<string, string>, d: DialerDeps): Promise<string> {
  const s = await sessionRow(ctx, sessionId).catch(() => null);
  if (!s || s.status === 'ended') return hangupTwiml('This dial session has ended.');
  const c = await carrierOrNull(ctx, d);
  if (!c) return hangupTwiml('Telephony is not configured.');
  const now = ctx.clock.now();
  await ctx.db.update(dialSessions).set({ repCallSid: params.CallSid ?? s.repCallSid, status: s.status === 'waiting_rep' ? 'ready' : s.status, repJoinedAt: s.repJoinedAt ?? now, ...touch(now) }).where(eq(dialSessions.id, s.id));
  return c.carrier.repJoinDocument(s.conferenceName, { statusCallback: cb(d, 'conference', { ws: s.workspaceId, session: s.id }), label: 'rep' });
}

const TERMINAL = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);

/** Rep leg progress (phone mode). The rep leaving ends the session. */
export async function parallelRepStatus(ctx: Ctx, sessionId: string, params: Record<string, string>, d: DialerDeps) {
  const s = await sessionRow(ctx, sessionId);
  const st = params.CallStatus ?? '';
  if (!(await recordDialEvent(ctx, s.id, `rep:${params.CallSid ?? 'rep'}:status:${st}`, 'rep.status', params))) return { duplicate: true };
  if (TERMINAL.has(st) && s.status !== 'ended') await endDialSession(ctx, s.id, d, st === 'completed' ? 'rep_left' : `rep_${st.replace('-', '_')}`);
  return { sessionId: s.id, status: st };
}

/** Conference lifecycle: start/end and participant join/leave, with Twilio's SequenceNumber as the dedupe key. */
export async function parallelConferenceEvent(ctx: Ctx, sessionId: string, params: Record<string, string>, d: DialerDeps) {
  const s = await sessionRow(ctx, sessionId);
  const ev = params.StatusCallbackEvent ?? '';
  const key = `conf:${params.ConferenceSid ?? s.conferenceName}:${params.SequenceNumber ?? `${ev}:${params.CallSid ?? ''}`}`;
  if (!(await recordDialEvent(ctx, s.id, key, `conference.${ev}`, params))) return { duplicate: true };
  const now = ctx.clock.now();
  const patch: Partial<typeof dialSessions.$inferInsert> = {};
  if (params.ConferenceSid && !s.conferenceSid) patch.conferenceSid = params.ConferenceSid;
  const label = params.ParticipantLabel ?? '';
  if (ev === 'conference-start' || (ev === 'participant-join' && label === 'rep')) {
    if (s.status === 'waiting_rep') patch.status = 'ready';
    patch.repJoinedAt = s.repJoinedAt ?? now;
    if (params.CallSid && label === 'rep') patch.repCallSid = params.CallSid;
  }
  if (Object.keys(patch).length) await ctx.db.update(dialSessions).set({ ...patch, ...touch(now) }).where(eq(dialSessions.id, s.id));
  if (ev === 'conference-end' || (ev === 'participant-leave' && label === 'rep')) {
    if (s.status !== 'ended') await endDialSession(ctx, s.id, d, 'rep_left');
  }
  return { sessionId: s.id, event: ev };
}

/**
 * A prospect leg answered and Twilio wants TwiML. While AMD is still deciding we hold the leg in
 * silence. If the race is already over (another line won, or the session moved on) we hang up
 * right away instead of making a possible human wait for a verdict that no longer matters.
 */
export async function parallelProspectVoice(ctx: Ctx, sessionId: string, lineId: string, params: Record<string, string>, d: DialerDeps): Promise<string> {
  const s = await sessionRow(ctx, sessionId).catch(() => null);
  const line = await lineRow(ctx, lineId).catch(() => null);
  const c = await carrierOrNull(ctx, d);
  if (!s || !line || !c) return hangupTwiml();
  const now = ctx.clock.now();
  if (params.CallSid && !line.providerCallSid) await ctx.db.update(dialLines).set({ providerCallSid: params.CallSid, updatedAt: now }).where(eq(dialLines.id, line.id));
  // A leg we already settled (canceled sibling, dropped, voicemail) that the carrier still connects: hang up, no hold.
  if (!(RACING_LINE as readonly string[]).includes(line.status)) return hangupTwiml();
  // The session has moved on (batch superseded or ended): nobody will ever read this leg's verdict.
  if (s.status === 'ended' || line.batch !== s.batch) {
    const opts = s.options as { abandonedCallMessage?: string | null };
    await ctx.db.update(dialLines).set({ status: 'answered', answeredAt: now, updatedAt: now }).where(eq(dialLines.id, line.id));
    await dropLine(ctx, s, { ...line, status: 'answered', providerCallSid: null }, 'late_answer', now, c);
    return s.complianceMode === 'consumer' && opts.abandonedCallMessage ? hangupTwiml(opts.abandonedCallMessage) : hangupTwiml();
  }
  // Otherwise hold in silence even when another line already won: the AMD verdict decides whether this
  // is a voicemail (hang up, log) or a person (drop with notice + callback task).
  if (line.status === 'dialing' || line.status === 'ringing') await ctx.db.update(dialLines).set({ status: 'answered', answeredAt: now, updatedAt: now }).where(eq(dialLines.id, line.id));
  await ctx.db.update(dialSessions).set(touch(now)).where(eq(dialSessions.id, s.id));
  const amd = (s.options as { amd?: { timeoutSeconds?: number } }).amd;
  return c.carrier.prospectHoldDocument((amd?.timeoutSeconds ?? 5) + HOLD_GRACE_SECONDS);
}

/** Async AMD verdict for one leg. This is where "first human wins" happens. */
export async function parallelAmd(ctx: Ctx, sessionId: string, lineId: string, params: Record<string, string>, d: DialerDeps) {
  const s = await sessionRow(ctx, sessionId);
  const line = await lineRow(ctx, lineId);
  const answeredBy = (params.AnsweredBy ?? 'unknown').toLowerCase();
  if (!(await recordDialEvent(ctx, s.id, `amd:${params.CallSid ?? line.providerCallSid ?? line.id}`, 'prospect.amd', params))) return { duplicate: true, lineId: line.id };
  const now = ctx.clock.now();
  if (!(RACING_LINE as readonly string[]).includes(line.status)) return { lineId: line.id, ignored: line.status };
  await ctx.db.update(dialLines).set({ answeredBy, amdAt: now, status: 'answered', answeredAt: line.answeredAt ?? now, providerCallSid: line.providerCallSid ?? params.CallSid ?? null, updatedAt: now }).where(eq(dialLines.id, line.id));
  const fresh = await lineRow(ctx, line.id);
  const c = await carrierFor(ctx, d);
  const opts = s.options as { onUnknown?: 'hangup' | 'connect' };
  const human = answeredBy === 'human' || (answeredBy === 'unknown' && opts.onUnknown === 'connect');
  let result: string;
  if (human) {
    if (await claimWinner(ctx, s, fresh, now)) {
      await connectWinner(ctx, s, fresh, now, c, d);
      result = 'connected';
    } else {
      await dropLine(ctx, s, fresh, 'second_human', now, c);
      result = 'dropped';
    }
  } else if (answeredBy.startsWith('machine')) {
    await finishNotHuman(ctx, s, fresh, 'voicemail', now, c);
    result = 'voicemail';
  } else if (answeredBy === 'fax') {
    await finishNotHuman(ctx, s, fresh, 'failed', now, c);
    result = 'fax';
  } else {
    await finishNotHuman(ctx, s, fresh, 'no_answer', now, c);
    result = 'unknown';
  }
  await afterLineSettled(ctx, s.id, d);
  return { lineId: line.id, answeredBy, result };
}

/** Prospect leg progress. Terminal states close the line (and the conversation when it was the winner). */
export async function parallelProspectStatus(ctx: Ctx, sessionId: string, lineId: string, params: Record<string, string>, d: DialerDeps) {
  const s = await sessionRow(ctx, sessionId);
  const line = await lineRow(ctx, lineId);
  const st = params.CallStatus ?? '';
  if (!(await recordDialEvent(ctx, s.id, `line:${params.CallSid ?? line.providerCallSid ?? line.id}:status:${st}`, 'prospect.status', params))) return { duplicate: true, lineId: line.id };
  const now = ctx.clock.now();
  const sid = line.providerCallSid ?? params.CallSid ?? null;
  if (!line.providerCallSid && sid) await ctx.db.update(dialLines).set({ providerCallSid: sid, updatedAt: now }).where(eq(dialLines.id, line.id));
  if ((st === 'ringing' || st === 'initiated') && line.status === 'dialing') {
    await ctx.db.update(dialLines).set({ status: 'ringing', updatedAt: now }).where(eq(dialLines.id, line.id));
    return { lineId: line.id, status: 'ringing' };
  }
  if (st === 'in-progress') {
    if (line.status === 'dialing' || line.status === 'ringing') await ctx.db.update(dialLines).set({ status: 'answered', answeredAt: now, updatedAt: now }).where(eq(dialLines.id, line.id));
    return { lineId: line.id, status: 'answered' };
  }
  if (!TERMINAL.has(st)) return { lineId: line.id, ignored: st };
  const dur = Number(params.CallDuration ?? 0);
  const duration = Number.isNaN(dur) ? null : dur;
  const c = await carrierOrNull(ctx, d);
  if (line.status === 'connected') {
    await ctx.db.update(dialLines).set({ status: 'completed', endReason: st, endedAt: now, durationSeconds: duration, updatedAt: now }).where(eq(dialLines.id, line.id));
    if (line.callId) {
      await ctx.db.update(calls).set({ status: 'completed', outcome: 'answered', endedAt: now, ...(duration ? { durationSeconds: duration } : {}), updatedAt: now }).where(eq(calls.id, line.callId));
      await emitEvent(ctx.db, { workspaceId: s.workspaceId, type: 'call.completed', aggregateType: 'call', aggregateId: line.callId, payload: { callId: line.callId, prospectId: line.prospectId, ownerId: s.ownerId, status: 'completed', durationSeconds: duration, dialSessionId: s.id }, dedupeKey: `${line.callId}:completed` });
    }
    if (c && s.repCallSid) await c.carrier.stopRecording(s.repCallSid, line.recordingSid).catch(() => undefined);
    if (s.connectedLineId === line.id) await ctx.db.update(dialSessions).set({ status: 'wrapping', ...touch(now) }).where(eq(dialSessions.id, s.id));
  } else if ((RACING_LINE as readonly string[]).includes(line.status)) {
    const map: Record<string, string> = { 'no-answer': 'no_answer', busy: 'busy', failed: 'failed', canceled: 'canceled', completed: line.answeredBy ? 'no_answer' : 'completed' };
    const status = map[st] ?? st;
    await ctx.db.update(dialLines).set({ status, endReason: status === 'completed' ? 'ended_before_verdict' : st, endedAt: now, durationSeconds: duration, updatedAt: now }).where(eq(dialLines.id, line.id));
    if (line.callId) {
      await ctx.db.update(calls).set({ status, outcome: status === 'no_answer' ? 'no_answer' : status === 'busy' || status === 'failed' ? 'failed' : null, endReason: st, endedAt: now, ...(duration ? { durationSeconds: duration } : {}), updatedAt: now }).where(eq(calls.id, line.callId));
      if (status === 'no_answer' || status === 'busy') await autoLog(ctx, line.callId, status);
    }
  } else {
    // dropped / voicemail / canceled: just record the final duration.
    await ctx.db.update(dialLines).set({ endedAt: line.endedAt ?? now, durationSeconds: duration ?? line.durationSeconds, updatedAt: now }).where(eq(dialLines.id, line.id));
  }
  await afterLineSettled(ctx, s.id, d);
  return { lineId: line.id, status: st };
}

/* ----------------------------------------------------------- rep controls */

/** The rep ends the live conversation but stays in the room for the next batch. */
export async function hangupConnectedLine(ctx: Ctx, sessionId: string, d: DialerDeps) {
  const s = await sessionRow(ctx, sessionId);
  if (!s.connectedLineId) throw conflict('No conversation is live', { code: 'NO_LIVE_LINE' });
  const line = await lineRow(ctx, s.connectedLineId);
  const c = await carrierFor(ctx, d);
  if (line.providerCallSid && line.status === 'connected') await c.carrier.hangupLeg(line.providerCallSid, 'answered');
  return { sessionId: s.id, lineId: line.id, hangingUp: true };
}

/** Flip auto-dial or the batch size mid-session. */
export async function updateDialSession(ctx: Ctx, sessionId: string, patch: { autoDial?: boolean; maxLines?: number }) {
  const s = await sessionRow(ctx, sessionId);
  if (s.status === 'ended') throw conflict('This dial session has ended');
  const settings = await getParallelSettings(ctx);
  await ctx.db
    .update(dialSessions)
    .set({ ...(patch.autoDial !== undefined ? { autoDial: patch.autoDial } : {}), ...(patch.maxLines !== undefined ? { maxLines: Math.min(settings.maxAllowedLines, Math.max(1, patch.maxLines)) } : {}), updatedAt: ctx.clock.now() })
    .where(eq(dialSessions.id, s.id));
  return viewOf(ctx, await sessionRow(ctx, s.id));
}

/** Hang up every live leg, close the room, mark the session ended. Safe to call twice. */
export async function endDialSession(ctx: Ctx, sessionId: string, d: DialerDeps, reason = 'ended_by_rep'): Promise<DialSessionView> {
  const s = await sessionRow(ctx, sessionId);
  if (s.status === 'ended') return viewOf(ctx, s);
  const now = ctx.clock.now();
  const c = await carrierOrNull(ctx, d);
  const live = await ctx.db.select().from(dialLines).where(and(eq(dialLines.sessionId, s.id), inArray(dialLines.status, [...LIVE_LINE])));
  await Promise.allSettled(
    live.map(async (l) => {
      if (l.status === 'connected') {
        await ctx.db.update(dialLines).set({ status: 'completed', endReason: reason, endedAt: now, updatedAt: now }).where(eq(dialLines.id, l.id));
        if (l.callId) await ctx.db.update(calls).set({ status: 'completed', outcome: 'answered', endedAt: now, updatedAt: now }).where(eq(calls.id, l.callId));
        if (c && l.providerCallSid) await c.carrier.hangupLeg(l.providerCallSid, 'answered').catch(() => undefined);
      } else if (c) await settleLine(ctx, l, 'canceled', reason, now, c).catch(() => undefined);
      else await ctx.db.update(dialLines).set({ status: 'canceled', endReason: reason, endedAt: now, updatedAt: now }).where(eq(dialLines.id, l.id));
    }),
  );
  await ctx.db.update(dialLines).set({ status: 'skipped', skipReason: 'session_ended', updatedAt: now }).where(and(eq(dialLines.sessionId, s.id), eq(dialLines.status, 'queued')));
  if (c) {
    if (s.conferenceSid) await c.carrier.endConference(s.conferenceSid).catch(() => undefined);
    else if (s.repCallSid && s.repMode === 'phone') await c.carrier.hangupLeg(s.repCallSid, 'answered').catch(() => undefined);
    else if (s.repCallSid) await c.carrier.hangupLeg(s.repCallSid, 'unknown').catch(() => undefined);
  }
  const lines = await ctx.db.select().from(dialLines).where(eq(dialLines.sessionId, s.id));
  await ctx.db.update(dialSessions).set({ status: 'ended', endedAt: now, endReason: reason, stats: lineStats(lines), ...touch(now) }).where(eq(dialSessions.id, s.id));
  return viewOf(ctx, await sessionRow(ctx, s.id));
}

/* ------------------------------------------------------------------ reading */

export async function getDialSession(ctx: Ctx, sessionId: string): Promise<DialSessionView> {
  return viewOf(ctx, await sessionRow(ctx, sessionId));
}

export async function listDialSessions(ctx: Ctx, opts: { ownerId?: string; open?: boolean; limit?: number } = {}) {
  const ws = ctx.principal.workspaceId;
  const where = [eq(dialSessions.workspaceId, ws)];
  if (opts.ownerId) where.push(eq(dialSessions.ownerId, opts.ownerId));
  if (opts.open) where.push(inArray(dialSessions.status, [...OPEN_SESSION]));
  const rows = await ctx.db.select().from(dialSessions).where(and(...where)).orderBy(desc(dialSessions.createdAt)).limit(Math.min(100, opts.limit ?? 20));
  return Promise.all(rows.map((r) => viewOf(ctx, r)));
}

/** The open session for the signed-in rep (the Power Dialer page resumes it on reload). */
export async function currentDialSession(ctx: Ctx): Promise<DialSessionView | null> {
  const owner = ctx.principal.userId;
  const where = [eq(dialSessions.workspaceId, ctx.principal.workspaceId), inArray(dialSessions.status, [...OPEN_SESSION])];
  if (owner) where.push(eq(dialSessions.ownerId, owner));
  const [row] = await ctx.db.select().from(dialSessions).where(and(...where)).orderBy(desc(dialSessions.createdAt)).limit(1);
  return row ? viewOf(ctx, row) : null;
}

/**
 * FTC safe harbor (16 CFR 310.4(b)(4)(i)): abandoned calls must stay under 3% of calls answered
 * by a person over 30 days. Numerator: lines dropped after a human answered. Denominator: lines a
 * human answered. Consumer-mode sessions fall back to one line when the rate is at the cap.
 */
export async function abandonmentStats(ctx: Ctx, days = 30) {
  const since = new Date(ctx.clock.now().getTime() - days * 86_400_000);
  const rows = await ctx.db
    .select({ status: dialLines.status, answeredBy: dialLines.answeredBy, endReason: dialLines.endReason })
    .from(dialLines)
    .where(and(eq(dialLines.workspaceId, ctx.principal.workspaceId), gte(dialLines.createdAt, since), inArray(dialLines.status, ['connected', 'completed', 'dropped'])));
  let humansAnswered = 0;
  let dropped = 0;
  for (const r of rows) {
    if (r.status === 'dropped') {
      dropped += 1;
      humansAnswered += 1; // a dropped line is counted as a human whether AMD got to decide or not
    } else if (r.answeredBy === 'human' || r.status === 'completed' || r.status === 'connected') humansAnswered += 1;
  }
  const ratePct = humansAnswered ? Math.round((dropped / humansAnswered) * 10_000) / 100 : null;
  return { windowDays: days, humansAnswered, dropped, ratePct, safeHarborMaxPct: 3 };
}

/* -------------------------------------------------------------------- sweep */

/**
 * Worker safety net (every minute): close sessions idle for two hours and settle legs the
 * carrier never reported on. Runs across workspaces with a per-workspace carrier.
 */
export async function sweepDialSessions(db: Db, deps: TelephonyDeps & { publicUrl: string }, now = new Date()) {
  const idleBefore = new Date(now.getTime() - SESSION_IDLE_MINUTES * 60_000);
  const stale = await db.select().from(dialSessions).where(and(inArray(dialSessions.status, [...OPEN_SESSION]), lt(dialSessions.lastActivityAt, idleBefore)));
  let ended = 0;
  for (const s of stale) {
    const ctx: Ctx = { db, principal: systemPrincipal(s.workspaceId), jobs: { send: async () => null }, clock: { now: () => now }, traceId: 'sweep', publicUrl: deps.publicUrl };
    await endDialSession(ctx, s.id, deps, 'idle_timeout').catch(() => undefined);
    ended += 1;
  }
  // Legs still "racing" long after any ring timeout: the carrier lost the callback.
  const stuckBefore = new Date(now.getTime() - 3 * 60_000);
  const stuck = await db.select().from(dialLines).where(and(inArray(dialLines.status, [...RACING_LINE]), lt(dialLines.updatedAt, stuckBefore)));
  let settled = 0;
  for (const l of stuck) {
    const ctx: Ctx = { db, principal: systemPrincipal(l.workspaceId), jobs: { send: async () => null }, clock: { now: () => now }, traceId: 'sweep', publicUrl: deps.publicUrl };
    const c = await carrierOrNull(ctx, deps);
    if (c) await settleLine(ctx, l, 'failed', 'timeout', now, c).catch(() => undefined);
    else await db.update(dialLines).set({ status: 'failed', endReason: 'timeout', endedAt: now, updatedAt: now }).where(eq(dialLines.id, l.id));
    await afterLineSettled(ctx, l.sessionId, deps).catch(() => undefined);
    settled += 1;
  }
  return { ended, settled };
}

/** Exposed for the settings page and MCP: hours in which lines may be dialed. */
export const PARALLEL_CALL_HOURS = CALL_HOURS;
