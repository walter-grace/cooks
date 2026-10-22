import { and, asc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { sequenceSteps, sequenceTags, sequences, tags, withTx } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, insufficientPermission, notFound, unprocessable } from '../errors.js';
import { parseInclude, ref, refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { assertCanEditPrivacy, canReadPrivacy, isManagerOrAdmin } from '../principal.js';
import { parseEnum } from '../query.js';
import { setSequenceHold } from '../engine/transitions.js';
import { analyticsFor } from './analytics.js';
import { serializeTag } from './tags.js';
import { serializeUser, usersByIds } from './users.js';
import { ciEq, isUuid, isoReq, paginate, requireMember, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';
import { serializeStep, stepsForSequences } from './sequence-steps.js';

export type SequenceRow = typeof sequences.$inferSelect;
export const SEQUENCE_INCLUDES = ['owner', 'sequenceSteps'] as const;

/** Visibility clause: private sequences are only visible to their owner, managers, admins and API keys. */
function visibilityWhere(ctx: Ctx): SQL | undefined {
  if (isManagerOrAdmin(ctx.principal)) return undefined;
  return sql`(${sequences.privacy} <> 'private' OR ${sequences.ownerId} = ${ctx.principal.userId})`;
}

export async function getSequenceRow(ctx: Ctx, id: string): Promise<SequenceRow> {
  uuidOr404(id, 'Sequence');
  const [row] = await ctx.db
    .select()
    .from(sequences)
    .where(and(tenantWhere(sequences, ctx.principal.workspaceId), eq(sequences.id, id)))
    .limit(1);
  if (!row || !canReadPrivacy(ctx.principal, row.privacy, row.ownerId)) throw notFound('Sequence');
  return row;
}

async function tagsForSequences(ctx: Ctx, ids: string[]): Promise<Map<string, Array<typeof tags.$inferSelect>>> {
  const map = new Map<string, Array<typeof tags.$inferSelect>>();
  if (ids.length === 0) return map;
  const rows = await ctx.db
    .select({ sequenceId: sequenceTags.sequenceId, tag: tags })
    .from(sequenceTags)
    .innerJoin(tags, eq(tags.id, sequenceTags.tagId))
    .where(and(inArray(sequenceTags.sequenceId, ids), isNull(tags.deletedAt)));
  for (const r of rows) {
    const list = map.get(r.sequenceId) ?? [];
    list.push(r.tag);
    map.set(r.sequenceId, list);
  }
  return map;
}

export async function serializeSequences(ctx: Ctx, rows: SequenceRow[], includes: string[]) {
  const ids = rows.map((r) => r.id);
  const [steps, tagMap, analytics] = await Promise.all([stepsForSequences(ctx, ids), tagsForSequences(ctx, ids), analyticsFor(ctx.db, 'sequence', ids)]);
  const owners = includes.includes('owner') ? await usersByIds(ctx, rows.map((r) => r.ownerId)) : new Map();
  const stepAnalytics = includes.includes('sequenceSteps')
    ? await analyticsFor(ctx.db, 'sequence_step', [...steps.values()].flat().map((s) => s.id))
    : new Map();
  return rows.map((s) => {
    const stepRows = steps.get(s.id) ?? [];
    const ownerRow = owners.get(s.ownerId);
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      enabled: s.enabled,
      owner: includes.includes('owner') && ownerRow ? serializeUser(ownerRow) : ref('users', s.ownerId),
      sequenceSteps: includes.includes('sequenceSteps')
        ? stepRows.map((st) => serializeStep(st, stepAnalytics.get(st.id), undefined))
        : stepRows.map((st) => ref('sequenceSteps', st.id)),
      parentSequence: refOrNull('sequences', s.parentSequenceId),
      parentSequenceStep: refOrNull('sequenceSteps', s.parentSequenceStepId),
      privacy: s.privacy,
      analytics: analytics.get(s.id)!,
      tags: (tagMap.get(s.id) ?? []).map(serializeTag),
      createdAt: isoReq(s.createdAt),
      updatedAt: isoReq(s.updatedAt),
    };
  });
}

export async function listSequences(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; include?: unknown; requestUrl: string }) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, SEQUENCE_INCLUDES);
  const conds: SQL[] = [tenantWhere(sequences, ctx.principal.workspaceId)];
  const vis = visibilityWhere(ctx);
  if (vis) conds.push(vis);
  if (typeof f.name === 'string' && f.name) conds.push(ciEq(sequences.name, f.name));
  const type = parseEnum(f.type, ['interval', 'date'] as const, 'filter[type]');
  if (type) conds.push(eq(sequences.type, type));
  const parent = (f.parentSequence as Record<string, unknown> | undefined)?.id;
  if (parent === 'null') conds.push(isNull(sequences.parentSequenceId));
  else if (typeof parent === 'string' && parent) {
    if (!isUuid(parent)) throw badRequest('filter[parentSequence][id] must be a UUID or null');
    conds.push(eq(sequences.parentSequenceId, parent));
  }
  conds.push(...updatedAtFilter(sequences.updatedAt, f, 'lt'));
  const page = await paginate({
    table: sequences,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(sequences)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: await serializeSequences(ctx, page.data, includes), links: page.links };
}

export async function getSequence(ctx: Ctx, id: string, include?: unknown) {
  const includes = parseInclude(include, SEQUENCE_INCLUDES);
  const row = await getSequenceRow(ctx, id);
  return (await serializeSequences(ctx, [row], includes))[0]!;
}

async function resolveTagIds(ctx: Ctx, tagRefs: Array<{ id: string }> | undefined): Promise<string[] | undefined> {
  if (!tagRefs) return undefined;
  const ids = [...new Set(tagRefs.map((t) => t.id))];
  if (ids.length === 0) return [];
  const found = await ctx.db
    .select({ id: tags.id })
    .from(tags)
    .where(and(tenantWhere(tags, ctx.principal.workspaceId), inArray(tags.id, ids)));
  if (found.length !== ids.length) {
    const have = new Set(found.map((f) => f.id));
    throw unprocessable('Unknown tag id', { tags: ids.filter((i) => !have.has(i)) });
  }
  return ids;
}

export interface CreateSequenceInput {
  name: string;
  type?: 'interval' | 'date';
  owner: { id: string };
  enabled?: boolean;
  privacy?: 'private' | 'team_visible' | 'team_editable';
  tags?: Array<{ id: string }>;
}

export async function createSequence(ctx: Ctx, input: CreateSequenceInput) {
  const ownerId = await requireMember(ctx, input.owner.id, 'owner.id');
  const tagIds = await resolveTagIds(ctx, input.tags);
  const row = await withTx(ctx.db, async (tx) => {
    const [s] = await tx
      .insert(sequences)
      .values({
        workspaceId: ctx.principal.workspaceId,
        name: input.name,
        type: input.type ?? 'interval',
        ownerId,
        enabled: input.enabled ?? true,
        privacy: input.privacy ?? 'team_editable',
      })
      .returning();
    if (tagIds?.length) await tx.insert(sequenceTags).values(tagIds.map((tagId) => ({ sequenceId: s!.id, tagId })));
    return s!;
  });
  return (await serializeSequences(ctx, [row], []))[0]!;
}

export async function updateSequence(ctx: Ctx, id: string, input: { name?: string; enabled?: boolean; tags?: Array<{ id: string }> }) {
  const existing = await getSequenceRow(ctx, id);
  assertCanEditPrivacy(ctx.principal, existing.privacy, existing.ownerId, 'edit this sequence');
  const tagIds = await resolveTagIds(ctx, input.tags);
  const row = await withTx(ctx.db, async (tx) => {
    const [s] = await tx
      .update(sequences)
      .set({ ...(input.name !== undefined ? { name: input.name } : {}), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}) })
      .where(eq(sequences.id, id))
      .returning();
    if (tagIds) {
      await tx.delete(sequenceTags).where(eq(sequenceTags.sequenceId, id));
      if (tagIds.length) await tx.insert(sequenceTags).values(tagIds.map((tagId) => ({ sequenceId: id, tagId })));
    }
    return s!;
  });
  if (input.enabled !== undefined && input.enabled !== existing.enabled) await setSequenceHold(ctx, id, !input.enabled);
  return (await serializeSequences(ctx, [row], []))[0]!;
}

/** The body must list every live step exactly once; order becomes 1..n in the given sequence. */
export async function reorderSteps(ctx: Ctx, id: string, stepIds: string[]) {
  const seq = await getSequenceRow(ctx, id);
  assertCanEditPrivacy(ctx.principal, seq.privacy, seq.ownerId, 'reorder steps');
  const live = await ctx.db
    .select({ id: sequenceSteps.id })
    .from(sequenceSteps)
    .where(and(eq(sequenceSteps.sequenceId, id), isNull(sequenceSteps.deletedAt)))
    .orderBy(asc(sequenceSteps.order));
  const liveIds = new Set(live.map((l) => l.id));
  const given = new Set(stepIds);
  if (given.size !== stepIds.length) throw unprocessable('stepIds contains duplicates');
  if (given.size !== liveIds.size || [...given].some((g) => !liveIds.has(g))) {
    throw unprocessable('stepIds must contain every step of the sequence exactly once', {
      missing: [...liveIds].filter((l) => !given.has(l)),
      unknown: stepIds.filter((s) => !liveIds.has(s)),
    });
  }
  await withTx(ctx.db, async (tx) => {
    for (let i = 0; i < stepIds.length; i++) {
      await tx.update(sequenceSteps).set({ order: i + 1 }).where(eq(sequenceSteps.id, stepIds[i]!));
    }
    await tx.update(sequences).set({ updatedAt: ctx.clock.now() }).where(eq(sequences.id, id));
  });
  return getSequence(ctx, id, 'sequenceSteps');
}

export function assertCanDeleteStep(ctx: Ctx, seq: SequenceRow) {
  if (isManagerOrAdmin(ctx.principal)) return;
  if (ctx.principal.userId === seq.ownerId) return;
  throw insufficientPermission('Users can only delete steps in sequences they own');
}
