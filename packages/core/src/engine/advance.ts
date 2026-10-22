import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { accounts, prospects, sequenceStates, sequenceSteps, sequences, users, workspaces } from '@cooks/db';
import type { Ctx } from '../context.js';
import { computeNextRunAt, pickZone, type SendWindow } from './scheduling.js';
import { finishEnrollment } from './transitions.js';

export type AdvanceResult = 'scheduled' | 'finished' | 'skipped' | 'held';

async function scheduleContext(ctx: Ctx, state: typeof sequenceStates.$inferSelect) {
  const [p] = await ctx.db.select().from(prospects).where(eq(prospects.id, state.prospectId)).limit(1);
  const [a] = state.accountId ? await ctx.db.select().from(accounts).where(eq(accounts.id, state.accountId)).limit(1) : [];
  const [o] = await ctx.db.select().from(users).where(eq(users.id, state.ownerId)).limit(1);
  const [w] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, state.workspaceId)).limit(1);
  const settings = w?.settings ?? {};
  return {
    tz: pickZone(p?.timezone, a?.timezone, o?.timezone, settings.timezone),
    window: settings.sendWindow as SendWindow | undefined,
    jitterSeconds: settings.jitterSeconds,
  };
}

/**
 * Move an active enrollment to its next step: pick the next live step by order,
 * compute when it is due, and enqueue `step.execute` for that moment.
 */
export async function advanceEnrollment(ctx: Ctx, stateId: string, opts: { prevDoneAt?: Date } = {}): Promise<AdvanceResult> {
  const [state] = await ctx.db
    .select()
    .from(sequenceStates)
    .where(and(eq(sequenceStates.id, stateId), isNull(sequenceStates.deletedAt)))
    .limit(1);
  if (!state || state.state !== 'active' || state.holdReason) return 'skipped';

  const [seq] = await ctx.db.select().from(sequences).where(eq(sequences.id, state.sequenceId)).limit(1);
  if (!seq || seq.deletedAt) {
    await finishEnrollment(ctx, stateId, 'removed');
    return 'finished';
  }
  if (!seq.enabled) {
    await ctx.db.update(sequenceStates).set({ holdReason: 'sequence_disabled' }).where(eq(sequenceStates.id, stateId));
    return 'held';
  }

  const [next] = await ctx.db
    .select()
    .from(sequenceSteps)
    .where(
      and(
        eq(sequenceSteps.sequenceId, state.sequenceId),
        isNull(sequenceSteps.deletedAt),
        gt(sequenceSteps.order, state.currentStepOrder ?? -1),
      ),
    )
    .orderBy(asc(sequenceSteps.order), asc(sequenceSteps.id))
    .limit(1);
  if (!next) {
    await finishEnrollment(ctx, stateId, 'completed');
    return 'finished';
  }

  const now = ctx.clock.now();
  const base = state.currentStepOrder == null ? (state.scheduledAt ?? now) : (opts.prevDoneAt ?? state.lastStepDoneAt ?? now);
  const sc = await scheduleContext(ctx, state);
  const nextRunAt = computeNextRunAt({
    base,
    intervalMinutes: next.intervalMinutes,
    tz: sc.tz,
    window: sc.window,
    jitterSeconds: sc.jitterSeconds,
    seed: `${stateId}:${next.id}`,
    now,
  });

  const updated = await ctx.db
    .update(sequenceStates)
    .set({
      currentStepId: next.id,
      currentStepOrder: next.order,
      stepPhase: 'scheduled',
      nextRunAt,
      version: sql`${sequenceStates.version} + 1`,
    })
    .where(and(eq(sequenceStates.id, stateId), eq(sequenceStates.version, state.version)))
    .returning({ id: sequenceStates.id });
  if (updated.length === 0) return 'skipped'; // lost a race; the winner scheduled it

  const jobId = await ctx.jobs.send(
    'step.execute',
    { stateId, stepId: next.id, workspaceId: state.workspaceId },
    { startAfter: nextRunAt, singletonKey: `${stateId}:${next.id}` },
  );
  if (jobId) await ctx.db.update(sequenceStates).set({ pendingJobId: jobId }).where(eq(sequenceStates.id, stateId));
  return 'scheduled';
}
