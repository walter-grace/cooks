import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import { agentRunLogs, agentRuns, workspaceAiSettings } from '@cooks/db';
import type { Ctx } from '../context.js';
import { encrypt } from '../crypto.js';
import { insufficientPermission, notFound, unprocessable } from '../errors.js';
import type { PageArgs } from '../pagination.js';
import { iso, isoReq, paginate, uuidOr404 } from './_shared.js';

export type AiProvider = 'anthropic' | 'openai' | 'xai' | 'openrouter' | 'ollama' | 'custom';

export function serializeRun(r: typeof agentRuns.$inferSelect) {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    provider: r.provider,
    model: r.model,
    agentId: r.agentId,
    parentType: r.parentType,
    parentId: r.parentId,
    tokensIn: r.tokensIn,
    tokensOut: r.tokensOut,
    tokensCacheRead: r.tokensCacheRead,
    costUsd: r.costUsd === null ? null : Number(r.costUsd),
    latencyMs: r.latencyMs,
    error: r.error,
    output: r.output,
    startedAt: iso(r.startedAt),
    finishedAt: iso(r.finishedAt),
    createdAt: isoReq(r.createdAt),
  };
}

export async function listAgentRuns(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; requestUrl: string }) {
  const f = q.filter ?? {};
  const conds: SQL[] = [eq(agentRuns.workspaceId, ctx.principal.workspaceId)];
  if (typeof f.kind === 'string' && f.kind) conds.push(eq(agentRuns.kind, f.kind as typeof agentRuns.$inferSelect.kind));
  if (typeof f.status === 'string' && f.status) conds.push(eq(agentRuns.status, f.status as typeof agentRuns.$inferSelect.status));
  const parent = (f.parent as Record<string, unknown> | undefined)?.id;
  if (typeof parent === 'string' && parent) conds.push(eq(agentRuns.parentId, parent));
  const page = await paginate({
    table: agentRuns,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(agentRuns)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: page.data.map(serializeRun), links: page.links };
}

export async function getAgentRun(ctx: Ctx, id: string) {
  uuidOr404(id, 'Agent run');
  const [row] = await ctx.db.select().from(agentRuns).where(and(eq(agentRuns.id, id), eq(agentRuns.workspaceId, ctx.principal.workspaceId))).limit(1);
  if (!row) throw notFound('Agent run');
  const logs = await ctx.db.select().from(agentRunLogs).where(eq(agentRunLogs.runId, id)).orderBy(agentRunLogs.seq);
  return { ...serializeRun(row), input: row.inputRedacted, logs: logs.map((l) => ({ seq: l.seq, at: l.at.toISOString(), level: l.level, line: l.line, data: l.data })) };
}

/** Spend and volume by day, provider, model and kind for the last N days. */
export async function agentRunStats(ctx: Ctx, days = 30) {
  const since = new Date(ctx.clock.now().getTime() - days * 86_400_000);
  const rows = await ctx.db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${agentRuns.createdAt}), 'YYYY-MM-DD')`,
      provider: agentRuns.provider,
      model: agentRuns.model,
      kind: agentRuns.kind,
      runs: sql<number>`count(*)`,
      succeeded: sql<number>`count(*) filter (where ${agentRuns.status} = 'succeeded')`,
      needsReview: sql<number>`count(*) filter (where ${agentRuns.status} = 'needs_review')`,
      failed: sql<number>`count(*) filter (where ${agentRuns.status} = 'failed')`,
      tokensIn: sql<number>`coalesce(sum(${agentRuns.tokensIn}), 0)`,
      tokensOut: sql<number>`coalesce(sum(${agentRuns.tokensOut}), 0)`,
      costUsd: sql<string>`coalesce(sum(${agentRuns.costUsd}), 0)`,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.workspaceId, ctx.principal.workspaceId), gte(agentRuns.createdAt, since)))
    .groupBy(sql`1`, agentRuns.provider, agentRuns.model, agentRuns.kind)
    .orderBy(desc(sql`1`));
  const total = rows.reduce((a, r) => a + Number(r.costUsd), 0);
  return {
    since: since.toISOString(),
    totalCostUsd: Math.round(total * 1e6) / 1e6,
    rows: rows.map((r) => ({ ...r, runs: Number(r.runs), succeeded: Number(r.succeeded), needsReview: Number(r.needsReview), failed: Number(r.failed), tokensIn: Number(r.tokensIn), tokensOut: Number(r.tokensOut), costUsd: Number(r.costUsd) })),
  };
}

export async function getAiSettings(ctx: Ctx) {
  const [row] = await ctx.db.select().from(workspaceAiSettings).where(eq(workspaceAiSettings.workspaceId, ctx.principal.workspaceId)).limit(1);
  return {
    provider: row?.provider ?? null,
    model: row?.model ?? null,
    baseUrl: row?.baseUrl ?? null,
    hasKey: !!row?.apiKeyCiphertext,
    keyLast4: row?.apiKeyLast4 ?? null,
    classifyModel: row?.classifyModel ?? null,
    draftModel: row?.draftModel ?? null,
    autoSendAiEmail: row?.autoSendAiEmail ?? false,
    confidenceThreshold: Number(row?.confidenceThreshold ?? 0.75),
    monthlyBudgetUsd: row?.monthlyBudgetUsd === null || row?.monthlyBudgetUsd === undefined ? null : Number(row.monthlyBudgetUsd),
  };
}

export interface AiSettingsInput {
  provider?: AiProvider;
  model?: string | null;
  baseUrl?: string | null;
  /** Stored encrypted; `null` clears it. Never returned. */
  apiKey?: string | null;
  classifyModel?: string | null;
  draftModel?: string | null;
  autoSendAiEmail?: boolean;
  confidenceThreshold?: number;
  monthlyBudgetUsd?: number | null;
}

export async function updateAiSettings(ctx: Ctx, input: AiSettingsInput, kek: string | undefined) {
  if (!ctx.principal.bypassRoleChecks && ctx.principal.role !== 'admin') throw insufficientPermission('Only admins can change AI settings');
  if (input.apiKey && !kek) throw unprocessable('Set COOKS_KEK on the server before storing provider keys');
  const set: Partial<typeof workspaceAiSettings.$inferInsert> = {
    ...(input.provider !== undefined ? { provider: input.provider } : {}),
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.apiKey !== undefined ? { apiKeyCiphertext: input.apiKey ? encrypt(input.apiKey, kek!) : null, apiKeyLast4: input.apiKey ? input.apiKey.slice(-4) : null } : {}),
    ...(input.classifyModel !== undefined ? { classifyModel: input.classifyModel } : {}),
    ...(input.draftModel !== undefined ? { draftModel: input.draftModel } : {}),
    ...(input.autoSendAiEmail !== undefined ? { autoSendAiEmail: input.autoSendAiEmail } : {}),
    ...(input.confidenceThreshold !== undefined ? { confidenceThreshold: String(input.confidenceThreshold) } : {}),
    ...(input.monthlyBudgetUsd !== undefined ? { monthlyBudgetUsd: input.monthlyBudgetUsd === null ? null : String(input.monthlyBudgetUsd) } : {}),
  };
  await ctx.db
    .insert(workspaceAiSettings)
    .values({ workspaceId: ctx.principal.workspaceId, provider: input.provider ?? 'anthropic', ...set })
    .onConflictDoUpdate({ target: workspaceAiSettings.workspaceId, set });
  return getAiSettings(ctx);
}
