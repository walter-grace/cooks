import { and, desc, eq } from 'drizzle-orm';
import { accounts, prospects, signals, type DbOrTx } from '@cooks/db';
import { resolveAiConfig, type EnvKeys } from '../config.js';
import { providerFor } from '../providers/registry.js';
import type { LlmProvider } from '../providers/types.js';
import { RESEARCH_SYSTEM, RESEARCH_VERSION, ResearchOutput, researchUserPrompt, type ResearchInput } from '../contracts/research.js';
import { runStructured } from '../run-structured.js';

export const RESEARCH_SUMMARY_KIND = 'research.summary';

export type ResearchResult =
  | { status: 'ok' | 'needs_review'; runId: string; output: ResearchOutput; citations: Array<{ url: string; title?: string }>; cached: boolean }
  | { status: 'skipped' | 'failed'; reason: string };

/**
 * Research a prospect + account with a web-grounded model call (OpenRouter `web` plugin,
 * or any provider the workspace configured). Results are stored as `signals` rows:
 * one `research.summary` plus one row per detected signal.
 */
export async function researchProspect(
  d: { db: DbOrTx; env: EnvKeys; now: () => Date; providerOverride?: LlmProvider },
  prospectId: string,
  opts: { focus?: string | null; force?: boolean } = {},
): Promise<ResearchResult> {
  const [p] = await d.db.select().from(prospects).where(eq(prospects.id, prospectId)).limit(1);
  if (!p) return { status: 'skipped', reason: 'prospect not found' };
  const [a] = p.accountId ? await d.db.select().from(accounts).where(eq(accounts.id, p.accountId)).limit(1) : [];
  const cfg = await resolveAiConfig(d.db, p.workspaceId, d.env);
  if (!cfg) return { status: 'skipped', reason: 'no AI provider configured' };
  const provider = d.providerOverride ?? providerFor(cfg, 'general');
  const now = d.now();
  const input: ResearchInput = {
    prospect: { name: p.name, title: p.title, linkedInUrl: p.linkedInUrl },
    account: a ? { name: a.name, domain: a.domain, industry: a.industry, description: a.description } : null,
    focus: opts.focus ?? null,
    today: now.toISOString().slice(0, 10),
  };
  const out = await runStructured(
    { db: d.db, workspaceId: p.workspaceId, cfg, provider, now: d.now },
    {
      kind: 'research',
      version: RESEARCH_VERSION,
      system: RESEARCH_SYSTEM,
      input,
      userPrompt: researchUserPrompt,
      schema: ResearchOutput,
      schemaName: 'research_brief',
      effort: 'medium',
      maxTokens: 2048,
      cacheTtlMs: opts.force ? null : 7 * 24 * 3600_000,
      parentType: 'prospect',
      parentId: prospectId,
      web: { maxResults: 6 },
      cacheKeyInput: { prospect: input.prospect, account: input.account, focus: input.focus },
    },
    (o) => (o.confidence < 0.3 ? 'very low confidence' : null),
  );
  if (out.status === 'budget_exceeded') return { status: 'skipped', reason: 'monthly AI budget reached' };
  if (out.status === 'refused' || out.status === 'failed') return { status: 'failed', reason: out.status === 'refused' ? out.reason : out.error };
  const citations = out.status === 'ok' ? (out.citations ?? []) : [];
  await d.db.insert(signals).values([
    { workspaceId: p.workspaceId, prospectId: p.id, accountId: p.accountId, kind: RESEARCH_SUMMARY_KIND, source: provider.id, payload: { ...out.value, citations, runId: out.runId }, score: String(out.value.confidence), occurredAt: now },
    ...out.value.signals.map((s) => ({ workspaceId: p.workspaceId, prospectId: p.id, accountId: p.accountId, kind: `research.${s.kind}`, source: s.sourceUrl ?? provider.id, payload: { text: s.text, sourceUrl: s.sourceUrl, date: s.date, runId: out.runId }, occurredAt: s.date && !Number.isNaN(Date.parse(s.date)) ? new Date(s.date) : now })),
  ]);
  return { status: out.status, runId: out.runId, output: out.value, citations, cached: out.status === 'ok' ? out.cached : false };
}

/** Latest stored brief for a prospect, if any. */
export async function latestResearch(db: DbOrTx, prospectId: string) {
  const [row] = await db
    .select()
    .from(signals)
    .where(and(eq(signals.prospectId, prospectId), eq(signals.kind, RESEARCH_SUMMARY_KIND)))
    .orderBy(desc(signals.createdAt))
    .limit(1);
  return row ? { ...(row.payload as ResearchOutput & { citations: Array<{ url: string; title?: string }>; runId: string }), researchedAt: row.createdAt.toISOString(), source: row.source } : null;
}
