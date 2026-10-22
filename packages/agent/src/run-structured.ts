import type { z } from 'zod';
import type { DbOrTx } from '@cooks/db';
import type { LlmProvider, ResolvedAiConfig, StructuredResult } from './providers/types.js';
import { cacheGet, cachePut, finishRun, inputHash, monthSpendUsd, startRun, type RunKind } from './runs/store.js';

export interface StructuredJob<I, O> {
  kind: RunKind;
  version: number;
  system: string;
  input: I;
  userPrompt: (i: I) => string;
  schema: z.ZodType<O>;
  schemaName: string;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
  cacheTtlMs?: number | null;
  parentType?: string;
  parentId?: string;
  agentId?: string | null;
}

export type StructuredOutcome<O> =
  | { status: 'ok'; value: O; runId: string; cached: boolean }
  | { status: 'needs_review'; value: O; runId: string; reason: string }
  | { status: 'refused'; runId: string; reason: string }
  | { status: 'failed'; runId: string; error: string }
  | { status: 'budget_exceeded'; runId: null };

/**
 * One cached, budgeted, audited structured call. The `judge` decides whether the output is
 * safe to act on automatically or should go to a human (`needs_review`).
 */
export async function runStructured<I, O>(
  d: { db: DbOrTx; workspaceId: string; cfg: ResolvedAiConfig; provider: LlmProvider; now: () => Date; logRaw?: boolean },
  job: StructuredJob<I, O>,
  judge: (o: O) => string | null = () => null,
): Promise<StructuredOutcome<O>> {
  const now = d.now();
  if (d.cfg.monthlyBudgetUsd !== null && (await monthSpendUsd(d.db, d.workspaceId, now)) >= d.cfg.monthlyBudgetUsd) return { status: 'budget_exceeded', runId: null };
  const hash = inputHash(job.kind, d.provider.model, job.version, job.input);
  const runId = await startRun(d.db, { workspaceId: d.workspaceId, kind: job.kind, agentId: job.agentId, provider: d.provider.id, model: d.provider.model, parentType: job.parentType, parentId: job.parentId, input: job.input, inputHash: hash, logRaw: !!d.logRaw, now });
  if (job.cacheTtlMs !== null) {
    const hit = await cacheGet<O>(d.db, job.kind, d.provider.model, job.version, hash, now);
    if (hit) {
      await finishRun(d.db, runId, { status: 'succeeded', output: { ...(hit as object), _cached: true }, now: d.now() });
      return { status: 'ok', value: hit, runId, cached: true };
    }
  }
  let result: StructuredResult<O>;
  try {
    result = await d.provider.structured<O>({ system: job.system, user: job.userPrompt(job.input), schema: job.schema, schemaName: job.schemaName, effort: job.effort, maxTokens: job.maxTokens });
  } catch (e) {
    await finishRun(d.db, runId, { status: 'failed', error: (e as Error).message, now: d.now() });
    return { status: 'failed', runId, error: (e as Error).message };
  }
  if (result.kind === 'refusal') {
    await finishRun(d.db, runId, { status: 'failed', error: `refusal: ${result.reason}`, usage: result.usage, latencyMs: result.latencyMs, model: result.model, now: d.now() });
    return { status: 'refused', runId, reason: result.reason };
  }
  if (result.kind === 'invalid') {
    await finishRun(d.db, runId, { status: 'failed', error: `invalid output: ${result.error}`, output: { text: result.text.slice(0, 4000) }, usage: result.usage, latencyMs: result.latencyMs, model: result.model, now: d.now() });
    return { status: 'failed', runId, error: result.error };
  }
  const reason = judge(result.value);
  await finishRun(d.db, runId, { status: reason ? 'needs_review' : 'succeeded', output: result.value as object, usage: result.usage, latencyMs: result.latencyMs, model: result.model, now: d.now() });
  if (!reason && job.cacheTtlMs !== null && job.cacheTtlMs !== undefined) await cachePut(d.db, job.kind, d.provider.model, job.version, hash, result.value, job.cacheTtlMs, now);
  return reason ? { status: 'needs_review', value: result.value, runId, reason } : { status: 'ok', value: result.value, runId, cached: false };
}
