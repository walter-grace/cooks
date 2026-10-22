import { and, eq, gte, inArray, lte, type SQL } from 'drizzle-orm';
import { sequenceStates, tasks } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { emitEvent } from '../events.js';
import { parseInclude, ref, refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { parseBool, parseDate, parseEnum } from '../query.js';
import { onTaskResolved } from '../engine/transitions.js';
import { getProspectRow, serializeProspect } from './prospects.js';
import { idFilter, isUuid, isoReq, paginate, requireMember, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';
import { prospects } from '@cooks/db';

export type TaskRow = typeof tasks.$inferSelect;
export const TASK_INCLUDES = ['prospect'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export function serializeTask(t: TaskRow, prospect?: Record<string, unknown>) {
  return {
    id: t.id,
    action: t.action,
    completed: t.completed,
    dueAt: isoReq(t.dueAt),
    note: t.note,
    status: t.status,
    priority: t.priority,
    owner: ref('users', t.ownerId),
    prospect: prospect ?? ref('prospects', t.prospectId),
    sequence: refOrNull('sequences', t.sequenceId),
    sequenceState: refOrNull('sequenceStates', t.sequenceStateId),
    sequenceStep: refOrNull('sequenceSteps', t.sequenceStepId),
    createdAt: isoReq(t.createdAt),
    updatedAt: isoReq(t.updatedAt),
  };
}

async function serializeTasks(ctx: Ctx, rows: TaskRow[], includes: string[]) {
  if (!includes.includes('prospect') || rows.length === 0) return rows.map((r) => serializeTask(r));
  const ps = await ctx.db.select().from(prospects).where(inArray(prospects.id, [...new Set(rows.map((r) => r.prospectId))]));
  const byId = new Map(ps.map((p) => [p.id, p]));
  return rows.map((r) => {
    const p = byId.get(r.prospectId);
    return serializeTask(r, p ? serializeProspect(p, { customFields: false, states: [] }) : undefined);
  });
}

export async function listTasks(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; include?: unknown; requestUrl: string }) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, TASK_INCLUDES);
  const conds: SQL[] = [tenantWhere(tasks, ctx.principal.workspaceId)];
  const idc = idFilter(tasks.id, f.id);
  if (idc) conds.push(idc);
  for (const [key, col] of [
    ['sequence', tasks.sequenceId],
    ['sequenceStep', tasks.sequenceStepId],
    ['prospect', tasks.prospectId],
    ['account', tasks.accountId],
    ['owner', tasks.ownerId],
  ] as const) {
    const v = (f[key] as Record<string, unknown> | undefined)?.id;
    if (typeof v === 'string' && v) {
      if (!isUuid(v)) throw badRequest(`filter[${key}][id] must be a UUID`);
      conds.push(eq(col, v));
    }
  }
  if (typeof f.action === 'string' && f.action) conds.push(eq(tasks.action, f.action as TaskRow['action']));
  if (typeof f.status === 'string' && f.status) conds.push(eq(tasks.status, f.status));
  const priority = parseEnum(f.priority, PRIORITIES, 'filter[priority]');
  if (priority) conds.push(eq(tasks.priority, priority));
  const completed = parseBool(f.completed, 'filter[completed]');
  if (completed !== undefined) conds.push(eq(tasks.completed, completed));
  const due = (f.dueAt ?? {}) as Record<string, unknown>;
  const dueGte = parseDate(due.gte, 'filter[dueAt][gte]');
  const dueLte = parseDate(due.lte, 'filter[dueAt][lte]');
  if (dueGte) conds.push(gte(tasks.dueAt, dueGte));
  if (dueLte) conds.push(lte(tasks.dueAt, dueLte));
  const stateFilter = (f.sequenceState as Record<string, unknown> | undefined)?.state;
  const st = parseEnum(stateFilter, ['active', 'paused', 'finished', 'pending_start'] as const, 'filter[sequenceState][state]');
  if (st) {
    const sub = ctx.db.select({ id: sequenceStates.id }).from(sequenceStates).where(and(eq(sequenceStates.workspaceId, ctx.principal.workspaceId), eq(sequenceStates.state, st)));
    conds.push(inArray(tasks.sequenceStateId, sub));
  }
  conds.push(...updatedAtFilter(tasks.updatedAt, f, 'lt'));
  const page = await paginate({
    table: tasks,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(tasks)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: await serializeTasks(ctx, page.data, includes), links: page.links };
}

export async function getTaskRow(ctx: Ctx, id: string): Promise<TaskRow> {
  uuidOr404(id, 'Task');
  const [row] = await ctx.db
    .select()
    .from(tasks)
    .where(and(tenantWhere(tasks, ctx.principal.workspaceId), eq(tasks.id, id)))
    .limit(1);
  if (!row) throw notFound('Task');
  return row;
}

export async function getTask(ctx: Ctx, id: string, include?: unknown) {
  const includes = parseInclude(include, TASK_INCLUDES);
  return (await serializeTasks(ctx, [await getTaskRow(ctx, id)], includes))[0]!;
}

export interface CreateTaskInput {
  action: string;
  dueAt: string;
  ownerId: string;
  prospectId: string;
  note?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export async function createTask(ctx: Ctx, input: CreateTaskInput) {
  const ownerId = await requireMember(ctx, input.ownerId, 'ownerId');
  const prospect = await getProspectRow(ctx, input.prospectId).catch(() => {
    throw unprocessable('prospectId does not reference a prospect in this workspace', { field: 'prospectId' });
  });
  const [row] = await ctx.db
    .insert(tasks)
    .values({
      workspaceId: ctx.principal.workspaceId,
      prospectId: prospect.id,
      accountId: prospect.accountId,
      ownerId,
      action: input.action as TaskRow['action'],
      dueAt: new Date(input.dueAt),
      note: input.note ?? null,
      priority: input.priority ?? 'normal',
      status: 'ready',
    })
    .returning();
  await emitEvent(ctx.db, { workspaceId: ctx.principal.workspaceId, type: 'task.created', aggregateType: 'task', aggregateId: row!.id, payload: { taskId: row!.id, action: row!.action } });
  return serializeTask(row!);
}

export async function updateTask(ctx: Ctx, id: string, input: { dueAt?: string; ownerId?: string; priority?: TaskRow['priority']; note?: string | null }) {
  await getTaskRow(ctx, id);
  const ownerId = input.ownerId !== undefined ? await requireMember(ctx, input.ownerId, 'ownerId') : undefined;
  const [row] = await ctx.db
    .update(tasks)
    .set({
      ...(input.dueAt !== undefined ? { dueAt: new Date(input.dueAt) } : {}),
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
    })
    .where(eq(tasks.id, id))
    .returning();
  return serializeTask(row!);
}

export async function deleteTask(ctx: Ctx, id: string) {
  const row = await getTaskRow(ctx, id);
  await ctx.db.update(tasks).set({ deletedAt: ctx.clock.now(), status: row.completed ? row.status : 'skipped' }).where(eq(tasks.id, id));
  if (!row.completed && row.status !== 'skipped') await onTaskResolved(ctx, row, 'skipped');
}

async function resolve(ctx: Ctx, id: string, outcome: 'completed' | 'skipped') {
  const row = await getTaskRow(ctx, id);
  if (row.completed || row.status === 'skipped') {
    if ((outcome === 'completed' && row.completed) || (outcome === 'skipped' && row.status === 'skipped')) return serializeTask(row);
    throw conflict(`Task is already ${row.completed ? 'completed' : 'skipped'}`);
  }
  const now = ctx.clock.now();
  const [updated] = await ctx.db
    .update(tasks)
    .set(outcome === 'completed' ? { completed: true, status: 'finished', completedAt: now } : { completed: false, status: 'skipped', skippedAt: now })
    .where(eq(tasks.id, id))
    .returning();
  await emitEvent(ctx.db, {
    workspaceId: ctx.principal.workspaceId,
    type: outcome === 'completed' ? 'task.completed' : 'task.skipped',
    aggregateType: 'task',
    aggregateId: id,
    payload: { taskId: id, sequenceStateId: row.sequenceStateId },
  });
  await onTaskResolved(ctx, updated!, outcome);
  return serializeTask(updated!);
}

export const completeTask = (ctx: Ctx, id: string) => resolve(ctx, id, 'completed');
export const skipTask = (ctx: Ctx, id: string) => resolve(ctx, id, 'skipped');
