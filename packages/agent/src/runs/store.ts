import { createHash } from 'node:crypto';
import { and, eq, gte, sql } from 'drizzle-orm';
import { agentRunLogs, agentRuns, aiCache, type DbOrTx } from '@cooks/db';
import type { TokenUsage } from '../providers/types.js';

export type RunKind = 'draft_email' | 'classify_reply' | 'research' | 'nba' | 'agent_loop' | 'mcp_tool_call';
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'needs_review';

export function inputHash(kind: string, model: string, version: number, input: unknown): string {
  return createHash('sha256').update(`${kind}|${model}|${version}|${canonical(input)}`).digest('hex');
}

function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : val));
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;

/** Mask emails and phone numbers before persisting prompt inputs. */
export function redact<T>(v: T): T {
  const s = JSON.stringify(v);
  if (!s) return v;
  const masked = s.replace(EMAIL_RE, (m) => `email:${createHash('sha256').update(m.toLowerCase()).digest('hex').slice(0, 8)}`).replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? 'phone:***' : m));
  return JSON.parse(masked) as T;
}

export async function startRun(db: DbOrTx, a: { workspaceId: string; kind: RunKind; agentId?: string | null; provider: string; model: string; parentType?: string; parentId?: string; input: unknown; inputHash: string; logRaw: boolean; now: Date }) {
  const [row] = await db
    .insert(agentRuns)
    .values({
      workspaceId: a.workspaceId,
      kind: a.kind,
      agentId: a.agentId ?? null,
      provider: a.provider,
      model: a.model,
      status: 'running',
      parentType: a.parentType ?? null,
      parentId: a.parentId ?? null,
      inputHash: a.inputHash,
      inputRedacted: (a.logRaw ? a.input : redact(a.input)) as Record<string, unknown>,
      startedAt: a.now,
    })
    .returning({ id: agentRuns.id });
  return row!.id;
}

export async function finishRun(db: DbOrTx, id: string, a: { status: RunStatus; output?: unknown; usage?: TokenUsage; latencyMs?: number; error?: string; model?: string; now: Date }) {
  await db
    .update(agentRuns)
    .set({
      status: a.status,
      output: (a.output ?? null) as Record<string, unknown> | null,
      ...(a.usage ? { tokensIn: a.usage.input, tokensOut: a.usage.output, tokensCacheRead: a.usage.cacheRead, tokensCacheWrite: a.usage.cacheWrite, costUsd: a.usage.costUsd === null ? null : String(a.usage.costUsd) } : {}),
      ...(a.latencyMs !== undefined ? { latencyMs: a.latencyMs } : {}),
      ...(a.model ? { model: a.model } : {}),
      error: a.error ?? null,
      finishedAt: a.now,
    })
    .where(eq(agentRuns.id, id));
}

export async function log(db: DbOrTx, runId: string, line: string, data?: Record<string, unknown>, level = 'info') {
  const [{ n }] = (await db.select({ n: sql<number>`coalesce(max(${agentRunLogs.seq}), 0)` }).from(agentRunLogs).where(eq(agentRunLogs.runId, runId))) as [{ n: number }];
  await db.insert(agentRunLogs).values({ runId, seq: Number(n) + 1, level, line, data: data ?? null });
}

export async function cacheGet<T>(db: DbOrTx, kind: string, model: string, version: number, hash: string, now: Date): Promise<T | null> {
  const [row] = await db
    .select()
    .from(aiCache)
    .where(and(eq(aiCache.kind, kind), eq(aiCache.model, model), eq(aiCache.promptVersion, version), eq(aiCache.inputHash, hash)))
    .limit(1);
  if (!row || (row.expiresAt && row.expiresAt < now)) return null;
  return row.output as T;
}

export async function cachePut(db: DbOrTx, kind: string, model: string, version: number, hash: string, output: unknown, ttlMs: number | null, now: Date) {
  await db
    .insert(aiCache)
    .values({ kind, model, promptVersion: version, inputHash: hash, output: output as Record<string, unknown>, expiresAt: ttlMs ? new Date(now.getTime() + ttlMs) : null })
    .onConflictDoUpdate({ target: [aiCache.kind, aiCache.model, aiCache.promptVersion, aiCache.inputHash], set: { output: output as Record<string, unknown>, expiresAt: ttlMs ? new Date(now.getTime() + ttlMs) : null } });
}

/** Spend this calendar month (UTC) for budget checks. */
export async function monthSpendUsd(db: DbOrTx, workspaceId: string, now: Date): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)` })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, workspaceId), gte(agentRuns.createdAt, start)));
  return Number(row?.total ?? 0);
}
