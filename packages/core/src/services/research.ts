import { and, desc, eq, ne } from 'drizzle-orm';
import { signals } from '@cooks/db';
import type { Ctx } from '../context.js';
import { getProspectRow } from './prospects.js';
import { getAccountRow } from './accounts.js';
import { isoReq } from './_shared.js';

export const RESEARCH_SUMMARY_KIND = 'research.summary';

/** Latest brief + the individual signals it produced, for the API and the UI. */
export async function getProspectResearch(ctx: Ctx, prospectId: string) {
  const p = await getProspectRow(ctx, prospectId);
  const [summary] = await ctx.db
    .select()
    .from(signals)
    .where(and(eq(signals.workspaceId, ctx.principal.workspaceId), eq(signals.prospectId, p.id), eq(signals.kind, RESEARCH_SUMMARY_KIND)))
    .orderBy(desc(signals.createdAt))
    .limit(1);
  if (!summary) return { status: 'none' as const, prospectId: p.id };
  const items = await ctx.db
    .select()
    .from(signals)
    .where(and(eq(signals.workspaceId, ctx.principal.workspaceId), eq(signals.prospectId, p.id), ne(signals.kind, RESEARCH_SUMMARY_KIND)))
    .orderBy(desc(signals.occurredAt))
    .limit(20);
  const pl = summary.payload as { summary: string; talkingPoints: string[]; confidence: number; citations?: Array<{ url: string; title?: string }>; runId?: string };
  return {
    status: 'ready' as const,
    prospectId: p.id,
    researchedAt: isoReq(summary.createdAt),
    source: summary.source,
    runId: pl.runId ?? null,
    summary: pl.summary,
    talkingPoints: pl.talkingPoints,
    confidence: pl.confidence,
    citations: pl.citations ?? [],
    signals: items.filter((s) => s.kind.startsWith('research.')).map((s) => ({ id: s.id, kind: s.kind.replace(/^research\./, ''), ...(s.payload as { text: string; sourceUrl: string | null; date: string | null }), occurredAt: isoReq(s.occurredAt) })),
  };
}

/** Queue a research run; the worker performs it. */
export async function requestResearch(ctx: Ctx, prospectId: string, opts: { focus?: string; force?: boolean }) {
  const p = await getProspectRow(ctx, prospectId);
  const jobId = await ctx.jobs.send('ai.research', { prospectId: p.id, workspaceId: ctx.principal.workspaceId, focus: opts.focus ?? null, force: !!opts.force }, { singletonKey: `research:${p.id}` });
  return { queued: jobId !== null, prospectId: p.id };
}

/** Queue an account-level signal scan; the worker performs it with the workspace AI provider. */
export async function requestAccountScan(ctx: Ctx, accountId: string, opts: { focus?: string; force?: boolean } = {}) {
  const a = await getAccountRow(ctx, accountId);
  const jobId = await ctx.jobs.send('signals.scan', { accountId: a.id, workspaceId: ctx.principal.workspaceId, focus: opts.focus ?? null, force: !!opts.force }, { singletonKey: `scan:${a.id}` });
  return { queued: jobId !== null, accountId: a.id };
}
