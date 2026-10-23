import { and, eq, isNull } from 'drizzle-orm';
import { emails, messages, sequenceStates, sequenceSteps, sequences, stepExecutions, tasks } from '@cooks/db';
import type { Ctx } from '../context.js';
import { emitEvent } from '../events.js';
import { advanceEnrollment } from './advance.js';

export type ExecuteResult = 'task_created' | 'email_queued' | 'message_queued' | 'call_queued' | 'skipped' | 'already_done';

/** Step actions that run without a human. Everything else materializes a Task. */
export const AUTO_EMAIL_ACTIONS = new Set(['auto_email', 'auto_email_reply']);
/** Text channels delivered through Inkbox by the worker (`message.send`). */
export const AUTO_MESSAGE_ACTIONS = new Set(['auto_sms', 'auto_imessage']);
/** Hosted AI call placed through Inkbox by the worker (`inkbox.call`). */
export const AUTO_CALL_ACTIONS = new Set(['auto_ai_call']);

/**
 * Fire a scheduled step. Idempotent: the (enrollment, step) execution row is unique,
 * so a duplicate job delivery is a no-op.
 */
export async function executeStep(ctx: Ctx, stateId: string, stepId: string): Promise<ExecuteResult> {
  const now = ctx.clock.now();
  const [state] = await ctx.db
    .select()
    .from(sequenceStates)
    .where(and(eq(sequenceStates.id, stateId), isNull(sequenceStates.deletedAt)))
    .limit(1);
  if (!state || state.state !== 'active' || state.holdReason) return 'skipped';
  if (state.currentStepId !== stepId || state.stepPhase !== 'scheduled') return 'skipped';

  const [seq] = await ctx.db.select().from(sequences).where(eq(sequences.id, state.sequenceId)).limit(1);
  if (!seq || !seq.enabled) {
    await ctx.db.update(sequenceStates).set({ holdReason: 'sequence_disabled' }).where(eq(sequenceStates.id, stateId));
    return 'skipped';
  }

  const [step] = await ctx.db
    .select()
    .from(sequenceSteps)
    .where(and(eq(sequenceSteps.id, stepId), isNull(sequenceSteps.deletedAt)))
    .limit(1);
  if (!step) {
    // Step deleted while scheduled: fall through to whatever is next by order.
    await ctx.db.update(sequenceStates).set({ stepPhase: 'done', lastStepDoneAt: now }).where(eq(sequenceStates.id, stateId));
    await advanceEnrollment(ctx, stateId, { prevDoneAt: now });
    return 'skipped';
  }

  const inserted = await ctx.db
    .insert(stepExecutions)
    .values({ workspaceId: state.workspaceId, sequenceStateId: stateId, sequenceStepId: stepId, status: 'running', startedAt: now })
    .onConflictDoNothing()
    .returning({ id: stepExecutions.id });
  const execution = inserted[0];
  if (!execution) return 'already_done';

  if (AUTO_EMAIL_ACTIONS.has(step.action)) {
    const [email] = await ctx.db
      .insert(emails)
      .values({
        workspaceId: state.workspaceId,
        prospectId: state.prospectId,
        accountId: state.accountId,
        sequenceId: state.sequenceId,
        sequenceStateId: stateId,
        sequenceStepId: stepId,
        mailboxId: state.mailboxId,
        ownerId: state.ownerId,
        direction: 'outbound',
        status: 'queued',
      })
      .returning({ id: emails.id });
    await ctx.db.update(stepExecutions).set({ emailId: email!.id }).where(eq(stepExecutions.id, execution.id));
    await ctx.db.update(sequenceStates).set({ stepPhase: 'executing' }).where(eq(sequenceStates.id, stateId));
    await ctx.jobs.send('email.send', { emailId: email!.id, executionId: execution.id, workspaceId: state.workspaceId }, { singletonKey: `email:${email!.id}` });
    return 'email_queued';
  }

  if (AUTO_MESSAGE_ACTIONS.has(step.action)) {
    const [m] = await ctx.db
      .insert(messages)
      .values({
        workspaceId: state.workspaceId,
        prospectId: state.prospectId,
        accountId: state.accountId,
        ownerId: state.ownerId,
        sequenceId: state.sequenceId,
        sequenceStateId: stateId,
        sequenceStepId: stepId,
        channel: step.action === 'auto_imessage' ? 'imessage' : 'sms',
        direction: 'outbound',
        status: 'queued',
        body: step.body ?? step.note ?? '',
        provider: 'inkbox',
      })
      .returning({ id: messages.id });
    await ctx.db.update(sequenceStates).set({ stepPhase: 'executing' }).where(eq(sequenceStates.id, stateId));
    await ctx.jobs.send('message.send', { messageId: m!.id, workspaceId: state.workspaceId }, { singletonKey: `msg:${m!.id}` });
    return 'message_queued';
  }
  if (AUTO_CALL_ACTIONS.has(step.action)) {
    await ctx.db.update(sequenceStates).set({ stepPhase: 'executing' }).where(eq(sequenceStates.id, stateId));
    await ctx.jobs.send('inkbox.call', { stateId, stepId, workspaceId: state.workspaceId }, { singletonKey: `inkcall:${stateId}:${stepId}` });
    return 'call_queued';
  }

  const [task] = await ctx.db
    .insert(tasks)
    .values({
      workspaceId: state.workspaceId,
      prospectId: state.prospectId,
      accountId: state.accountId,
      ownerId: state.ownerId,
      action: step.action,
      status: 'ready',
      completed: false,
      priority: 'normal',
      dueAt: state.nextRunAt ?? now,
      note: step.note,
      sequenceId: state.sequenceId,
      sequenceStateId: stateId,
      sequenceStepId: stepId,
    })
    .returning({ id: tasks.id });
  await ctx.db.update(stepExecutions).set({ status: 'task_created', taskId: task!.id }).where(eq(stepExecutions.id, execution.id));
  await ctx.db.update(sequenceStates).set({ stepPhase: 'awaiting_task' }).where(eq(sequenceStates.id, stateId));
  if (step.aiEmail && step.action.includes('email')) {
    await ctx.jobs.send('ai.draft_email', { taskId: task!.id, workspaceId: state.workspaceId }, { singletonKey: `draft:${task!.id}` });
  }
  await emitEvent(ctx.db, {
    workspaceId: state.workspaceId,
    type: 'task.created',
    aggregateType: 'task',
    aggregateId: task!.id,
    payload: { taskId: task!.id, sequenceStateId: stateId, sequenceStepId: stepId, action: step.action },
  });
  return 'task_created';
}
