import { and, eq, inArray, type SQL } from 'drizzle-orm';
import { emails, prospects, sequenceSteps, sequences, tasks, withTx } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { parseInclude, ref, refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { isManagerOrAdmin } from '../principal.js';
import { getProspectRow, serializeProspect } from './prospects.js';
import { serializeSequences } from './sequences.js';
import { serializeStep } from './sequence-steps.js';
import { serializeTask } from './tasks.js';
import { idFilter, iso, isUuid, isoReq, paginate, requireMember, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

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
