import { createHash } from 'node:crypto';
import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm';
import { accounts, prospects, sequenceStates, signals, type DbOrTx } from '@cooks/db';
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
/** Dedupe key for a research signal so repeated scans never duplicate a finding. */
const signalKey = (scope: string, kind: string, text: string) => `research:${scope}:${kind}:${createHash('sha1').update(text.trim().toLowerCase()).digest('hex').slice(0, 16)}`;

export interface ResearchDeps {
  db: DbOrTx;
  env: EnvKeys;
  now: () => Date;
  providerOverride?: LlmProvider;
  /** When present, new signals are queued for rule evaluation. */
  jobs?: { send(name: 'signals.evaluate', data: Record<string, unknown>, opts?: { singletonKey?: string }): Promise<string | null> };
}

export async function researchProspect(
  d: ResearchDeps,
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
      maxTokens: 6000,
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
  await d.db.insert(signals).values({ workspaceId: p.workspaceId, prospectId: p.id, accountId: p.accountId, kind: RESEARCH_SUMMARY_KIND, source: provider.id, payload: { ...out.value, citations, runId: out.runId }, score: String(out.value.confidence), occurredAt: now });
  await storeResearchSignals(d, { workspaceId: p.workspaceId, prospectId: p.id, accountId: p.accountId, scope: p.accountId ?? p.id, source: provider.id, runId: out.runId, confidence: out.value.confidence, now }, out.value.signals);
  return { status: out.status, runId: out.runId, output: out.value, citations, cached: out.status === 'ok' ? out.cached : false };
}

async function storeResearchSignals(
  d: ResearchDeps,
  m: { workspaceId: string; prospectId: string | null; accountId: string | null; scope: string; source: string; runId: string | null; confidence: number; now: Date },
  found: ResearchOutput['signals'],
) {
  let created = 0;
  for (const s of found) {
    const kind = `research.${s.kind}`;
    const [row] = await d.db
      .insert(signals)
      .values({
        workspaceId: m.workspaceId,
        prospectId: m.prospectId,
        accountId: m.accountId,
        kind,
        source: s.sourceUrl ?? m.source,
        title: s.text,
        url: s.sourceUrl,
        payload: { text: s.text, sourceUrl: s.sourceUrl, date: s.date, runId: m.runId },
        score: String(Math.round(m.confidence * 100) / 100),
        dedupeKey: signalKey(m.scope, kind, s.text),
        occurredAt: s.date && !Number.isNaN(Date.parse(s.date)) ? new Date(s.date) : m.now,
      })
      .onConflictDoNothing({ target: [signals.workspaceId, signals.dedupeKey] })
      .returning({ id: signals.id });
    if (row) {
      created++;
      if (d.jobs) await d.jobs.send('signals.evaluate', { signalId: row.id, workspaceId: m.workspaceId }, { singletonKey: `signal:${row.id}` });
    }
  }
  return created;
}

/**
 * Account-level scan: same web-grounded brief without a person. Used by the signals feed
 * ("Scan account") and by the daily scheduler. Returns how many new signals were stored.
 */
export async function scanAccount(d: ResearchDeps, accountId: string, opts: { focus?: string | null; force?: boolean } = {}): Promise<ResearchResult & { created?: number }> {
  const [a] = await d.db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!a) return { status: 'skipped', reason: 'account not found' };
  const cfg = await resolveAiConfig(d.db, a.workspaceId, d.env);
  if (!cfg) return { status: 'skipped', reason: 'no AI provider configured' };
  const provider = d.providerOverride ?? providerFor(cfg, 'general');
  const now = d.now();
  const input: ResearchInput = {
    prospect: { name: null, title: null, linkedInUrl: null },
    account: { name: a.name, domain: a.domain, industry: a.industry, description: a.description },
    focus: opts.focus ?? 'buying signals: funding, hiring, leadership changes, expansion, product launches, technology changes',
    today: now.toISOString().slice(0, 10),
  };
  const out = await runStructured(
    { db: d.db, workspaceId: a.workspaceId, cfg, provider, now: d.now },
    { kind: 'signals.scan', version: RESEARCH_VERSION, system: RESEARCH_SYSTEM, input, userPrompt: researchUserPrompt, schema: ResearchOutput, schemaName: 'research_brief', effort: 'medium', maxTokens: 6000, cacheTtlMs: opts.force ? null : 3 * 24 * 3600_000, parentType: 'account', parentId: accountId, web: { maxResults: 6 }, cacheKeyInput: { account: input.account, focus: input.focus } },
    (o) => (o.confidence < 0.3 ? 'very low confidence' : null),
  );
  if (out.status === 'budget_exceeded') return { status: 'skipped', reason: 'monthly AI budget reached' };
  if (out.status === 'refused' || out.status === 'failed') return { status: 'failed', reason: out.status === 'refused' ? out.reason : out.error };
  const citations = out.status === 'ok' ? (out.citations ?? []) : [];
  await d.db.insert(signals).values({ workspaceId: a.workspaceId, prospectId: null, accountId: a.id, kind: RESEARCH_SUMMARY_KIND, source: provider.id, payload: { ...out.value, citations, runId: out.runId }, score: String(out.value.confidence), occurredAt: now });
  const created = await storeResearchSignals(d, { workspaceId: a.workspaceId, prospectId: null, accountId: a.id, scope: a.id, source: provider.id, runId: out.runId, confidence: out.value.confidence, now }, out.value.signals);
  await d.db.update(accounts).set({ updatedAt: now }).where(eq(accounts.id, a.id));
  return { status: out.status, runId: out.runId, output: out.value, citations, cached: out.status === 'ok' ? out.cached : false, created };
}

/**
 * Accounts due for a scan: those with a prospect in an active enrollment whose last research
 * summary is older than `everyDays` (or missing). Capped per workspace per run to protect budgets.
 */
export async function accountsDueForScan(db: DbOrTx, opts: { everyDays: number; perWorkspace: number; now: Date }) {
  const cutoff = new Date(opts.now.getTime() - opts.everyDays * 86_400_000);
  const rows = await db
    .select({ id: accounts.id, workspaceId: accounts.workspaceId })
    .from(accounts)
    .where(
      and(
        isNull(accounts.deletedAt),
        sql`exists (select 1 from ${prospects} p join ${sequenceStates} s on s.prospect_id = p.id where p.account_id = ${accounts.id} and s.state = 'active' and s.deleted_at is null)`,
        or(
          sql`not exists (select 1 from ${signals} g where g.account_id = ${accounts.id} and g.kind = ${RESEARCH_SUMMARY_KIND})`,
          sql`(select max(g.created_at) from ${signals} g where g.account_id = ${accounts.id} and g.kind = ${RESEARCH_SUMMARY_KIND}) < ${cutoff.toISOString()}::timestamptz`,
        ),
      ),
    )
    .orderBy(accounts.updatedAt)
    .limit(500);
  const perWs = new Map<string, number>();
  return rows.filter((r) => {
    const n = perWs.get(r.workspaceId) ?? 0;
    if (n >= opts.perWorkspace) return false;
    perWs.set(r.workspaceId, n + 1);
    return true;
  });
  void gte;
  void lt;
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
