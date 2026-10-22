import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { emailEvents, emails, mailboxes, prospects, sequenceStates, suppressions, tasks, workspaces } from '@cooks/db';
import type { Ctx } from '../context.js';
import { emitEvent } from '../events.js';
import { finishEnrollment, pauseEnrollment } from '../engine/transitions.js';
import { bumpCounter } from '../services/analytics.js';
import { extractReturnDate } from './parse.js';
import type { InboundMessage } from './provider.js';

export type InboundOutcome =
  | { kind: 'duplicate' }
  | { kind: 'bounce'; hard: boolean; emailId: string | null }
  | { kind: 'auto_reply'; emailId: string; pushedTo?: Date }
  | { kind: 'reply'; emailId: string; outboundId: string | null; action: 'finish' | 'pause' | 'continue' | 'none' }
  | { kind: 'unmatched'; emailId: string };

const normId = (id: string | null | undefined) => (id ? id.trim() : null);

/** Find the outbound email a message answers: Message-ID chain, then thread, then sender + recent outbound. */
async function matchOutbound(ctx: Ctx, mailbox: typeof mailboxes.$inferSelect, msg: InboundMessage) {
  const ws = mailbox.workspaceId;
  const candidates = [normId(msg.inReplyTo), ...msg.references.map(normId)].filter((x): x is string => !!x);
  if (candidates.length) {
    const [row] = await ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.workspaceId, ws), eq(emails.direction, 'outbound'), inArray(emails.messageId, candidates)))
      .orderBy(desc(emails.date))
      .limit(1);
    if (row) return row;
  }
  if (msg.threadId) {
    const [row] = await ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.workspaceId, ws), eq(emails.direction, 'outbound'), eq(emails.threadId, msg.threadId)))
      .orderBy(desc(emails.date))
      .limit(1);
    if (row) return row;
  }
  const since = new Date(ctx.clock.now().getTime() - 30 * 86_400_000);
  const [row] = await ctx.db
    .select()
    .from(emails)
    .where(and(eq(emails.workspaceId, ws), eq(emails.direction, 'outbound'), eq(emails.status, 'sent'), eq(emails.mailboxId, mailbox.id), sql`lower(${emails.toAddr}) = ${msg.from.toLowerCase()}`, gte(emails.date, since)))
    .orderBy(desc(emails.date))
    .limit(1);
  return row ?? null;
}

async function storeInbound(ctx: Ctx, mailbox: typeof mailboxes.$inferSelect, msg: InboundMessage, outbound: typeof emails.$inferSelect | null, prospectId: string | null, autoSubmitted: boolean) {
  const [row] = await ctx.db
    .insert(emails)
    .values({
      workspaceId: mailbox.workspaceId,
      prospectId: prospectId ?? outbound?.prospectId ?? null,
      accountId: outbound?.accountId ?? null,
      sequenceId: outbound?.sequenceId ?? null,
      sequenceStateId: outbound?.sequenceStateId ?? null,
      sequenceStepId: outbound?.sequenceStepId ?? null,
      mailboxId: mailbox.id,
      ownerId: mailbox.userId,
      type: mailbox.provider === 'gmail' ? 'gmail' : mailbox.provider === 'ms_graph' ? 'outlook' : 'smtp',
      direction: 'inbound',
      status: 'received',
      fromAddr: msg.from,
      toAddr: msg.to[0] ?? mailbox.email,
      recipients: msg.to,
      subject: msg.subject,
      bodyText: msg.text.slice(0, 200_000),
      bodyHtml: msg.html?.slice(0, 500_000) ?? null,
      messageId: msg.messageId,
      inReplyTo: msg.inReplyTo,
      threadId: msg.threadId ?? outbound?.threadId ?? null,
      providerMessageId: msg.providerId,
      date: msg.date,
      autoSubmitted,
    })
    .returning();
  return row!;
}

/**
 * Handle one message fetched from a rep's inbox. Idempotent on Message-ID / provider id.
 * Bounces suppress and finish; auto-replies are stored (and push the next step past a stated
 * return date); real replies mark the outbound replied, apply the workspace reply policy,
 * create a follow-up task and (optionally) queue classification.
 */
export async function processInbound(ctx: Ctx, mailbox: typeof mailboxes.$inferSelect, msg: InboundMessage, opts: { classify?: boolean } = {}): Promise<InboundOutcome> {
  const now = ctx.clock.now();
  const ws = mailbox.workspaceId;
  const dupWhere = [eq(emails.providerMessageId, msg.providerId), ...(msg.messageId ? [eq(emails.messageId, msg.messageId)] : [])];
  const [dup] = await ctx.db
    .select({ id: emails.id })
    .from(emails)
    .where(and(eq(emails.workspaceId, ws), eq(emails.direction, 'inbound'), eq(emails.mailboxId, mailbox.id), or(...dupWhere)))
    .limit(1);
  if (dup) return { kind: 'duplicate' };

  // ---- bounces (DSN)
  if (msg.dsn) {
    const hard = msg.dsn.status.startsWith('5') || msg.dsn.action === 'failed';
    let outbound: typeof emails.$inferSelect | null = null;
    if (msg.dsn.originalMessageId) {
      [outbound = null] = await ctx.db.select().from(emails).where(and(eq(emails.workspaceId, ws), eq(emails.messageId, msg.dsn.originalMessageId))).limit(1);
    }
    if (!outbound && msg.dsn.recipient) {
      const since = new Date(now.getTime() - 7 * 86_400_000);
      [outbound = null] = await ctx.db
        .select()
        .from(emails)
        .where(and(eq(emails.workspaceId, ws), eq(emails.direction, 'outbound'), sql`lower(${emails.toAddr}) = ${msg.dsn.recipient}`, gte(emails.date, since)))
        .orderBy(desc(emails.date))
        .limit(1);
    }
    await storeInbound(ctx, mailbox, msg, outbound, outbound?.prospectId ?? null, true);
    const recipient = (msg.dsn.recipient ?? outbound?.toAddr ?? '').toLowerCase();
    if (outbound) {
      await ctx.db.update(emails).set({ bouncedAt: now, error: msg.dsn.diagnostic ?? `DSN ${msg.dsn.status}` }).where(eq(emails.id, outbound.id));
      await ctx.db.insert(emailEvents).values({ workspaceId: ws, emailId: outbound.id, kind: 'bounced', occurredAt: now, meta: { status: msg.dsn.status, hard }, rolledUpAt: now });
      if (outbound.sequenceId) await bumpCounter(ctx.db, ws, 'sequence', outbound.sequenceId, 'email.bounced');
      if (outbound.sequenceStepId) await bumpCounter(ctx.db, ws, 'sequence_step', outbound.sequenceStepId, 'email.bounced');
      await emitEvent(ctx.db, { workspaceId: ws, type: 'email.bounced', aggregateType: 'email', aggregateId: outbound.id, payload: { emailId: outbound.id, prospectId: outbound.prospectId, hard, status: msg.dsn.status }, dedupeKey: `${outbound.id}:bounced` });
    }
    if (hard && recipient) {
      await ctx.db.insert(suppressions).values({ workspaceId: ws, emailLower: recipient, reason: 'hard_bounce', source: msg.messageId ?? msg.providerId }).onConflictDoNothing();
      const pid = outbound?.prospectId;
      if (pid) {
        await ctx.db.update(prospects).set({ emailStatus: 'bounced' }).where(eq(prospects.id, pid));
        const active = await ctx.db.select({ id: sequenceStates.id }).from(sequenceStates).where(and(eq(sequenceStates.prospectId, pid), sql`${sequenceStates.state} <> 'finished'`, isNull(sequenceStates.deletedAt)));
        for (const s of active) await finishEnrollment(ctx, s.id, 'bounced');
      }
    }
    return { kind: 'bounce', hard, emailId: outbound?.id ?? null };
  }

  const outbound = await matchOutbound(ctx, mailbox, msg);
  let prospectId = outbound?.prospectId ?? null;
  if (!prospectId) {
    const [p] = await ctx.db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.workspaceId, ws), isNull(prospects.deletedAt), sql`lower(${prospects.primaryEmail}) = ${msg.from.toLowerCase()}`)).limit(1);
    prospectId = p?.id ?? null;
  }
  const stored = await storeInbound(ctx, mailbox, msg, outbound, prospectId, msg.autoSubmitted);

  // ---- auto replies / out of office: never finish, maybe push the next step
  if (msg.autoSubmitted) {
    let pushedTo: Date | undefined;
    const back = extractReturnDate(`${msg.subject}\n${msg.text}`, now);
    if (back && outbound?.sequenceStateId) {
      const [st] = await ctx.db.select().from(sequenceStates).where(eq(sequenceStates.id, outbound.sequenceStateId)).limit(1);
      const target = new Date(back.getTime() + 86_400_000); // the day after they return
      if (st && st.state === 'active' && st.stepPhase === 'scheduled' && st.currentStepId && (st.nextRunAt?.getTime() ?? 0) < target.getTime() && target.getTime() - now.getTime() <= 60 * 86_400_000) {
        await ctx.db.update(sequenceStates).set({ nextRunAt: target }).where(eq(sequenceStates.id, st.id));
        await ctx.jobs.send('step.execute', { stateId: st.id, stepId: st.currentStepId, workspaceId: ws }, { startAfter: target, singletonKey: `${st.id}:${st.currentStepId}:ooo` });
        pushedTo = target;
      }
    }
    return { kind: 'auto_reply', emailId: stored.id, pushedTo };
  }

  if (!outbound && !prospectId) return { kind: 'unmatched', emailId: stored.id };

  // ---- a real reply
  if (outbound) {
    await ctx.db.update(emails).set({ repliedAt: outbound.repliedAt ?? now }).where(eq(emails.id, outbound.id));
    if (!outbound.repliedAt) {
      await ctx.db.insert(emailEvents).values({ workspaceId: ws, emailId: outbound.id, kind: 'replied', occurredAt: now, rolledUpAt: now });
      if (outbound.sequenceId) await bumpCounter(ctx.db, ws, 'sequence', outbound.sequenceId, 'email.replied');
      if (outbound.sequenceStepId) await bumpCounter(ctx.db, ws, 'sequence_step', outbound.sequenceStepId, 'email.replied');
    }
    await emitEvent(ctx.db, { workspaceId: ws, type: 'email.replied', aggregateType: 'email', aggregateId: outbound.id, payload: { emailId: outbound.id, inboundEmailId: stored.id, prospectId: outbound.prospectId, from: msg.from, subject: msg.subject }, dedupeKey: `${outbound.id}:replied:${stored.id}` });
  }
  let action: 'finish' | 'pause' | 'continue' | 'none' = 'none';
  const stateId = outbound?.sequenceStateId;
  if (stateId) {
    const [st] = await ctx.db.select().from(sequenceStates).where(eq(sequenceStates.id, stateId)).limit(1);
    const [w] = await ctx.db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ws)).limit(1);
    const policy = st?.replyBehavior ?? w?.settings.replyBehavior ?? 'finish';
    if (st && st.state !== 'finished') {
      action = policy;
      if (policy === 'finish') await finishEnrollment(ctx, st.id, 'replied');
      else if (policy === 'pause') await pauseEnrollment(ctx, st.id);
    }
  }
  if (prospectId) {
    const ownerId = outbound?.ownerId ?? mailbox.userId;
    const [task] = await ctx.db
      .insert(tasks)
      .values({
        workspaceId: ws,
        prospectId,
        accountId: outbound?.accountId ?? null,
        ownerId,
        action: 'manual_email_reply',
        status: 'ready',
        priority: 'high',
        dueAt: now,
        note: `Reply received: "${msg.subject}". ${msg.text.trim().slice(0, 280)}`,
        sequenceId: outbound?.sequenceId ?? null,
        sequenceStateId: stateId ?? null,
        sequenceStepId: outbound?.sequenceStepId ?? null,
      })
      .returning({ id: tasks.id });
    await emitEvent(ctx.db, { workspaceId: ws, type: 'task.created', aggregateType: 'task', aggregateId: task!.id, payload: { taskId: task!.id, reason: 'reply', inboundEmailId: stored.id } });
    if (opts.classify) await ctx.jobs.send('ai.classify_reply', { inboundEmailId: stored.id, taskId: task!.id, workspaceId: ws }, { singletonKey: `classify:${stored.id}` });
  }
  return { kind: 'reply', emailId: stored.id, outboundId: outbound?.id ?? null, action };
}
