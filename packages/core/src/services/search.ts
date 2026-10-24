/**
 * Search across a workspace: prospects, accounts, calls and their transcript lines, signals,
 * emails, notes, tasks and sequences, from one `search_index` table in Postgres.
 *
 * Ranking is Postgres full-text (`websearch_to_tsquery`, title weighted above body) plus a
 * substring match on titles so partial names and emails hit without knowing the stemmer. No
 * model is involved; embeddings can be added to the same table later.
 *
 * The indexer is incremental: for each source table it reads rows whose updated_at is past the
 * newest `source_updated_at` already indexed for that type, upserts them, and drops rows for
 * soft-deleted sources. A full pass rebuilds everything.
 */
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { accounts, callTranscripts, calls, emails, notes, prospects, searchIndex, sequences, signals, tasks } from '@cooks/db';
import type { Db } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest } from '../errors.js';

/** Bump when titles, bodies or chunking change; every workspace then gets one full rebuild. */
export const SEARCH_INDEX_VERSION = 2;

export const SEARCH_TYPES = ['prospect', 'account', 'call', 'transcript', 'signal', 'email', 'note', 'task', 'sequence'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

export interface SearchDoc {
  entityType: SearchType;
  entityId: string;
  chunk?: number;
  prospectId?: string | null;
  accountId?: string | null;
  title: string;
  body?: string;
  meta?: Record<string, unknown>;
  occurredAt: Date;
  sourceUpdatedAt: Date;
}

export interface SearchHit {
  id: string;
  type: SearchType;
  entityId: string;
  chunk: number;
  title: string;
  /** Plain text; matched words are wrapped in « ». */
  snippet: string;
  prospectId: string | null;
  accountId: string | null;
  occurredAt: string;
  meta: Record<string, unknown>;
  /** Path inside the web app, e.g. /prospects/{id}. */
  href: string;
  score: number;
}

const clip = (s: string | null | undefined, n = 120) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const join = (parts: Array<string | null | undefined>) => parts.filter((p): p is string => !!p && p.trim().length > 0).join(' · ');
const flatten = (v: unknown, depth = 0): string => {
  if (v === null || v === undefined || depth > 3) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => flatten(x, depth + 1)).join(' ');
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).map((x) => flatten(x, depth + 1)).join(' ');
  return '';
};

export function hrefFor(type: SearchType, entityId: string, h: { prospectId?: string | null; meta?: Record<string, unknown> }): string {
  switch (type) {
    case 'prospect':
      return `/prospects/${entityId}`;
    case 'account':
      return `/prospects?account=${entityId}`;
    case 'call':
      return `/calls/${entityId}`;
    case 'transcript':
      return `/calls/${entityId}${typeof h.meta?.start === 'number' ? `#t=${Math.floor(h.meta.start as number)}` : ''}`;
    case 'signal':
      return h.prospectId ? `/prospects/${h.prospectId}` : '/signals';
    case 'email':
      return h.prospectId ? `/prospects/${h.prospectId}` : '/emails';
    case 'note':
      return h.prospectId ? `/prospects/${h.prospectId}` : '/prospects';
    case 'task':
      return '/';
    case 'sequence':
      return `/sequences/${entityId}`;
  }
}

/* ------------------------------------------------------------------ indexing */

async function watermark(db: Db, workspaceId: string, type: SearchType): Promise<Date | null> {
  const [r] = await db
    .select({ m: sql<string | null>`max(${searchIndex.sourceUpdatedAt})` })
    .from(searchIndex)
    .where(and(eq(searchIndex.workspaceId, workspaceId), eq(searchIndex.entityType, type)));
  return r?.m ? new Date(r.m) : null;
}

async function upsertDocs(db: Db, workspaceId: string, docs: SearchDoc[]) {
  for (let i = 0; i < docs.length; i += 200) {
    const slice = docs.slice(i, i + 200);
    await db
      .insert(searchIndex)
      .values(
        slice.map((d) => ({
          workspaceId,
          entityType: d.entityType,
          entityId: d.entityId,
          chunk: d.chunk ?? 0,
          prospectId: d.prospectId ?? null,
          accountId: d.accountId ?? null,
          title: clip(d.title, 200) || '(untitled)',
          body: (d.body ?? '').slice(0, 20_000),
          meta: { ...(d.meta ?? {}), v: SEARCH_INDEX_VERSION },
          occurredAt: d.occurredAt,
          sourceUpdatedAt: d.sourceUpdatedAt,
          indexedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [searchIndex.workspaceId, searchIndex.entityType, searchIndex.entityId, searchIndex.chunk],
        set: {
          prospectId: sql`excluded.prospect_id`,
          accountId: sql`excluded.account_id`,
          title: sql`excluded.title`,
          body: sql`excluded.body`,
          meta: sql`excluded.meta`,
          occurredAt: sql`excluded.occurred_at`,
          sourceUpdatedAt: sql`excluded.source_updated_at`,
          indexedAt: sql`excluded.indexed_at`,
        },
      });
  }
}

async function removeEntities(db: Db, workspaceId: string, type: SearchType, ids: string[]) {
  if (!ids.length) return 0;
  const r = await db
    .delete(searchIndex)
    .where(and(eq(searchIndex.workspaceId, workspaceId), eq(searchIndex.entityType, type), inArray(searchIndex.entityId, ids)))
    .returning({ id: searchIndex.id });
  return r.length;
}

type Source = { type: SearchType; load: (since: Date | null) => Promise<{ docs: SearchDoc[]; removed: string[] }> };

function sources(db: Db, ws: string): Source[] {
  const changed = (col: AnyPgColumn, since: Date | null) => (since ? gt(col, since) : undefined);
  return [
    {
      type: 'prospect',
      load: async (since) => {
        const rows = await db
          .select({ p: prospects, accountName: accounts.name })
          .from(prospects)
          .leftJoin(accounts, eq(accounts.id, prospects.accountId))
          .where(and(eq(prospects.workspaceId, ws), changed(prospects.updatedAt, since)));
        return {
          docs: rows
            .filter((r) => !r.p.deletedAt)
            .map(({ p, accountName }) => ({
              entityType: 'prospect' as const,
              entityId: p.id,
              prospectId: p.id,
              accountId: p.accountId,
              title: p.name ?? p.primaryEmail ?? 'Prospect',
              body: join([p.title, accountName, p.primaryEmail, p.phone, join([p.city, p.state, p.country])]),
              meta: { title: p.title, account: accountName, email: p.primaryEmail },
              occurredAt: p.createdAt,
              sourceUpdatedAt: p.updatedAt,
            })),
          removed: rows.filter((r) => r.p.deletedAt).map((r) => r.p.id),
        };
      },
    },
    {
      type: 'account',
      load: async (since) => {
        const rows = await db.select().from(accounts).where(and(eq(accounts.workspaceId, ws), changed(accounts.updatedAt, since)));
        return {
          docs: rows
            .filter((a) => !a.deletedAt)
            .map((a) => ({
              entityType: 'account' as const,
              entityId: a.id,
              accountId: a.id,
              title: a.name ?? a.domain ?? 'Account',
              body: join([a.domain, a.industry, a.city, a.website, a.description]),
              meta: { domain: a.domain, industry: a.industry },
              occurredAt: a.createdAt,
              sourceUpdatedAt: a.updatedAt,
            })),
          removed: rows.filter((a) => a.deletedAt).map((a) => a.id),
        };
      },
    },
    {
      type: 'sequence',
      load: async (since) => {
        const rows = await db.select().from(sequences).where(and(eq(sequences.workspaceId, ws), changed(sequences.updatedAt, since)));
        return {
          docs: rows
            .filter((s) => !s.deletedAt)
            .map((s) => ({ entityType: 'sequence' as const, entityId: s.id, title: s.name, body: '', meta: { enabled: s.enabled }, occurredAt: s.createdAt, sourceUpdatedAt: s.updatedAt })),
          removed: rows.filter((s) => s.deletedAt).map((s) => s.id),
        };
      },
    },
    {
      type: 'task',
      load: async (since) => {
        const rows = await db
          .select({ t: tasks, who: prospects.name })
          .from(tasks)
          .leftJoin(prospects, eq(prospects.id, tasks.prospectId))
          .where(and(eq(tasks.workspaceId, ws), changed(tasks.updatedAt, since)));
        return {
          docs: rows
            .filter((r) => !r.t.deletedAt)
            .map(({ t, who }) => ({
              entityType: 'task' as const,
              entityId: t.id,
              prospectId: t.prospectId,
              accountId: t.accountId,
              title: join([t.action.replace(/_/g, ' '), who]) || 'Task',
              body: t.note ?? '',
              meta: { action: t.action, status: t.status, completed: t.completed },
              occurredAt: t.dueAt ?? t.createdAt,
              sourceUpdatedAt: t.updatedAt,
            })),
          removed: rows.filter((r) => r.t.deletedAt).map((r) => r.t.id),
        };
      },
    },
    {
      type: 'note',
      load: async (since) => {
        const rows = await db.select().from(notes).where(and(eq(notes.workspaceId, ws), changed(notes.updatedAt, since)));
        return {
          docs: rows
            .filter((n) => !n.deletedAt)
            .map((n) => ({
              entityType: 'note' as const,
              entityId: n.id,
              prospectId: n.associatedType === 'prospect' ? n.associatedId : null,
              accountId: n.associatedType === 'account' ? n.associatedId : null,
              title: clip(n.text, 80) || 'Note',
              body: n.text,
              meta: { by: n.userName },
              occurredAt: n.externalCreatedAt ?? n.createdAt,
              sourceUpdatedAt: n.updatedAt,
            })),
          removed: rows.filter((n) => n.deletedAt).map((n) => n.id),
        };
      },
    },
    {
      type: 'email',
      load: async (since) => {
        const rows = await db.select().from(emails).where(and(eq(emails.workspaceId, ws), changed(emails.updatedAt, since)));
        return {
          docs: rows
            .filter((e) => !e.deletedAt)
            .map((e) => ({
              entityType: 'email' as const,
              entityId: e.id,
              prospectId: e.prospectId,
              accountId: e.accountId,
              title: e.subject || '(no subject)',
              body: join([e.toAddr, e.fromAddr]) + '\n' + (e.bodyText ?? ''),
              meta: { direction: e.direction, status: e.status, to: e.toAddr },
              occurredAt: e.date ?? e.createdAt,
              sourceUpdatedAt: e.updatedAt,
            })),
          removed: rows.filter((e) => e.deletedAt).map((e) => e.id),
        };
      },
    },
    {
      type: 'signal',
      load: async (since) => {
        const rows = await db.select().from(signals).where(and(eq(signals.workspaceId, ws), changed(signals.updatedAt, since)));
        return {
          docs: rows.map((s) => ({
            entityType: 'signal' as const,
            entityId: s.id,
            prospectId: s.prospectId,
            accountId: s.accountId,
            title: s.title ?? s.kind,
            body: join([s.kind, s.source, flatten(s.payload)]),
            meta: { kind: s.kind, status: s.status, url: s.url },
            occurredAt: s.occurredAt,
            sourceUpdatedAt: s.updatedAt,
          })),
          removed: [],
        };
      },
    },
    {
      type: 'call',
      load: async (since) => {
        const rows = await db
          .select({ c: calls, who: prospects.name })
          .from(calls)
          .leftJoin(prospects, eq(prospects.id, calls.prospectId))
          .where(and(eq(calls.workspaceId, ws), changed(calls.updatedAt, since)));
        return {
          docs: rows
            .filter((r) => !r.c.deletedAt)
            .map(({ c, who }) => ({
              entityType: 'call' as const,
              entityId: c.id,
              prospectId: c.prospectId,
              accountId: c.accountId,
              title: join([c.mode === 'practice' ? 'Practice call' : 'Call', who ?? c.toNumber]) || 'Call',
              body: join([c.outcome?.replace(/_/g, ' '), c.status, c.summary, c.notes]),
              meta: { outcome: c.outcome, status: c.status, mode: c.mode, duration: c.durationSeconds },
              occurredAt: c.time ?? c.createdAt,
              sourceUpdatedAt: c.updatedAt,
            })),
          removed: rows.filter((r) => r.c.deletedAt).map((r) => r.c.id),
        };
      },
    },
    {
      type: 'transcript',
      load: async (since) => {
        const rows = await db
          .select({ t: callTranscripts, c: calls, who: prospects.name })
          .from(callTranscripts)
          .innerJoin(calls, eq(calls.id, callTranscripts.callId))
          .leftJoin(prospects, eq(prospects.id, calls.prospectId))
          .where(and(eq(callTranscripts.workspaceId, ws), changed(callTranscripts.updatedAt, since)));
        const docs: SearchDoc[] = [];
        const removed: string[] = [];
        for (const { t, c, who } of rows) {
          if (c.deletedAt) {
            removed.push(c.id);
            continue;
          }
          const segs = (t.segments as Array<{ speaker?: string; start?: number; text?: string }>).filter((s) => s.text && s.text.trim());
          // replace the call's lines wholesale so a re-transcription cannot leave stale chunks behind
          removed.push(c.id);
          segs.forEach((s, i) =>
            docs.push({
              entityType: 'transcript',
              entityId: c.id,
              chunk: i,
              prospectId: c.prospectId,
              accountId: c.accountId,
              title: clip(s.text, 90),
              body: s.text ?? '',
              meta: { speaker: s.speaker, start: s.start, who: s.speaker === 'rep' ? 'Rep' : (who ?? 'Prospect') },
              occurredAt: c.time ?? t.createdAt,
              sourceUpdatedAt: t.updatedAt,
            }),
          );
        }
        return { docs, removed };
      },
    },
  ];
}

/** True when any row was written by an older index format. */
const indexIsStale = (db: Db, workspaceId: string) =>
  db
    .select({ id: searchIndex.id })
    .from(searchIndex)
    .where(and(eq(searchIndex.workspaceId, workspaceId), sql`coalesce((${searchIndex.meta}->>'v')::int, 0) <> ${SEARCH_INDEX_VERSION}`))
    .limit(1);

/** Index one workspace. Incremental by default; `full` rebuilds every row, and so does a format change. */
export async function indexWorkspace(db: Db, workspaceId: string, opts: { full?: boolean } = {}): Promise<{ indexed: number; removed: number }> {
  let indexed = 0;
  let removed = 0;
  let full = !!opts.full;
  if (!full) {
    const [stale] = await indexIsStale(db, workspaceId);
    if (stale) full = true;
  }
  if (full) {
    const r = await db.delete(searchIndex).where(eq(searchIndex.workspaceId, workspaceId)).returning({ id: searchIndex.id });
    removed += r.length;
  }
  for (const src of sources(db, workspaceId)) {
    const since = full ? null : await watermark(db, workspaceId, src.type);
    const { docs, removed: gone } = await src.load(since);
    removed += await removeEntities(db, workspaceId, src.type, [...new Set(gone)]);
    await upsertDocs(db, workspaceId, docs);
    indexed += docs.length;
  }
  return { indexed, removed };
}

export async function indexSize(db: Db, workspaceId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(searchIndex).where(eq(searchIndex.workspaceId, workspaceId));
  return r?.n ?? 0;
}

/* ------------------------------------------------------------------ querying */

export interface SearchArgs {
  q: string;
  types?: SearchType[];
  limit?: number;
  prospectId?: string;
  accountId?: string;
}

export async function search(ctx: Ctx, args: SearchArgs): Promise<SearchHit[]> {
  const q = args.q.trim();
  if (!q) throw badRequest('q is required');
  const ws = ctx.principal.workspaceId;
  // First use: build the index inline so a fresh install searches without waiting for the cron.
  if ((await indexSize(ctx.db, ws)) === 0) await indexWorkspace(ctx.db, ws, { full: true });
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const types = args.types?.filter((t): t is SearchType => (SEARCH_TYPES as readonly string[]).includes(t));
  const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const prefix = `${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const conds = [eq(searchIndex.workspaceId, ws)];
  if (types?.length) conds.push(inArray(searchIndex.entityType, types));
  if (args.prospectId) conds.push(eq(searchIndex.prospectId, args.prospectId));
  if (args.accountId) conds.push(eq(searchIndex.accountId, args.accountId));
  const tsq = sql`websearch_to_tsquery('english', ${q})`;
  const rows = await ctx.db
    .select({
      id: searchIndex.id,
      type: searchIndex.entityType,
      entityId: searchIndex.entityId,
      chunk: searchIndex.chunk,
      title: searchIndex.title,
      prospectId: searchIndex.prospectId,
      accountId: searchIndex.accountId,
      occurredAt: searchIndex.occurredAt,
      meta: searchIndex.meta,
      rank: sql<number>`ts_rank_cd(${searchIndex.tsv}, ${tsq})`,
      titleHit: sql<boolean>`${searchIndex.title} ILIKE ${like}`,
      titleStarts: sql<boolean>`${searchIndex.title} ILIKE ${prefix}`,
      snippet: sql<string>`ts_headline('english', ${searchIndex.body}, ${tsq}, 'MaxFragments=1,MaxWords=22,MinWords=8,StartSel=«,StopSel=»,FragmentDelimiter=…')`,
    })
    .from(searchIndex)
    .where(and(...conds, sql`(${searchIndex.tsv} @@ ${tsq} OR ${searchIndex.title} ILIKE ${like})`))
    .orderBy(
      sql`(${searchIndex.title} ILIKE ${prefix}) DESC`,
      sql`CASE ${searchIndex.entityType} WHEN 'prospect' THEN 0 WHEN 'account' THEN 0 WHEN 'sequence' THEN 0 WHEN 'transcript' THEN 2 ELSE 1 END`,
      sql`ts_rank_cd(${searchIndex.tsv}, ${tsq}) DESC`,
      sql`${searchIndex.occurredAt} DESC`,
    )
    .limit(limit);
  return rows.map((r) => {
    const type = r.type as SearchType;
    const snippet = r.snippet && r.snippet.includes('«') ? r.snippet : clip(r.snippet, 140);
    return {
      id: r.id,
      type,
      entityId: r.entityId,
      chunk: r.chunk,
      title: r.title,
      snippet,
      prospectId: r.prospectId,
      accountId: r.accountId,
      occurredAt: r.occurredAt.toISOString(),
      meta: r.meta,
      href: hrefFor(type, r.entityId, { prospectId: r.prospectId, meta: r.meta }),
      score: Number(r.rank) + (r.titleStarts ? 1 : r.titleHit ? 0.5 : 0),
    };
  });
}
