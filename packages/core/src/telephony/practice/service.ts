/**
 * Practice calls are ordinary call records (`source = practice`), so the call page, the coaching
 * job, webhooks and the MCP insight tools work on them unchanged. Starting one mints a short-lived
 * socket token; ending one writes the transcript and queues coaching like a recorded call.
 */
import { and, eq } from 'drizzle-orm';
import { accounts, callTranscripts, calls, prospects, users, workspaces, type Db } from '@cooks/db';
import type { Ctx } from '../../context.js';
import { notFound, unprocessable } from '../../errors.js';
import { emitEvent } from '../../events.js';
import { uuidOr404 } from '../../services/_shared.js';
import { serializeCall, type CallRow } from '../../services/calls.js';
import { fullName } from '../../services/prospects.js';
import { transcriptStats } from '../ai-call.js';
import { getTelephony } from '../connection.js';
import { mintStreamToken } from '../speech/token.js';
import { PRACTICE_MAX_SECONDS_DEFAULT, practiceStatus } from './factory.js';
import { PRACTICE_SCENARIOS, partnerInstructions, partnerOpening, practiceScenario, scenarioFromProspect, type PracticeScenario } from './scenarios.js';
import type { PracticeConfig } from './types.js';

export const PRACTICE_LINE = 'practice';
export const PRACTICE_TOKEN_TTL_SECONDS = 300;
export const PRACTICE_IN_RATE = 16_000;

export interface PracticeTranscriptEntry {
  index: number;
  role: 'rep' | 'prospect';
  text: string;
  startedAt: string;
  endedAt?: string;
}

/** Stored on the call row (`ai_config.practice`); never credentials. */
export interface PracticeAiConfig {
  scenarioId: string;
  title: string;
  brief: string;
  persona: PracticeScenario['persona'];
  difficulty: PracticeScenario['difficulty'];
  instructions: string;
  opening: string;
  voice?: string;
  provider: string;
}

export interface PracticeDeps {
  kek?: string;
  practice?: PracticeConfig;
}

export type PracticeCallRow = Omit<CallRow, 'aiConfig'> & { aiConfig: { practice?: PracticeAiConfig } | null };

export const listPracticeScenarios = () => PRACTICE_SCENARIOS.map(({ id, title, brief, persona, difficulty }) => ({ id, title, brief, persona, difficulty }));

export async function loadPracticeCall(ctx: Ctx, id: string): Promise<PracticeCallRow> {
  const [row] = await ctx.db
    .select()
    .from(calls)
    .where(and(eq(calls.id, uuidOr404(id, 'practice session')), eq(calls.workspaceId, ctx.principal.workspaceId)))
    .limit(1);
  if (!row || row.source !== 'practice') throw notFound('practice session');
  return row as PracticeCallRow;
}

export async function startPractice(ctx: Ctx, input: { scenarioId?: string; prospectId?: string }, d: PracticeDeps) {
  const status = practiceStatus(d.practice);
  if (!status.configured) throw unprocessable(status.reason ?? 'Practice is not configured');
  const ws = ctx.principal.workspaceId;
  let scenario: PracticeScenario | null = null;
  let prospectId: string | null = null;
  let accountId: string | null = null;
  if (input.prospectId) {
    const [p] = await ctx.db
      .select()
      .from(prospects)
      .where(and(eq(prospects.id, uuidOr404(input.prospectId, 'prospect')), eq(prospects.workspaceId, ws)))
      .limit(1);
    if (!p) throw notFound('prospect');
    const [a] = p.accountId ? await ctx.db.select({ name: accounts.name, industry: accounts.industry }).from(accounts).where(eq(accounts.id, p.accountId)).limit(1) : [];
    scenario = scenarioFromProspect({ name: fullName(p.firstName, p.lastName, p.name) ?? 'the prospect', title: p.title }, a ?? null);
    prospectId = p.id;
    accountId = p.accountId ?? null;
  } else {
    scenario = practiceScenario(input.scenarioId ?? PRACTICE_SCENARIOS[0]!.id);
    if (!scenario) throw unprocessable(`Unknown scenario "${input.scenarioId}"`, { scenarios: PRACTICE_SCENARIOS.map((s) => s.id) });
  }
  const [u] = ctx.principal.userId ? await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, ctx.principal.userId)).limit(1) : [];
  const [w] = await ctx.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ws)).limit(1);
  const now = ctx.clock.now();
  const practice: PracticeAiConfig = {
    scenarioId: scenario.id,
    title: scenario.title,
    brief: scenario.brief,
    persona: scenario.persona,
    difficulty: scenario.difficulty,
    instructions: partnerInstructions(scenario, { name: u?.name ?? null, company: w?.name ?? null }),
    opening: partnerOpening(scenario),
    voice: d.practice?.voice,
    provider: d.practice?.provider ?? 'off',
  };
  const [row] = await ctx.db
    .insert(calls)
    .values({
      workspaceId: ws,
      prospectId,
      accountId,
      ownerId: ctx.principal.userId,
      source: 'practice',
      direction: 'outbound',
      mode: 'practice',
      provider: practice.provider,
      status: 'in_progress',
      time: now,
      transcript: [],
      aiConfig: { practice },
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  const token = mintStreamToken(d.kek ?? 'cooks-dev', { ws, session: row!.id, line: PRACTICE_LINE, exp: Math.floor(now.getTime() / 1000) + PRACTICE_TOKEN_TTL_SECONDS });
  return {
    callId: row!.id,
    token,
    workspaceId: ws,
    streamPath: '/practice/stream',
    sampleRate: PRACTICE_IN_RATE,
    maxSeconds: d.practice?.maxSeconds ?? PRACTICE_MAX_SECONDS_DEFAULT,
    scenario: { id: scenario.id, title: scenario.title, brief: scenario.brief, persona: scenario.persona, difficulty: scenario.difficulty },
    opening: practice.opening,
    call: serializeCall(row!),
  };
}

/** The socket writes the running transcript so nothing is lost if the browser disappears. */
export async function appendPracticeTranscript(db: Db, callId: string, entries: PracticeTranscriptEntry[]) {
  await db.update(calls).set({ transcript: entries, updatedAt: new Date() }).where(and(eq(calls.id, callId), eq(calls.status, 'in_progress')));
}

export async function endPractice(ctx: Ctx, id: string, opts: { endReason?: string; transcript?: PracticeTranscriptEntry[] } = {}) {
  const row = await loadPracticeCall(ctx, id);
  if (row.status !== 'in_progress') return serializeCall(row as unknown as CallRow);
  const entries = (opts.transcript ?? (row.transcript as PracticeTranscriptEntry[] | null) ?? []).filter((e) => e.text?.trim());
  const now = ctx.clock.now();
  const duration = Math.max(0, Math.round((now.getTime() - row.time.getTime()) / 1000));
  const t0 = entries[0]?.startedAt ? new Date(entries[0].startedAt).getTime() : row.time.getTime();
  const sec = (iso: string | undefined) => (iso ? Math.max(0, (new Date(iso).getTime() - t0) / 1000) : 0);
  const segments = entries.map((e) => ({ speaker: e.role === 'rep' ? ('rep' as const) : ('prospect' as const), start: sec(e.startedAt), end: sec(e.endedAt ?? e.startedAt), text: e.text.trim() }));
  const tel = await getTelephony(ctx).catch(() => null);
  const coach = tel ? tel.coach : true;
  await ctx.db
    .update(calls)
    .set({
      status: 'completed',
      outcome: 'answered',
      endedAt: now,
      endReason: opts.endReason ?? 'stop',
      durationSeconds: duration,
      transcript: entries,
      transcriptStatus: entries.length ? 'ready' : 'none',
      coachingStatus: coach && entries.length ? 'queued' : 'none',
      updatedAt: now,
    })
    .where(eq(calls.id, row.id));
  if (entries.length) {
    await ctx.db.delete(callTranscripts).where(eq(callTranscripts.callId, row.id));
    await ctx.db.insert(callTranscripts).values({
      workspaceId: row.workspaceId,
      callId: row.id,
      provider: `practice:${row.provider ?? 'partner'}`,
      segments,
      text: segments.map((s) => `${s.speaker === 'rep' ? 'Rep' : 'Prospect'}: ${s.text}`).join('\n'),
      stats: { ...transcriptStats(segments), source: 'practice' },
    });
    if (coach) await ctx.jobs.send('ai.coach_call', { callId: row.id, workspaceId: row.workspaceId }, { singletonKey: `coach:${row.id}` });
  }
  await emitEvent(ctx.db, { workspaceId: row.workspaceId, type: 'call.completed', aggregateType: 'call', aggregateId: row.id, payload: { callId: row.id, practice: true, scenarioId: row.aiConfig?.practice?.scenarioId ?? null, durationSeconds: duration } });
  return serializeCall((await loadPracticeCall(ctx, row.id)) as unknown as CallRow);
}
