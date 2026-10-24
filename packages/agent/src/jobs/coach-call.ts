/**
 * Recording → transcript → coaching for one call.
 *  1. download the dual-channel WAV from Twilio
 *  2. transcribe each channel (rep / prospect) through an OpenAI-compatible whisper endpoint
 *  3. store the merged transcript with talk statistics
 *  4. ask the workspace model for a scorecard (contracts/coach-call)
 */
import { desc, eq } from 'drizzle-orm';
import { accounts, callDispositions, callTranscripts, calls, coachingScores, prospects, sequenceSteps, users, type DbOrTx } from '@cooks/db';
import { systemPrincipal, telephonyFor, type Ctx, type JobsPort, type TelephonyDeps } from '@cooks/core';
import { resolveAiConfig, type EnvKeys } from '../config.js';
import { providerFor } from '../providers/registry.js';
import type { LlmProvider } from '../providers/types.js';
import { COACH_CALL_SYSTEM, COACH_CALL_VERSION, CoachCallOutput, coachCallUserPrompt, type CoachCallInput } from '../contracts/coach-call.js';
import { runStructured } from '../run-structured.js';
import { activityRatio, mergeSegments, splitChannels, talkStats, transcribeWav, transcriptText, type TranscribeConfig, type TranscriptSegment } from '../transcribe.js';

export interface TranscribeEnv {
  TRANSCRIBE_API_BASE?: string;
  TRANSCRIBE_API_KEY?: string;
  TRANSCRIBE_MODEL?: string;
}

export interface CoachDeps {
  db: DbOrTx;
  env: EnvKeys & TranscribeEnv;
  now: () => Date;
  publicUrl: string;
  telephony: TelephonyDeps;
  jobs?: JobsPort;
  transcribeFetch?: typeof fetch;
  providerOverride?: LlmProvider;
}

export const COACH_RUBRIC = 'cooks.coach.v1';

const ctxFor = (d: CoachDeps, workspaceId: string): Ctx => ({ db: d.db, principal: systemPrincipal(workspaceId), jobs: d.jobs ?? { send: async () => null }, clock: { now: d.now }, traceId: 'coach', publicUrl: d.publicUrl });

/** Speech-to-text config: explicit TRANSCRIBE_* env, else the workspace's OpenAI key, else the server OpenAI key. */
export async function resolveTranscribeConfig(d: CoachDeps, workspaceId: string): Promise<TranscribeConfig | null> {
  const model = d.env.TRANSCRIBE_MODEL ?? 'whisper-1';
  if (d.env.TRANSCRIBE_API_BASE) return { apiBase: d.env.TRANSCRIBE_API_BASE, apiKey: d.env.TRANSCRIBE_API_KEY, model, fetchImpl: d.transcribeFetch };
  const cfg = await resolveAiConfig(d.db, workspaceId, d.env);
  if (cfg?.provider === 'openai' && cfg.apiKey) return { apiBase: cfg.baseUrl ?? 'https://api.openai.com/v1', apiKey: cfg.apiKey, model, fetchImpl: d.transcribeFetch };
  if (d.env.OPENAI_API_KEY) return { apiBase: 'https://api.openai.com/v1', apiKey: d.env.OPENAI_API_KEY, model, fetchImpl: d.transcribeFetch };
  return null;
}

export type RecordingResult = { status: 'ok'; callId: string; transcript: 'ready' | 'kept'; coaching: 'ready' | 'skipped' | 'failed'; reason?: string } | { status: 'skipped' | 'failed'; callId: string; reason: string };

/** Worker entry for `telephony.recording`. Idempotent: an existing transcript is reused unless `force`. */
export async function processCallRecording(d: CoachDeps, callId: string, opts: { force?: boolean } = {}): Promise<RecordingResult> {
  const [c] = await d.db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  if (!c) return { status: 'skipped', callId, reason: 'call not found' };
  if (!c.recordingSid) return { status: 'skipped', callId, reason: 'no recording' };
  const ctx = ctxFor(d, c.workspaceId);
  const tel = await telephonyFor(ctx, d.telephony);
  if (!tel) return { status: 'skipped', callId, reason: 'telephony disconnected' };
  const [existing] = await d.db.select().from(callTranscripts).where(eq(callTranscripts.callId, c.id)).orderBy(desc(callTranscripts.createdAt)).limit(1);
  let transcript: 'ready' | 'kept' = 'kept';
  if (!existing || opts.force) {
    const stt = await resolveTranscribeConfig(d, c.workspaceId);
    if (!stt) {
      await d.db.update(calls).set({ transcriptStatus: 'skipped', coachingStatus: 'skipped', updatedAt: d.now() }).where(eq(calls.id, c.id));
      return { status: 'skipped', callId, reason: 'no transcription provider: set TRANSCRIBE_API_BASE or an OpenAI key' };
    }
    await d.db.update(calls).set({ transcriptStatus: 'running', updatedAt: d.now() }).where(eq(calls.id, c.id));
    try {
      const wav = await tel.client.recordingWav(c.recordingSid);
      const { left, right, durationSeconds, info } = splitChannels(wav);
      const stereo = info.channels >= 2 && activityRatio(right) > 0.01;
      let segs: TranscriptSegment[];
      if (stereo) {
        const [rep, pro] = await Promise.all([transcribeWav(stt, left, { filename: 'rep.wav' }), transcribeWav(stt, right, { filename: 'prospect.wav' })]);
        segs = mergeSegments(rep, pro);
      } else {
        // Mono recording: no speaker separation. Everything is attributed to the rep channel.
        segs = (await transcribeWav(stt, left, { filename: 'call.wav' })).map((s) => ({ ...s, speaker: 'rep' as const }));
      }
      const stats = { ...talkStats(segs, durationSeconds || c.recordingDurationSeconds || c.durationSeconds), stereo };
      if (existing && opts.force) await d.db.delete(callTranscripts).where(eq(callTranscripts.id, existing.id));
      await d.db.insert(callTranscripts).values({ workspaceId: c.workspaceId, callId: c.id, provider: `${stt.model}@${new URL(stt.apiBase).host}`, segments: segs, text: transcriptText(segs), stats });
      await d.db.update(calls).set({ transcriptStatus: 'ready', updatedAt: d.now() }).where(eq(calls.id, c.id));
      transcript = 'ready';
    } catch (e) {
      await d.db.update(calls).set({ transcriptStatus: 'failed', coachingStatus: 'skipped', notes: c.notes, updatedAt: d.now() }).where(eq(calls.id, c.id));
      return { status: 'failed', callId, reason: `transcription: ${(e as Error).message}` };
    }
  }
  if (!tel.row.coach) {
    await d.db.update(calls).set({ coachingStatus: 'skipped', updatedAt: d.now() }).where(eq(calls.id, c.id));
    return { status: 'ok', callId, transcript, coaching: 'skipped', reason: 'coaching disabled' };
  }
  const coached = await coachCall(d, c.id, { force: opts.force });
  return { status: 'ok', callId, transcript, coaching: coached.status === 'ok' ? 'ready' : coached.status === 'skipped' ? 'skipped' : 'failed', reason: 'reason' in coached ? coached.reason : undefined };
}

/** Score an already-transcribed call. Worker entry for `ai.coach_call`; also used right after transcription. */
export async function coachCall(d: CoachDeps, callId: string, opts: { force?: boolean } = {}): Promise<{ status: 'ok'; runId: string | null; output: CoachCallOutput } | { status: 'skipped' | 'failed'; reason: string }> {
  const [c] = await d.db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  if (!c) return { status: 'skipped', reason: 'call not found' };
  const [tr] = await d.db.select().from(callTranscripts).where(eq(callTranscripts.callId, c.id)).orderBy(desc(callTranscripts.createdAt)).limit(1);
  if (!tr || !tr.text) return { status: 'skipped', reason: 'no transcript' };
  if (!opts.force) {
    const [prev] = await d.db.select({ id: coachingScores.id }).from(coachingScores).where(eq(coachingScores.callId, c.id)).limit(1);
    if (prev) return { status: 'skipped', reason: 'already coached' };
  }
  const cfg = await resolveAiConfig(d.db, c.workspaceId, d.env);
  if (!cfg) {
    await d.db.update(calls).set({ coachingStatus: 'skipped', updatedAt: d.now() }).where(eq(calls.id, c.id));
    return { status: 'skipped', reason: 'no AI provider configured' };
  }
  const provider = d.providerOverride ?? providerFor(cfg, 'general');
  await d.db.update(calls).set({ coachingStatus: 'running', updatedAt: d.now() }).where(eq(calls.id, c.id));
  const [p] = c.prospectId ? await d.db.select().from(prospects).where(eq(prospects.id, c.prospectId)).limit(1) : [];
  const [a] = c.accountId ? await d.db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, c.accountId)).limit(1) : [];
  const [u] = c.ownerId ? await d.db.select({ name: users.name }).from(users).where(eq(users.id, c.ownerId)).limit(1) : [];
  const [disp] = c.callDispositionId ? await d.db.select({ name: callDispositions.name }).from(callDispositions).where(eq(callDispositions.id, c.callDispositionId)).limit(1) : [];
  const [step] = c.sequenceStepId ? await d.db.select({ name: sequenceSteps.name }).from(sequenceSteps).where(eq(sequenceSteps.id, c.sequenceStepId)).limit(1) : [];
  // Practice calls have no CRM prospect; the AI partner's persona stands in.
  const persona = (c.aiConfig as { practice?: { persona?: { name?: string; title?: string; company?: string } } } | null)?.practice?.persona;
  const input: CoachCallInput = {
    transcript: tr.text.length > 14_000 ? `${tr.text.slice(0, 14_000)}\n[... transcript truncated ...]` : tr.text,
    stats: tr.stats as unknown as CoachCallInput['stats'],
    prospect: { name: p?.name ?? persona?.name ?? null, title: p?.title ?? persona?.title ?? null, company: a?.name ?? persona?.company ?? null },
    rep: { name: u?.name ?? null },
    callDurationSeconds: c.durationSeconds || c.recordingDurationSeconds || 0,
    disposition: disp?.name ?? null,
    sequenceStep: step?.name ?? null,
  };
  const out = await runStructured(
    { db: d.db, workspaceId: c.workspaceId, cfg, provider, now: d.now },
    { kind: 'coach_call', version: COACH_CALL_VERSION, system: COACH_CALL_SYSTEM, input, userPrompt: coachCallUserPrompt, schema: CoachCallOutput, schemaName: 'call_coaching', effort: 'medium', maxTokens: 3000, cacheTtlMs: null, parentType: 'call', parentId: c.id },
    (o) => (o.confidence < 0.3 ? 'very low confidence' : null),
  );
  if (out.status !== 'ok' && out.status !== 'needs_review') {
    await d.db.update(calls).set({ coachingStatus: out.status === 'budget_exceeded' ? 'skipped' : 'failed', updatedAt: d.now() }).where(eq(calls.id, c.id));
    return { status: out.status === 'budget_exceeded' ? 'skipped' : 'failed', reason: out.status === 'budget_exceeded' ? 'monthly AI budget reached' : out.status === 'refused' ? out.reason : out.error };
  }
  const sc = out.value.scores;
  const avg = Math.round(((sc.opener + sc.discovery + sc.listening + sc.valueArticulation + sc.objectionHandling + sc.nextStepClarity) / 6) * 100) / 100;
  if (opts.force) await d.db.delete(coachingScores).where(eq(coachingScores.callId, c.id));
  await d.db.insert(coachingScores).values({ workspaceId: c.workspaceId, callId: c.id, rubric: COACH_RUBRIC, score: String(avg), feedback: { ...out.value, runId: out.runId, needsReview: out.status === 'needs_review' }, model: provider.model });
  await d.db.update(callTranscripts).set({ summary: out.value.summary, updatedAt: d.now() }).where(eq(callTranscripts.id, tr.id));
  await d.db.update(calls).set({ coachingStatus: 'ready', updatedAt: d.now() }).where(eq(calls.id, c.id));
  return { status: 'ok', runId: out.runId, output: out.value };
}
