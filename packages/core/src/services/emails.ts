import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { emailEvents, emails, mailboxes, prospects, sequenceStates, sequenceSteps, sequences, tasks, withTx } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { emitEvent } from '../events.js';
import { processInbound, type InboundMailbox } from '../mail/inbound.js';
import type { InboundMessage } from '../mail/provider.js';
import { htmlToText } from '../mail/templates.js';
import { parseInclude, ref, refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { isManagerOrAdmin } from '../principal.js';
import { getProspectRow, serializeProspect } from './prospects.js';
import { serializeSequences } from './sequences.js';
import { serializeStep } from './sequence-steps.js';
import { serializeTask } from './tasks.js';
import { idFilter, iso, isUuid, isoReq, memberIds, paginate, requireMember, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

export type EmailRow = typeof emails.$inferSelect;
export const EMAIL_INCLUDES = ['prospect', 'task', 'sequence', 'sequenceStep'] as const;

export function serializeEmail(e: EmailRow, x: { prospect?: unknown; task?: unknown; sequence?: unknown; sequenceStep?: unknown } = {}) {
  return {
    id: e.id,
    type: e.type,
    status: e.status,
    from: e.fromAddr,
    to: e.toAddr,
    recipients: e.recipients,
    subject: e.subject,
    bodyText: e.bodyText,
    bodyHtml: e.bodyHtml,
    prospect: x.prospect ?? refOrNull('prospects', e.prospectId),
    task: x.task ?? refOrNull('tasks', e.taskId),
    sequence: x.sequence ?? refOrNull('sequences', e.sequenceId),
    sequenceStep: x.sequenceStep ?? refOrNull('sequenceSteps', e.sequenceStepId),
    date: iso(e.date),
    deliveredAt: iso(e.deliveredAt),
    openedAt: iso(e.openedAt),
    clickedAt: iso(e.clickedAt),
    bouncedAt: iso(e.bouncedAt),
    repliedAt: iso(e.repliedAt),
    openCount: e.openCount,
    clickCount: e.clickCount,
    createdAt: isoReq(e.createdAt),
    updatedAt: isoReq(e.updatedAt),
    // Cooks extension fields
    direction: e.direction,
    messageId: e.messageId,
    threadId: e.threadId,
    inReplyTo: e.inReplyTo,
    sendAttempts: e.sendAttempts,
    error: e.error,
  };
}

async function serializeEmails(ctx: Ctx, rows: EmailRow[], includes: string[]) {
  if (includes.length === 0 || rows.length === 0) return rows.map((r) => serializeEmail(r));
  const pick = (k: keyof EmailRow) => [...new Set(rows.map((r) => r[k]).filter((v): v is string => typeof v === 'string'))];
  const [ps, ts, seqs, steps] = await Promise.all([
    includes.includes('prospect') && pick('prospectId').length ? ctx.db.select().from(prospects).where(inArray(prospects.id, pick('prospectId'))) : [],
    includes.includes('task') && pick('taskId').length ? ctx.db.select().from(tasks).where(inArray(tasks.id, pick('taskId'))) : [],
    includes.includes('sequence') && pick('sequenceId').length
      ? ctx.db.select().from(sequences).where(inArray(sequences.id, pick('sequenceId'))).then((rs) => serializeSequences(ctx, rs, []))
      : [],
    includes.includes('sequenceStep') && pick('sequenceStepId').length ? ctx.db.select().from(sequenceSteps).where(inArray(sequenceSteps.id, pick('sequenceStepId'))) : [],
  ]);
  const pById = new Map(ps.map((p) => [p.id, serializeProspect(p, { customFields: false, states: [] })]));
  const tById = new Map(ts.map((t) => [t.id, serializeTask(t)]));
  const sById = new Map(seqs.map((s) => [s.id, s]));
  const stById = new Map(steps.map((s) => [s.id, serializeStep(s, undefined, undefined)]));
  return rows.map((r) =>
    serializeEmail(r, {
      prospect: r.prospectId ? pById.get(r.prospectId) : undefined,
      task: r.taskId ? tById.get(r.taskId) : undefined,
      sequence: r.sequenceId ? sById.get(r.sequenceId) : undefined,
      sequenceStep: r.sequenceStepId ? stById.get(r.sequenceStepId) : undefined,
    }),
  );
}

export async function listEmails(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; include?: unknown; requestUrl: string }) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, EMAIL_INCLUDES);
  const conds: SQL[] = [tenantWhere(emails, ctx.principal.workspaceId)];
  const idc = idFilter(emails.id, f.id);
  if (idc) conds.push(idc);
  for (const [key, col] of [
    ['prospect', emails.prospectId],
    ['task', emails.taskId],
    ['account', emails.accountId],
  ] as const) {
    const v = (f[key] as Record<string, unknown> | undefined)?.id;
    if (typeof v === 'string' && v) {
      if (!isUuid(v)) throw badRequest(`filter[${key}][id] must be a UUID`);
      conds.push(eq(col, v));
    }
  }
  if (typeof f.status === 'string' && f.status) conds.push(eq(emails.status, f.status as EmailRow['status']));
  conds.push(...updatedAtFilter(emails.updatedAt, f, 'lt'));
  const page = await paginate({
    table: emails,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(emails)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: await serializeEmails(ctx, page.data, includes), links: page.links };
}

export async function getEmailRow(ctx: Ctx, id: string): Promise<EmailRow> {
  uuidOr404(id, 'Email');
  const [row] = await ctx.db
    .select()
    .from(emails)
    .where(and(tenantWhere(emails, ctx.principal.workspaceId), eq(emails.id, id)))
    .limit(1);
  if (!row) throw notFound('Email');
  return row;
}

export async function getEmail(ctx: Ctx, id: string, include?: unknown) {
  const includes = parseInclude(include, EMAIL_INCLUDES);
  return (await serializeEmails(ctx, [await getEmailRow(ctx, id)], includes))[0]!;
}

export interface CreateEmailInput {
  prospectId: string;
  ownerId: string;
  subject: string;
  bodyHtml: string;
  from?: string;
  recipients?: string[];
  cc?: string[];
  bcc?: string[];
  send?: boolean;
}

/**
 * Upstream semantics: creates a manual_email task plus a draft. With `send: true` the draft
 * is queued through the owner's mailbox and the task is closed as finished.
 */
export async function createEmail(ctx: Ctx, input: CreateEmailInput) {
  const prospect = await getProspectRow(ctx, input.prospectId).catch(() => {
    throw unprocessable('prospectId does not reference a prospect in this workspace', { field: 'prospectId' });
  });
  const ownerId = await requireMember(ctx, input.ownerId, 'ownerId');
  if (!isManagerOrAdmin(ctx.principal) && ctx.principal.userId && ownerId !== ctx.principal.userId) {
    throw unprocessable('Users can only create emails for themselves', { field: 'ownerId' });
  }
  const to = input.recipients?.[0] ?? prospect.primaryEmail;
  if (!to) throw unprocessable('Prospect has no email address and no recipients were given', { field: 'recipients' });
  if (input.send && (prospect.unsubscribedAt || prospect.doNotContact)) throw unprocessable('Prospect has unsubscribed');
  const now = ctx.clock.now();
  const send = !!input.send;

  const row = await withTx(ctx.db, async (tx) => {
    const [task] = await tx
      .insert(tasks)
      .values({
        workspaceId: ctx.principal.workspaceId,
        prospectId: prospect.id,
        accountId: prospect.accountId,
        ownerId,
        action: 'manual_email',
        status: send ? 'finished' : 'ready',
        completed: send,
        completedAt: send ? now : null,
        priority: 'normal',
        dueAt: now,
        note: input.subject,
      })
      .returning({ id: tasks.id });
    const [email] = await tx
      .insert(emails)
      .values({
        workspaceId: ctx.principal.workspaceId,
        prospectId: prospect.id,
        accountId: prospect.accountId,
        taskId: task!.id,
        ownerId,
        direction: 'outbound',
        status: send ? 'queued' : 'draft',
        fromAddr: input.from ?? null,
        toAddr: to,
        recipients: input.recipients ?? [to],
        cc: input.cc ?? [],
        bcc: input.bcc ?? [],
        subject: input.subject,
        bodyHtml: input.bodyHtml,
      })
      .returning();
    await tx.update(tasks).set({ draftEmailId: email!.id }).where(eq(tasks.id, task!.id));
    return email!;
  });
  if (send) await ctx.jobs.send('email.send', { emailId: row.id, workspaceId: row.workspaceId }, { singletonKey: `email:${row.id}` });
  return serializeEmail(row);
}

// ---- import: email sent or received outside Cooks -------------------------------------------

export interface ImportEmailInput {
  prospectId: string;
  direction: 'inbound' | 'outbound';
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  /** RFC 5322 Message-ID of the message as the provider holds it; used to match replies. */
  messageId?: string;
  threadId?: string;
  inReplyTo?: string;
  /** Provider-side id (Gmail message id, Graph id, CRM activity id). Dedupe key when present. */
  externalId?: string;
  sentAt?: string;
  provider?: 'gmail' | 'outlook' | 'smtp' | 'other';
  from?: string;
  to?: string;
  ownerId?: string;
  mailboxId?: string;
  autoSubmitted?: boolean;
}

export interface ImportEmailResult {
  email: ReturnType<typeof serializeEmail>;
  created: boolean;
  outcome: { kind: string; action?: string; outboundId?: string | null };
}

const AUTO_REPLY_SUBJECT = /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office|autoreply)/i;
const angle = (id: string | undefined | null) => {
  const t = id?.trim();
  if (!t) return null;
  return t.startsWith('<') ? t : `<${t}>`;
};

/**
 * Record an email that was sent or received outside Cooks (a rep's own mail client, a CRM
 * activity, another tool). Outbound imports become `sent` rows linked to the prospect's active
 * enrollment so a later reply closes it; inbound imports run the same pipeline as synced mail:
 * reply vs out-of-office, the workspace reply policy, a reply task, reply stats and signals.
 */
export async function importEmail(ctx: Ctx, input: ImportEmailInput): Promise<ImportEmailResult> {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const prospect = await getProspectRow(ctx, input.prospectId).catch(() => {
    throw unprocessable('prospectId does not reference a prospect in this workspace', { field: 'prospectId' });
  });
  const sentAt = input.sentAt ? new Date(input.sentAt) : now;
  if (Number.isNaN(sentAt.getTime())) throw unprocessable('sentAt must be an ISO 8601 timestamp', { field: 'sentAt' });
  const messageId = angle(input.messageId);
  const inReplyTo = angle(input.inReplyTo);
  const subject = input.subject ?? '';
  const text = input.bodyText ?? (input.bodyHtml ? htmlToText(input.bodyHtml) : '');

  // owner: explicit > prospect owner > caller > first member
  let ownerId: string | null = null;
  if (input.ownerId) ownerId = await requireMember(ctx, input.ownerId, 'ownerId');
  else {
    const members = await memberIds(ctx);
    ownerId = [prospect.ownerId, ctx.principal.userId].find((id): id is string => !!id && members.includes(id)) ?? members[0] ?? null;
  }
  if (!ownerId) throw unprocessable('Workspace has no members to own the email', { field: 'ownerId' });

  let mailbox: typeof mailboxes.$inferSelect | null = null;
  if (input.mailboxId) {
    if (!isUuid(input.mailboxId)) throw unprocessable('mailboxId does not reference a mailbox in this workspace', { field: 'mailboxId' });
    [mailbox = null] = await ctx.db.select().from(mailboxes).where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.workspaceId, ws), isNull(mailboxes.deletedAt))).limit(1);
    if (!mailbox) throw unprocessable('mailboxId does not reference a mailbox in this workspace', { field: 'mailboxId' });
  } else {
    const rows = await ctx.db
      .select()
      .from(mailboxes)
      .where(and(eq(mailboxes.workspaceId, ws), eq(mailboxes.userId, ownerId), isNull(mailboxes.deletedAt)))
      .orderBy(sql`${mailboxes.isDefault} DESC`, mailboxes.createdAt)
      .limit(1);
    mailbox = rows[0] ?? null;
  }
  const providerLabel = input.provider && input.provider !== 'other' ? input.provider : mailbox ? (mailbox.provider === 'gmail' ? 'gmail' : mailbox.provider === 'ms_graph' ? 'outlook' : 'smtp') : 'other';
  const mailboxProvider = providerLabel === 'gmail' ? 'gmail' : providerLabel === 'outlook' ? 'ms_graph' : 'smtp';

  if (input.direction === 'outbound') {
    const dupWhere = [...(messageId ? [eq(emails.messageId, messageId)] : []), ...(input.externalId ? [eq(emails.providerMessageId, input.externalId)] : [])];
    if (dupWhere.length) {
      const [existing] = await ctx.db.select().from(emails).where(and(eq(emails.workspaceId, ws), eq(emails.direction, 'outbound'), or(...dupWhere))).limit(1);
      if (existing) return { email: serializeEmail(existing), created: false, outcome: { kind: 'duplicate' } };
    }
    // Link to the prospect's current enrollment so a reply matched by Message-ID or thread closes it.
    const [state] = await ctx.db
      .select({ id: sequenceStates.id, sequenceId: sequenceStates.sequenceId })
      .from(sequenceStates)
      .where(and(eq(sequenceStates.workspaceId, ws), eq(sequenceStates.prospectId, prospect.id), isNull(sequenceStates.deletedAt), sql`${sequenceStates.state} <> 'finished'`))
      .orderBy(desc(sequenceStates.createdAt))
      .limit(1);
    const to = input.to ?? prospect.primaryEmail ?? null;
    const [row] = await ctx.db
      .insert(emails)
      .values({
        workspaceId: ws,
        prospectId: prospect.id,
        accountId: prospect.accountId,
        sequenceId: state?.sequenceId ?? null,
        sequenceStateId: state?.id ?? null,
        mailboxId: mailbox?.id ?? null,
        ownerId,
        type: providerLabel,
        direction: 'outbound',
        status: 'sent',
        fromAddr: input.from ?? mailbox?.email ?? null,
        toAddr: to,
        recipients: to ? [to] : [],
        subject,
        bodyText: text || null,
        bodyHtml: input.bodyHtml ?? null,
        messageId,
        threadId: input.threadId ?? messageId,
        inReplyTo,
        providerMessageId: input.externalId ?? null,
        date: sentAt,
        sendStartedAt: sentAt,
        deliveredAt: sentAt,
      })
      .returning();
    await ctx.db.insert(emailEvents).values([
      { workspaceId: ws, emailId: row!.id, kind: 'sent', occurredAt: sentAt, rolledUpAt: now },
      { workspaceId: ws, emailId: row!.id, kind: 'delivered', occurredAt: sentAt, rolledUpAt: now },
    ]);
    await emitEvent(ctx.db, { workspaceId: ws, type: 'email.sent', aggregateType: 'email', aggregateId: row!.id, payload: { emailId: row!.id, prospectId: prospect.id, sequenceStateId: state?.id ?? null, imported: true }, dedupeKey: `${row!.id}:sent` });
    return { email: serializeEmail(row!), created: true, outcome: { kind: 'outbound' } };
  }

  // ---- inbound: same pipeline as synced mail
  const from = input.from ?? prospect.primaryEmail;
  if (!from) throw unprocessable('from is required when the prospect has no email address', { field: 'from' });
  const inboundMailbox: InboundMailbox = mailbox
    ? { id: mailbox.id, workspaceId: ws, userId: mailbox.userId, provider: mailbox.provider, email: mailbox.email }
    : { id: null, workspaceId: ws, userId: ownerId, provider: mailboxProvider, email: input.to ?? '' };
  const msg: InboundMessage = {
    providerId: input.externalId ?? messageId ?? `import:${randomUUID()}`,
    messageId,
    inReplyTo,
    references: inReplyTo ? [inReplyTo] : [],
    threadId: input.threadId ?? null,
    from,
    to: [input.to ?? inboundMailbox.email].filter(Boolean),
    date: sentAt,
    subject,
    text,
    html: input.bodyHtml ?? null,
    headers: {},
    autoSubmitted: input.autoSubmitted ?? AUTO_REPLY_SUBJECT.test(subject),
    dsn: null,
  };
  const out = await processInbound(ctx, inboundMailbox, msg, { classify: true });
  if (out.kind === 'duplicate') {
    const [existing] = await ctx.db
      .select()
      .from(emails)
      .where(and(eq(emails.workspaceId, ws), eq(emails.direction, 'inbound'), or(eq(emails.providerMessageId, msg.providerId), ...(messageId ? [eq(emails.messageId, messageId)] : []))))
      .limit(1);
    if (!existing) throw notFound('Email');
    return { email: serializeEmail(existing), created: false, outcome: { kind: 'duplicate' } };
  }
  const emailId = out.kind === 'bounce' ? out.emailId : out.emailId;
  if (!emailId) throw notFound('Email');
  const row = await getEmailRow(ctx, emailId);
  return {
    email: serializeEmail(row),
    created: true,
    outcome: { kind: out.kind, action: 'action' in out ? out.action : undefined, outboundId: 'outboundId' in out ? out.outboundId : undefined },
  };
}
