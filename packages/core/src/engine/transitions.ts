import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { sequenceStates, stepExecutions, tasks } from '@cooks/db';
import type { Ctx } from '../context.js';
import { emitEvent } from '../events.js';

export type FinishReason = 'completed' | 'replied' | 'unsubscribed' | 'bounced' | 'manual' | 'removed' | 'prospect_deleted' | 'error';

async function cancelPending(ctx: Ctx, jobId: string | null) {
  if (jobId && ctx.jobs.cancel) await ctx.jobs.cancel('step.execute', jobId).catch(() => {});
}

async function openTaskIds(ctx: Ctx, stateId: string) {
  const rows = await ctx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.sequenceStateId, stateId), eq(tasks.completed, false), isNull(tasks.deletedAt), inArray(tasks.status, ['ready', 'pending'])));
  return rows.map((r) => r.id);
}

/** Terminal and idempotent. Skips open tasks, cancels the pending job, emits the event. */
export async function finishEnrollment(ctx: Ctx, stateId: string, reason: FinishReason): Promise<boolean> {
  const now = ctx.clock.now();
  const [row] = await ctx.db
    .update(sequenceStates)
    .set({ state: 'finished', finishReason: reason, finishedAt: now, stepPhase: 'done', nextRunAt: null, version: sql`${sequenceStates.version} + 1` })
    .where(and(eq(sequenceStates.id, stateId), sql`${sequenceStates.state} <> 'finished'`))
    .returning();
  if (!row) return false;
  await cancelPending(ctx, row.pendingJobId);
  const open = await openTaskIds(ctx, stateId);
  if (open.length) await ctx.db.update(tasks).set({ status: 'skipped', skippedAt: now }).where(inArray(tasks.id, open));
  await emitEvent(ctx.db, {
    workspaceId: row.workspaceId,
    type: 'sequence_state.finished',
    aggregateType: 'sequence_state',
    aggregateId: stateId,
    payload: { sequenceStateId: stateId, sequenceId: row.sequenceId, prospectId: row.prospectId, reason },
    dedupeKey: `${stateId}:finished`,
  });
  return true;
}

export async function pauseEnrollment(ctx: Ctx, stateId: string): Promise<boolean> {
  const [row] = await ctx.db
    .update(sequenceStates)
    .set({ state: 'paused', version: sql`${sequenceStates.version} + 1` })
    .where(and(eq(sequenceStates.id, stateId), inArray(sequenceStates.state, ['active', 'pending_start'])))
    .returning();
  if (!row) return false;
  await cancelPending(ctx, row.pendingJobId);
  const open = await openTaskIds(ctx, stateId);
  if (open.length) await ctx.db.update(tasks).set({ status: 'pending' }).where(inArray(tasks.id, open));
  await emitEvent(ctx.db, {
    workspaceId: row.workspaceId,
    type: 'sequence_state.paused',
    aggregateType: 'sequence_state',
    aggregateId: stateId,
    payload: { sequenceStateId: stateId },
  });
  return true;
}

export async function resumeEnrollment(ctx: Ctx, stateId: string): Promise<boolean> {
  const now = ctx.clock.now();
  const [row] = await ctx.db
    .update(sequenceStates)
    .set({ state: 'active', holdReason: null, version: sql`${sequenceStates.version} + 1` })
    .where(and(eq(sequenceStates.id, stateId), eq(sequenceStates.state, 'paused')))
    .returning();
  if (!row) return false;
  if (row.stepPhase === 'awaiting_task') {
    await ctx.db.update(tasks).set({ status: 'ready' }).where(and(eq(tasks.sequenceStateId, stateId), eq(tasks.status, 'pending')));
  } else if (row.stepPhase === 'scheduled' && row.currentStepId) {
    const startAfter = new Date(Math.max(now.getTime(), row.nextRunAt?.getTime() ?? 0));
    const jobId = await ctx.jobs.send(
      'step.execute',
      { stateId, stepId: row.currentStepId, workspaceId: row.workspaceId },
      { startAfter, singletonKey: `${stateId}:${row.currentStepId}` },
    );
    await ctx.db.update(sequenceStates).set({ nextRunAt: startAfter, pendingJobId: jobId ?? row.pendingJobId }).where(eq(sequenceStates.id, stateId));
  } else if (row.stepPhase === 'idle' || row.stepPhase === 'done') {
    await ctx.jobs.send('enrollment.advance', { stateId, workspaceId: row.workspaceId }, { singletonKey: `advance:${stateId}` });
  }
  await emitEvent(ctx.db, {
    workspaceId: row.workspaceId,
    type: 'sequence_state.resumed',
    aggregateType: 'sequence_state',
    aggregateId: stateId,
    payload: { sequenceStateId: stateId },
  });
  return true;
}

/** A manual step's task was completed or skipped: close the execution and queue the next step. */
export async function onTaskResolved(ctx: Ctx, task: typeof tasks.$inferSelect, outcome: 'completed' | 'skipped'): Promise<void> {
  if (!task.sequenceStateId || !task.sequenceStepId) return;
  const now = ctx.clock.now();
  await ctx.db
    .update(stepExecutions)
    .set({ status: outcome === 'completed' ? 'sent' : 'skipped', finishedAt: now })
    .where(and(eq(stepExecutions.sequenceStateId, task.sequenceStateId), eq(stepExecutions.sequenceStepId, task.sequenceStepId)));
  const [row] = await ctx.db
    .update(sequenceStates)
    .set({ stepPhase: 'done', lastStepDoneAt: now })
    .where(and(eq(sequenceStates.id, task.sequenceStateId), eq(sequenceStates.currentStepId, task.sequenceStepId), eq(sequenceStates.stepPhase, 'awaiting_task')))
    .returning({ id: sequenceStates.id, workspaceId: sequenceStates.workspaceId, state: sequenceStates.state });
  if (row && row.state === 'active') {
    await ctx.jobs.send('enrollment.advance', { stateId: row.id, workspaceId: row.workspaceId, prevDoneAt: now.toISOString() }, { singletonKey: `advance:${row.id}` });
  }
}

/** Sequence enabled flag flipped: hold or release every active enrollment. */
export async function setSequenceHold(ctx: Ctx, sequenceId: string, hold: boolean): Promise<void> {
  if (hold) {
    await ctx.db
      .update(sequenceStates)
      .set({ holdReason: 'sequence_disabled' })
      .where(and(eq(sequenceStates.sequenceId, sequenceId), eq(sequenceStates.state, 'active'), isNull(sequenceStates.deletedAt)));
    return;
  }
  const rows = await ctx.db
    .update(sequenceStates)
    .set({ holdReason: null })
    .where(and(eq(sequenceStates.sequenceId, sequenceId), eq(sequenceStates.holdReason, 'sequence_disabled'), isNull(sequenceStates.deletedAt)))
    .returning({ id: sequenceStates.id, workspaceId: sequenceStates.workspaceId, stepPhase: sequenceStates.stepPhase, currentStepId: sequenceStates.currentStepId, nextRunAt: sequenceStates.nextRunAt });
  const now = ctx.clock.now();
  for (const r of rows) {
    if (r.stepPhase === 'scheduled' && r.currentStepId) {
      const startAfter = new Date(Math.max(now.getTime(), r.nextRunAt?.getTime() ?? 0));
      await ctx.jobs.send('step.execute', { stateId: r.id, stepId: r.currentStepId, workspaceId: r.workspaceId }, { startAfter, singletonKey: `${r.id}:${r.currentStepId}` });
    } else if (r.stepPhase === 'idle' || r.stepPhase === 'done') {
      await ctx.jobs.send('enrollment.advance', { stateId: r.id, workspaceId: r.workspaceId }, { singletonKey: `advance:${r.id}` });
    }
  }
}

/** Promote `pending_start` enrollments whose scheduledAt has arrived. Cron-driven. */
export async function startPendingEnrollments(ctx: Ctx, limit = 200): Promise<number> {
  const now = ctx.clock.now();
  const rows = await ctx.db
    .update(sequenceStates)
    .set({ state: 'active', version: sql`${sequenceStates.version} + 1` })
    .where(
      and(
        eq(sequenceStates.state, 'pending_start'),
        isNull(sequenceStates.deletedAt),
        or(isNull(sequenceStates.scheduledAt), lte(sequenceStates.scheduledAt, now)),
        inArray(
          sequenceStates.id,
          ctx.db
            .select({ id: sequenceStates.id })
            .from(sequenceStates)
            .where(and(eq(sequenceStates.state, 'pending_start'), isNull(sequenceStates.deletedAt), or(isNull(sequenceStates.scheduledAt), lte(sequenceStates.scheduledAt, now))))
            .limit(limit),
        ),
      ),
    )
    .returning({ id: sequenceStates.id, workspaceId: sequenceStates.workspaceId });
  for (const r of rows) await ctx.jobs.send('enrollment.advance', { stateId: r.id, workspaceId: r.workspaceId }, { singletonKey: `advance:${r.id}` });
  return rows.length;
}
