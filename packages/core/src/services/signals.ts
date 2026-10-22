/**
 * Signals: buying-intent events attached to a prospect and/or account.
 *
 * Sources: `push` (any bot or integration via POST /v1/signals), `research` (web-grounded
 * scans), `email` (engagement derived from tracking + replies), `crm` (deal stage changes).
 * Rules turn matching signals into an enrollment or a task.
 */
import { and, desc, eq, gte, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { accounts, prospects, sequences, signalRules, signals } from '@cooks/db';
import type { Ctx } from '../context.js';
import { emitEvent } from '../events.js';
import { badRequest, conflict, isCooksError, notFound, unprocessable } from '../errors.js';
import { parseInclude, refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { serializeAccount } from './accounts.js';
import { serializeProspect, getProspectRow } from './prospects.js';
import { createSequenceState } from './sequence-states.js';
import { createTask } from './tasks.js';
import { isUuid, isoReq, paginate, requireMember, uuidOr404 } from './_shared.js';

export type SignalRow = typeof signals.$inferSelect;
export type SignalRuleRow = typeof signalRules.$inferSelect;
export const SIGNAL_INCLUDES = ['prospect', 'account'] as const;

/** Well-known kinds. Any `category.type` string is accepted on push. */
export const SIGNAL_KIND_CATALOG: Record<string, string> = {
  'email.clicked': 'Prospect clicked a link in a sequence email',
  'email.engaged': 'Prospect opened the same email three or more times',
  'email.replied': 'Prospect replied to a sequence email',
  'research.funding': 'Funding round or financing news',
  'research.hiring': 'Open roles or hiring pushes',
  'research.news': 'Press or notable company news',
  'research.tech': 'Technology adoption or change',
  'research.leadership': 'Executive hire or departure',
  'research.expansion': 'New market, office or geography',
  'research.product': 'Product launch',
  'research.event': 'Conference talk, webinar or event',
  'crm.deal_stage': 'Deal moved into a watched pipeline stage',
  'crm.job_change': 'Contact changed company or title',
  'web.visit': 'Website visit reported by an integration',
  'intent.topic': 'Third-party intent data on a topic',
  'custom.event': 'Anything else your bot or integration observed',
};

export function serializeSignal(s: SignalRow, x: Record<string, unknown> = {}) {
  const p = s.payload as Record<string, unknown>;
  return {
    id: s.id,
    kind: s.kind,
    source: s.source,
    title: s.title ?? (typeof p.text === 'string' ? p.text : null),
    url: s.url ?? (typeof p.sourceUrl === 'string' ? p.sourceUrl : null),
    score: s.score === null ? null : Number(s.score),
    status: s.status,
    actedAction: s.actedAction,
    payload: p,
    prospect: x.prospect ?? refOrNull('prospects', s.prospectId),
    account: x.account ?? refOrNull('accounts', s.accountId),
    occurredAt: isoReq(s.occurredAt),
    createdAt: isoReq(s.createdAt),
    updatedAt: isoReq(s.updatedAt),
  };
}

async function serializeSignals(ctx: Ctx, rows: SignalRow[], includes: string[]) {
  if (!includes.length || !rows.length) return rows.map((r) => serializeSignal(r));
  const pids = [...new Set(rows.map((r) => r.prospectId).filter((v): v is string => !!v))];
  const aids = [...new Set(rows.map((r) => r.accountId).filter((v): v is string => !!v))];
  const [ps, as] = await Promise.all([
    includes.includes('prospect') && pids.length ? ctx.db.select().from(prospects).where(inArray(prospects.id, pids)) : [],
    includes.includes('account') && aids.length ? ctx.db.select().from(accounts).where(inArray(accounts.id, aids)) : [],
  ]);
  const pm = new Map(ps.map((p) => [p.id, serializeProspect(p, { customFields: false, states: [] })]));
  const am = new Map(as.map((a) => [a.id, serializeAccount(a, { customFields: false })]));
  return rows.map((r) => serializeSignal(r, { prospect: r.prospectId ? pm.get(r.prospectId) : undefined, account: r.accountId ? am.get(r.accountId) : undefined }));
}

export async function listSignals(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; include?: unknown; requestUrl: string }) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, SIGNAL_INCLUDES);
  const conds: SQL[] = [eq(signals.workspaceId, ctx.principal.workspaceId)];
  if (typeof f.kind === 'string' && f.kind) conds.push(f.kind.endsWith('*') ? ilike(signals.kind, `${f.kind.slice(0, -1)}%`) : eq(signals.kind, f.kind));
  if (typeof f.status === 'string' && f.status && f.status !== 'all') conds.push(eq(signals.status, f.status));
  for (const [key, col] of [
    ['prospect', signals.prospectId],
    ['account', signals.accountId],
  ] as const) {
    const v = (f[key] as Record<string, unknown> | undefined)?.id;
    if (typeof v === 'string' && v) {
      if (!isUuid(v)) throw badRequest(`filter[${key}][id] must be a UUID`);
      conds.push(eq(col, v));
    }
  }
  const since = (f.occurredAt as Record<string, unknown> | undefined)?.gte;
  if (typeof since === 'string' && since) {
    const d = new Date(since);
    if (Number.isNaN(d.getTime())) throw badRequest('filter[occurredAt][gte] must be an ISO 8601 date');
    conds.push(gte(signals.occurredAt, d));
  }
  // Research summaries are briefs, not signals; hide them unless asked for by kind.
  if (!(typeof f.kind === 'string' && f.kind === 'research.summary')) conds.push(sql`${signals.kind} <> 'research.summary'`);
  const page = await paginate<SignalRow>({
    table: signals,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(signals)
        .where(and(...conds, ...(where ? [where] : [])))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { ...page, data: await serializeSignals(ctx, page.data, includes) };
}

export async function getSignalRow(ctx: Ctx, id: string): Promise<SignalRow> {
  const [row] = await ctx.db
    .select()
    .from(signals)
    .where(and(eq(signals.workspaceId, ctx.principal.workspaceId), eq(signals.id, uuidOr404(id, 'Signal'))))
    .limit(1);
  if (!row) throw notFound('Signal');
  return row;
}

export async function getSignal(ctx: Ctx, id: string, include?: unknown) {
  const row = await getSignalRow(ctx, id);
  return (await serializeSignals(ctx, [row], parseInclude(include, SIGNAL_INCLUDES)))[0]!;
}

export interface PushSignalInput {
  kind: string;
  title?: string | null;
  url?: string | null;
  source?: string | null;
  score?: number | null;
  occurredAt?: string | null;
  dedupeKey?: string | null;
  payload?: Record<string, unknown>;
  prospect?: { id?: string; email?: string } | null;
  account?: { id?: string; domain?: string; name?: string } | null;
  /** Skip rules (used by research, which runs its own gate). */
  evaluate?: boolean;
}

const KIND_RE = /^[a-z0-9_]+\.[a-z0-9_]+$/;

/**
 * Record a signal. Resolves prospect by id or email and account by id or domain; a signal needs
 * at least one of them. Duplicate `dedupeKey`s return the existing row with `created: false`.
 */
export async function pushSignal(ctx: Ctx, input: PushSignalInput): Promise<{ signal: SignalRow; created: boolean }> {
  const ws = ctx.principal.workspaceId;
  if (!KIND_RE.test(input.kind)) throw unprocessable('kind must look like category.type (lowercase, e.g. research.funding)', { field: 'kind' });
  let prospectId: string | null = null;
  let accountId: string | null = null;
  if (input.prospect?.id) prospectId = (await getProspectRow(ctx, input.prospect.id).catch(() => { throw unprocessable('prospect.id not found in this workspace', { field: 'prospect.id' }); })).id;
  else if (input.prospect?.email) {
    const [p] = await ctx.db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), isNull(prospects.deletedAt), ilike(prospects.primaryEmail, input.prospect.email.trim()))).limit(1);
    if (!p) throw unprocessable(`No prospect with email ${input.prospect.email}`, { field: 'prospect.email' });
    prospectId = p.id;
  }
  if (input.account?.id) {
    const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.workspaceId, ws), eq(accounts.id, uuidOr404(input.account.id, 'Account')))).limit(1);
    if (!a) throw unprocessable('account.id not found in this workspace', { field: 'account.id' });
    accountId = a.id;
  } else if (input.account?.domain) {
    const [a] = await ctx.db.select().from(accounts).where(and(eq(accounts.workspaceId, ws), isNull(accounts.deletedAt), ilike(accounts.domain, input.account.domain.trim().toLowerCase()))).limit(1);
    if (!a) throw unprocessable(`No account with domain ${input.account.domain}`, { field: 'account.domain' });
    accountId = a.id;
  }
  if (prospectId && !accountId) {
    const [p] = await ctx.db.select({ accountId: prospects.accountId }).from(prospects).where(eq(prospects.id, prospectId)).limit(1);
    accountId = p?.accountId ?? null;
  }
  if (!prospectId && !accountId) throw unprocessable('A signal needs a prospect (id or email) or an account (id or domain)');
  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : ctx.clock.now();
  if (Number.isNaN(occurredAt.getTime())) throw unprocessable('occurredAt must be an ISO 8601 date', { field: 'occurredAt' });
  if (input.score !== undefined && input.score !== null && (input.score < 0 || input.score > 1)) throw unprocessable('score must be between 0 and 1', { field: 'score' });
  const values = {
    workspaceId: ws,
    prospectId,
    accountId,
    kind: input.kind,
    source: input.source ?? 'push',
    title: input.title ?? null,
    url: input.url ?? null,
    score: input.score === undefined || input.score === null ? null : String(input.score),
    payload: input.payload ?? {},
    dedupeKey: input.dedupeKey ?? null,
    occurredAt,
  };
  const inserted = await ctx.db.insert(signals).values(values).onConflictDoNothing({ target: [signals.workspaceId, signals.dedupeKey] }).returning();
  if (!inserted.length) {
    const [existing] = await ctx.db.select().from(signals).where(and(eq(signals.workspaceId, ws), eq(signals.dedupeKey, input.dedupeKey!))).limit(1);
    return { signal: existing!, created: false };
  }
  const row = inserted[0]!;
  await emitEvent(ctx.db, { workspaceId: ws, type: 'signal.created', aggregateType: 'signal', aggregateId: row.id, payload: { signalId: row.id, kind: row.kind, prospectId, accountId, title: row.title, url: row.url, score: input.score ?? null } });
  if (input.evaluate !== false) await ctx.jobs.send('signals.evaluate', { signalId: row.id, workspaceId: ws }, { singletonKey: `signal:${row.id}` });
  return { signal: row, created: true };
}

export async function dismissSignal(ctx: Ctx, id: string) {
  const row = await getSignalRow(ctx, id);
  const [u] = await ctx.db.update(signals).set({ status: 'dismissed', consumedAt: ctx.clock.now(), updatedAt: ctx.clock.now() }).where(eq(signals.id, row.id)).returning();
  return serializeSignal(u!);
}

export type SignalAction = { action: 'enroll'; sequenceId: string; ownerId: string } | { action: 'task'; ownerId: string; taskAction?: string; note?: string; dueAt?: string };

/** Act on a signal by hand (or from a rule): enroll the prospect or create a task. */
export async function actOnSignal(ctx: Ctx, id: string, a: SignalAction, opts: { ruleId?: string } = {}) {
  const row = await getSignalRow(ctx, id);
  const prospectId = row.prospectId ?? (await firstProspectForAccount(ctx, row.accountId));
  if (!prospectId) throw unprocessable('This signal has no prospect to act on; create one for the account first');
  const ownerId = await requireMember(ctx, a.ownerId, 'ownerId');
  let result: Record<string, unknown>;
  if (a.action === 'enroll') {
    try {
      const st = await createSequenceState(ctx, { prospect: { id: prospectId }, sequence: { id: a.sequenceId }, owner: { id: ownerId } });
      result = { enrolled: true, sequenceStateId: (st as { id: string }).id };
    } catch (e) {
      if (isCooksError(e) && e.status === 409) result = { enrolled: false, reason: 'already enrolled' };
      else throw e;
    }
  } else {
    const t = await createTask(ctx, {
      action: a.taskAction ?? 'basic_task',
      dueAt: a.dueAt ?? ctx.clock.now().toISOString(),
      ownerId,
      prospectId,
      note: a.note ?? `Signal: ${row.title ?? row.kind}${row.url ? ` (${row.url})` : ''}`,
      priority: 'high',
    });
    result = { taskId: (t as { id: string }).id };
  }
  await ctx.db.update(signals).set({ status: 'acted', actedAction: a.action, consumedAt: ctx.clock.now(), updatedAt: ctx.clock.now() }).where(eq(signals.id, row.id));
  if (opts.ruleId) await ctx.db.update(signalRules).set({ firedCount: sql`${signalRules.firedCount} + 1`, lastFiredAt: ctx.clock.now() }).where(eq(signalRules.id, opts.ruleId));
  return { signalId: row.id, action: a.action, ...result };
}

async function firstProspectForAccount(ctx: Ctx, accountId: string | null) {
  if (!accountId) return null;
  const [p] = await ctx.db
    .select({ id: prospects.id })
    .from(prospects)
    .where(and(eq(prospects.workspaceId, ctx.principal.workspaceId), eq(prospects.accountId, accountId), isNull(prospects.deletedAt)))
    .orderBy(desc(prospects.createdAt))
    .limit(1);
  return p?.id ?? null;
}

/* ---------- rules ---------- */

export const kindMatches = (pattern: string, kind: string) => pattern === '*' || pattern === kind || (pattern.endsWith('.*') && kind.startsWith(pattern.slice(0, -1)));

export function serializeRule(r: SignalRuleRow, seqName?: string | null) {
  return { id: r.id, name: r.name, kindPattern: r.kindPattern, minScore: r.minScore === null ? null : Number(r.minScore), action: r.action, sequenceId: r.sequenceId, sequenceName: seqName ?? null, ownerId: r.ownerId, taskAction: r.taskAction, taskNote: r.taskNote, enabled: r.enabled, firedCount: r.firedCount, lastFiredAt: r.lastFiredAt ? isoReq(r.lastFiredAt) : null, createdAt: isoReq(r.createdAt) };
}

export async function listSignalRules(ctx: Ctx) {
  const rows = await ctx.db.select().from(signalRules).where(and(eq(signalRules.workspaceId, ctx.principal.workspaceId), isNull(signalRules.deletedAt))).orderBy(signalRules.createdAt);
  const sids = rows.map((r) => r.sequenceId).filter((v): v is string => !!v);
  const names = new Map(sids.length ? (await ctx.db.select({ id: sequences.id, name: sequences.name }).from(sequences).where(inArray(sequences.id, sids))).map((s) => [s.id, s.name]) : []);
  return rows.map((r) => serializeRule(r, r.sequenceId ? names.get(r.sequenceId) : null));
}

export interface SignalRuleInput {
  name?: string;
  kindPattern: string;
  minScore?: number | null;
  action: 'enroll' | 'task';
  sequenceId?: string;
  ownerId: string;
  taskAction?: string;
  taskNote?: string;
  enabled?: boolean;
}

export async function createSignalRule(ctx: Ctx, input: SignalRuleInput) {
  if (!(input.kindPattern === '*' || KIND_RE.test(input.kindPattern) || /^[a-z0-9_]+\.\*$/.test(input.kindPattern))) throw unprocessable('kindPattern must be a kind, a prefix like research.*, or *', { field: 'kindPattern' });
  if (input.action === 'enroll' && !input.sequenceId) throw unprocessable('sequenceId is required for enroll rules', { field: 'sequenceId' });
  const ownerId = await requireMember(ctx, input.ownerId, 'ownerId');
  if (input.sequenceId) {
    const [s] = await ctx.db.select({ id: sequences.id }).from(sequences).where(and(eq(sequences.workspaceId, ctx.principal.workspaceId), eq(sequences.id, uuidOr404(input.sequenceId, 'Sequence')), isNull(sequences.deletedAt))).limit(1);
    if (!s) throw unprocessable('sequenceId not found in this workspace', { field: 'sequenceId' });
  }
  const [row] = await ctx.db
    .insert(signalRules)
    .values({ workspaceId: ctx.principal.workspaceId, name: input.name ?? `${input.kindPattern} → ${input.action}`, kindPattern: input.kindPattern, minScore: input.minScore === undefined || input.minScore === null ? null : String(input.minScore), action: input.action, sequenceId: input.sequenceId ?? null, ownerId, taskAction: input.taskAction ?? null, taskNote: input.taskNote ?? null, enabled: input.enabled ?? true })
    .returning();
  return serializeRule(row!);
}

export async function deleteSignalRule(ctx: Ctx, id: string) {
  const [row] = await ctx.db.update(signalRules).set({ deletedAt: ctx.clock.now() }).where(and(eq(signalRules.workspaceId, ctx.principal.workspaceId), eq(signalRules.id, uuidOr404(id, 'Rule')), isNull(signalRules.deletedAt))).returning({ id: signalRules.id });
  if (!row) throw notFound('Rule');
}

/** Worker entry: apply every enabled rule whose pattern and score gate match. First matching rule per action type wins. */
export async function evaluateSignal(ctx: Ctx, signalId: string) {
  const row = await getSignalRow(ctx, signalId);
  if (row.status !== 'new') return { signalId, skipped: row.status };
  const rules = await ctx.db.select().from(signalRules).where(and(eq(signalRules.workspaceId, ctx.principal.workspaceId), eq(signalRules.enabled, true), isNull(signalRules.deletedAt))).orderBy(signalRules.createdAt);
  const score = row.score === null ? null : Number(row.score);
  const fired: unknown[] = [];
  for (const r of rules) {
    if (!kindMatches(r.kindPattern, row.kind)) continue;
    if (r.minScore !== null && (score === null || score < Number(r.minScore))) continue;
    if (fired.some((f) => (f as { action: string }).action === r.action)) continue;
    const a: SignalAction = r.action === 'enroll' ? { action: 'enroll', sequenceId: r.sequenceId!, ownerId: r.ownerId! } : { action: 'task', ownerId: r.ownerId!, taskAction: r.taskAction ?? undefined, note: r.taskNote ?? undefined };
    try {
      fired.push({ ruleId: r.id, ...(await actOnSignal(ctx, row.id, a, { ruleId: r.id })) });
    } catch (e) {
      fired.push({ ruleId: r.id, action: r.action, error: (e as Error).message });
    }
  }
  return { signalId, fired };
}

/** Counts for the feed header: new signals by kind in the last N days. */
export async function signalSummary(ctx: Ctx, days = 7) {
  const since = new Date(ctx.clock.now().getTime() - days * 86_400_000);
  const rows = await ctx.db
    .select({ kind: signals.kind, status: signals.status, n: sql<number>`count(*)::int` })
    .from(signals)
    .where(and(eq(signals.workspaceId, ctx.principal.workspaceId), gte(signals.occurredAt, since), sql`${signals.kind} <> 'research.summary'`))
    .groupBy(signals.kind, signals.status);
  const byKind: Record<string, number> = {};
  let newCount = 0;
  for (const r of rows) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + r.n;
    if (r.status === 'new') newCount += r.n;
  }
  return { days, total: rows.reduce((a, r) => a + r.n, 0), new: newCount, byKind };
}

/** Derive engagement signals from outbox email events (called by the worker). */
export async function signalFromEmailEvent(ctx: Ctx, eventType: string, payload: Record<string, unknown>, email: { id: string; prospectId: string | null; subject: string | null; openCount: number } | null) {
  if (!email?.prospectId) return null;
  const base = { prospect: { id: email.prospectId }, source: 'email', payload: { emailId: email.id, subject: email.subject } };
  if (eventType === 'email.clicked') return pushSignal(ctx, { ...base, kind: 'email.clicked', title: `Clicked a link in “${email.subject ?? 'email'}”`, score: 0.7, dedupeKey: `email:${email.id}:clicked` });
  if (eventType === 'email.replied') return pushSignal(ctx, { ...base, kind: 'email.replied', title: `Replied to “${email.subject ?? 'email'}”`, score: 0.9, dedupeKey: `email:${email.id}:replied` });
  if (eventType === 'email.opened' && email.openCount >= 3) return pushSignal(ctx, { ...base, kind: 'email.engaged', title: `Opened “${email.subject ?? 'email'}” ${email.openCount} times`, score: 0.5, dedupeKey: `email:${email.id}:engaged` });
  void payload;
  return null;
}

export { conflict as _signalConflict };
