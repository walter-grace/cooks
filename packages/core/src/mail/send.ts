import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import {
  accounts,
  emailEvents,
  emailTemplates,
  emails,
  mailboxSendState,
  mailboxes,
  prospects,
  sequenceStates,
  sequenceSteps,
  sequences,
  stepExecutions,
  suppressions,
  tasks,
  users,
  workspaces,
} from '@cooks/db';
import type { Ctx } from '../context.js';
import { emitEvent } from '../events.js';
import { bumpCounter } from '../services/analytics.js';
import { pickZone } from '../engine/scheduling.js';
import type { MailProvider } from './provider.js';
import { buildMergeContext, renderTemplate, TemplateError } from './templates.js';

export type SendOutcome =
  | { status: 'sent'; messageId: string }
  | { status: 'rejected'; reason: string }
  | { status: 'deferred'; until: Date; reason: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string };

export interface SendDeps {
  providerFor: (mailbox: typeof mailboxes.$inferSelect | null) => Promise<MailProvider>;
  /** From address when no mailbox is connected (dev / SMTP relay). */
  fallbackFrom?: string | null;
  trackingSecret?: string;
}

export function unsubscribeToken(emailId: string, secret: string): string {
  return `${emailId}.${createHmac('sha256', secret).update(emailId).digest('base64url').slice(0, 24)}`;
}

function domainOf(email: string) {
  return email.split('@')[1]?.toLowerCase() ?? '';
}

/**
 * Deliver one queued email. Resolves mailbox, content (manual draft > overrides > step template),
 * runs pre-send checks, enforces mailbox caps and spacing, sends, records events and
 * advances the enrollment. Safe to call twice: only `queued` rows are processed.
 */
export async function sendQueuedEmail(ctx: Ctx, emailId: string, deps: SendDeps): Promise<SendOutcome> {
  const now = ctx.clock.now();
  const [email] = await ctx.db.select().from(emails).where(and(eq(emails.id, emailId), isNull(emails.deletedAt))).limit(1);
  if (!email) return { status: 'skipped', reason: 'missing' };
  if (email.status !== 'queued') return { status: 'skipped', reason: `status=${email.status}` };

  const [prospect] = email.prospectId ? await ctx.db.select().from(prospects).where(eq(prospects.id, email.prospectId)).limit(1) : [];
  const [account] = prospect?.accountId ? await ctx.db.select().from(accounts).where(eq(accounts.id, prospect.accountId)).limit(1) : [];
  const [owner] = email.ownerId ? await ctx.db.select().from(users).where(eq(users.id, email.ownerId)).limit(1) : [];
  const [ws] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, email.workspaceId)).limit(1);
  const [state] = email.sequenceStateId ? await ctx.db.select().from(sequenceStates).where(eq(sequenceStates.id, email.sequenceStateId)).limit(1) : [];
  const [step] = email.sequenceStepId ? await ctx.db.select().from(sequenceSteps).where(eq(sequenceSteps.id, email.sequenceStepId)).limit(1) : [];
  const [seq] = email.sequenceId ? await ctx.db.select().from(sequences).where(eq(sequences.id, email.sequenceId)).limit(1) : [];

  const reject = async (reason: string): Promise<SendOutcome> => {
    await ctx.db.update(emails).set({ status: 'rejected', rejectReason: reason }).where(eq(emails.id, emailId));
    if (state && step) {
      // Block the enrollment on a human: a task the owner must resolve, which then advances.
      const [t] = await ctx.db
        .insert(tasks)
        .values({
          workspaceId: email.workspaceId,
          prospectId: state.prospectId,
          accountId: state.accountId,
          ownerId: state.ownerId,
          action: 'manual_email',
          status: 'ready',
          priority: 'high',
          dueAt: now,
          note: `Automatic email could not be sent: ${reason}. Send manually or skip.`,
          sequenceId: state.sequenceId,
          sequenceStateId: state.id,
          sequenceStepId: step.id,
          draftEmailId: emailId,
        })
        .returning({ id: tasks.id });
      await ctx.db
        .update(stepExecutions)
        .set({ status: 'task_created', taskId: t!.id })
        .where(and(eq(stepExecutions.sequenceStateId, state.id), eq(stepExecutions.sequenceStepId, step.id)));
      await ctx.db.update(sequenceStates).set({ stepPhase: 'awaiting_task' }).where(eq(sequenceStates.id, state.id));
    }
    return { status: 'rejected', reason };
  };

  // ---- recipient checks
  const to = email.toAddr ?? prospect?.primaryEmail ?? null;
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return reject('Prospect has no valid email address');
  if (prospect?.unsubscribedAt || prospect?.doNotContact || prospect?.emailStatus === 'bounced') return reject('Prospect is unsubscribed, bounced or do-not-contact');
  const [sup] = await ctx.db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.workspaceId, email.workspaceId), or(eq(suppressions.emailLower, to.toLowerCase()), eq(suppressions.domain, domainOf(to)))))
    .limit(1);
  if (sup) return reject('Recipient is on the suppression list');

  // ---- mailbox
  let mailbox: typeof mailboxes.$inferSelect | null = null;
  if (email.mailboxId) [mailbox = null] = await ctx.db.select().from(mailboxes).where(eq(mailboxes.id, email.mailboxId)).limit(1);
  if (!mailbox && email.ownerId) {
    const rows = await ctx.db
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.workspaceId, email.workspaceId), eq(mailboxes.userId, email.ownerId), isNull(mailboxes.deletedAt), eq(mailboxes.status, 'connected')))
      .orderBy(sql`${mailboxes.isDefault} DESC`, mailboxes.createdAt)
      .limit(1);
    mailbox = rows[0] ?? null;
  }
  const from = mailbox ? (owner?.name ? `"${owner.name.replace(/"/g, '')}" <${mailbox.email}>` : mailbox.email) : deps.fallbackFrom ? deps.fallbackFrom : null;
  if (!from) return reject('No connected mailbox for the owner');

  // ---- caps and spacing (per mailbox)
  if (mailbox) {
    const [sendState] = await ctx.db.select().from(mailboxSendState).where(eq(mailboxSendState.mailboxId, mailbox.id)).limit(1);
    const tz = pickZone(owner?.timezone, ws?.settings.timezone);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); // YYYY-MM-DD
    const dayCount = sendState?.dayDate === today ? sendState.dayCount : 0;
    if (dayCount >= mailbox.dailySendLimit) {
      const until = new Date(now.getTime() + 60 * 60_000);
      await ctx.jobs.send('email.send', { emailId, workspaceId: email.workspaceId }, { startAfter: until, singletonKey: `email:${emailId}` });
      return { status: 'deferred', until, reason: 'daily cap reached' };
    }
    if (sendState?.lastSentAt) {
      const earliest = sendState.lastSentAt.getTime() + mailbox.minGapSeconds * 1000;
      if (earliest - now.getTime() > 5_000) {
        const until = new Date(earliest);
        await ctx.jobs.send('email.send', { emailId, workspaceId: email.workspaceId }, { startAfter: until, singletonKey: `email:${emailId}` });
        return { status: 'deferred', until, reason: 'send spacing' };
      }
    }
  }

  // ---- content: manual draft > enrollment override > step template
  let subjectTpl = email.subject;
  let bodyTpl = email.bodyHtml;
  if ((subjectTpl === null || bodyTpl === null) && step) {
    const override = state?.emailOverrides?.[step.id];
    const [tpl] = step.emailTemplateId ? await ctx.db.select().from(emailTemplates).where(eq(emailTemplates.id, step.emailTemplateId)).limit(1) : [];
    subjectTpl = override?.subject ?? subjectTpl ?? tpl?.subject ?? '';
    bodyTpl = override?.body ?? bodyTpl ?? tpl?.htmlBody ?? '';
  }
  subjectTpl ??= '';
  bodyTpl ??= '';

  // Reply steps thread onto the last outbound email of this enrollment.
  let inReplyTo: string | undefined;
  let references: string[] | undefined;
  const isReply = step?.action === 'auto_email_reply' || step?.action === 'manual_email_reply';
  if (isReply && state) {
    const [prev] = await ctx.db
      .select({ messageId: emails.messageId, subject: emails.subject })
      .from(emails)
      .where(and(eq(emails.sequenceStateId, state.id), eq(emails.status, 'sent'), sql`${emails.id} <> ${emailId}`))
      .orderBy(sql`${emails.date} DESC NULLS LAST`)
      .limit(1);
    if (prev?.messageId) {
      inReplyTo = prev.messageId;
      references = [prev.messageId];
      if (!subjectTpl.trim() && prev.subject) subjectTpl = prev.subject.startsWith('Re:') ? prev.subject : `Re: ${prev.subject}`;
    }
  }
  if (!subjectTpl.trim()) return reject('Email has no subject');

  const tz = pickZone(prospect?.timezone, account?.timezone, owner?.timezone, ws?.settings.timezone);
  const unsubscribeUrl = `${ctx.publicUrl}/u/${unsubscribeToken(emailId, deps.trackingSecret ?? 'cooks')}`;
  let rendered: { subject: string; html: string; text: string };
  try {
    rendered = await renderTemplate(
      subjectTpl,
      bodyTpl,
      buildMergeContext({ prospect: prospect ?? {}, account, owner: owner ?? {}, sequence: seq, step, now, tz, unsubscribeUrl }),
    );
  } catch (e) {
    if (e instanceof TemplateError) return reject(e.message);
    throw e;
  }
  if (ws?.settings.requireUnsubscribeLink !== false && !rendered.html.includes(unsubscribeUrl)) {
    rendered.html += `<p style="font-size:12px;color:#888">Don't want these emails? <a href="${unsubscribeUrl}">Unsubscribe</a></p>`;
    rendered.text += `\n\nDon't want these emails? Unsubscribe: ${unsubscribeUrl}`;
  }

  const messageId = `<${emailId}@${domainOf(mailbox?.email ?? from.replace(/.*<|>.*/g, '')) || 'cooks.local'}>`;
  const claimed = await ctx.db
    .update(emails)
    .set({ status: 'sending', sendStartedAt: now, messageId })
    .where(and(eq(emails.id, emailId), eq(emails.status, 'queued')))
    .returning({ id: emails.id });
  if (claimed.length === 0) return { status: 'skipped', reason: 'claimed elsewhere' };

  const provider = await deps.providerFor(mailbox);
  try {
    const res = await provider.send({
      from,
      to: [to],
      cc: email.cc,
      bcc: email.bcc,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      messageId,
      inReplyTo,
      references,
      headers: {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'X-Cooks-Email-Id': emailId,
      },
    });
    await ctx.db
      .update(emails)
      .set({
        status: 'sent',
        fromAddr: from,
        toAddr: to,
        recipients: [to],
        subject: rendered.subject,
        bodyHtml: rendered.html,
        bodyText: rendered.text,
        date: now,
        deliveredAt: now,
        providerMessageId: res.providerMessageId,
        threadId: res.threadId ?? email.threadId ?? (inReplyTo ? undefined : messageId),
        inReplyTo: inReplyTo ?? null,
        type: mailbox?.provider === 'gmail' ? 'gmail' : mailbox?.provider === 'ms_graph' ? 'outlook' : 'smtp',
        mailboxId: mailbox?.id ?? null,
      })
      .where(eq(emails.id, emailId));
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    await ctx.db.update(emails).set({ status: 'failed', error: msg }).where(eq(emails.id, emailId));
    throw e; // let the queue retry with backoff
  }

  await ctx.db.insert(emailEvents).values([
    { workspaceId: email.workspaceId, emailId, kind: 'sent', occurredAt: now, rolledUpAt: now },
    { workspaceId: email.workspaceId, emailId, kind: 'delivered', occurredAt: now, rolledUpAt: now },
  ]);
  if (mailbox) {
    const tz = pickZone(owner?.timezone, ws?.settings.timezone);
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
    await ctx.db
      .insert(mailboxSendState)
      .values({ mailboxId: mailbox.id, lastSentAt: now, dayDate: today, dayCount: 1 })
      .onConflictDoUpdate({
        target: mailboxSendState.mailboxId,
        set: {
          lastSentAt: now,
          dayCount: sql`CASE WHEN ${mailboxSendState.dayDate} = ${today} THEN ${mailboxSendState.dayCount} + 1 ELSE 1 END`,
          dayDate: today,
        },
      });
  }
  if (email.sequenceId) await bumpCounter(ctx.db, email.workspaceId, 'sequence', email.sequenceId, 'email.delivered');
  if (email.sequenceStepId) await bumpCounter(ctx.db, email.workspaceId, 'sequence_step', email.sequenceStepId, 'email.delivered');
  await emitEvent(ctx.db, {
    workspaceId: email.workspaceId,
    type: 'email.sent',
    aggregateType: 'email',
    aggregateId: emailId,
    payload: { emailId, prospectId: email.prospectId, sequenceStateId: email.sequenceStateId, messageId },
    dedupeKey: `${emailId}:sent`,
  });

  if (state && step) {
    await ctx.db
      .update(stepExecutions)
      .set({ status: 'sent', finishedAt: now })
      .where(and(eq(stepExecutions.sequenceStateId, state.id), eq(stepExecutions.sequenceStepId, step.id)));
    const rows = await ctx.db
      .update(sequenceStates)
      .set({ stepPhase: 'done', lastStepDoneAt: now })
      .where(and(eq(sequenceStates.id, state.id), eq(sequenceStates.currentStepId, step.id), eq(sequenceStates.stepPhase, 'executing')))
      .returning({ id: sequenceStates.id, state: sequenceStates.state });
    if (rows[0]?.state === 'active') {
      await ctx.jobs.send('enrollment.advance', { stateId: state.id, workspaceId: email.workspaceId, prevDoneAt: now.toISOString() }, { singletonKey: `advance:${state.id}` });
    }
  }
  return { status: 'sent', messageId };
}
