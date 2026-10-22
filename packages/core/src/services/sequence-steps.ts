import { and, asc, eq, gte, inArray, isNull, max, sql, type SQL } from 'drizzle-orm';
import { emailTemplates, sequenceSteps, sequences, withTx } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, notFound, unprocessable } from '../errors.js';
import { parseInclude, ref, refOrNull } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { assertCanEditPrivacy } from '../principal.js';
import type { Analytics } from '../schemas/common.js';
import { analyticsFor, emptyAnalytics } from './analytics.js';
import { serializeTemplate, templatesByIds, type TemplateRow } from './email-templates.js';
import { idFilter, isUuid, isoReq, paginate, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

export type StepRow = typeof sequenceSteps.$inferSelect;
export const STEP_INCLUDES = ['template'] as const;

const EMAIL_ACTIONS = new Set(['manual_email', 'auto_email', 'manual_email_reply', 'auto_email_reply']);
const REPLY_ACTIONS = new Set(['manual_email_reply', 'auto_email_reply']);
const AI_EMAIL_ACTIONS = new Set(['manual_email', 'manual_email_reply', 'auto_email', 'auto_email_reply']);

export function channelOf(action: string): string {
  if (EMAIL_ACTIONS.has(action)) return 'email';
  if (action === 'call') return 'call';
  if (action.includes('linkedin')) return 'linkedin';
  if (action.includes('sms')) return 'sms';
  if (action.includes('whatsapp')) return 'whatsapp';
  return 'task';
}

export function serializeStep(s: StepRow, analytics: Analytics | undefined, template: TemplateRow | undefined | null) {
  return {
    id: s.id,
    order: s.order,
    name: s.name,
    interval: s.intervalMinutes,
    action: s.action,
    note: s.note,
    sequence: ref('sequences', s.sequenceId),
    template: template ? serializeTemplate(template) : refOrNull('emailTemplates', s.emailTemplateId),
    hasAbVariants: s.hasAbVariants,
    analytics: analytics ?? emptyAnalytics(),
    createdAt: isoReq(s.createdAt),
    updatedAt: isoReq(s.updatedAt),
  };
}

export async function stepsForSequences(ctx: Ctx, sequenceIds: string[]): Promise<Map<string, StepRow[]>> {
  const map = new Map<string, StepRow[]>();
  if (sequenceIds.length === 0) return map;
  const rows = await ctx.db
    .select()
    .from(sequenceSteps)
    .where(and(inArray(sequenceSteps.sequenceId, sequenceIds), isNull(sequenceSteps.deletedAt)))
    .orderBy(asc(sequenceSteps.order), asc(sequenceSteps.id));
  for (const r of rows) {
    const list = map.get(r.sequenceId) ?? [];
    list.push(r);
    map.set(r.sequenceId, list);
  }
  return map;
}

async function serializeSteps(ctx: Ctx, rows: StepRow[], includes: string[]) {
  const analytics = await analyticsFor(ctx.db, 'sequence_step', rows.map((r) => r.id));
  const templates = includes.includes('template')
    ? await templatesByIds(ctx, rows.map((r) => r.emailTemplateId).filter((x): x is string => !!x))
    : new Map<string, TemplateRow>();
  return rows.map((r) => serializeStep(r, analytics.get(r.id), r.emailTemplateId ? templates.get(r.emailTemplateId) : undefined));
}

async function ownedSequence(ctx: Ctx, sequenceId: string) {
  const [seq] = await ctx.db
    .select()
    .from(sequences)
    .where(and(tenantWhere(sequences, ctx.principal.workspaceId), eq(sequences.id, sequenceId)))
    .limit(1);
  return seq ?? null;
}

export async function listSequenceSteps(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; include?: unknown; requestUrl: string }) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, STEP_INCLUDES);
  const conds: SQL[] = [tenantWhere(sequenceSteps, ctx.principal.workspaceId)];
  const idc = idFilter(sequenceSteps.id, f.id);
  if (idc) conds.push(idc);
  const seq = (f.sequence as Record<string, unknown> | undefined)?.id;
  if (typeof seq === 'string' && seq) {
    if (!isUuid(seq)) throw badRequest('filter[sequence][id] must be a UUID');
    conds.push(eq(sequenceSteps.sequenceId, seq));
  }
  conds.push(...updatedAtFilter(sequenceSteps.updatedAt, f, 'lt'));
  const page = await paginate({
    table: sequenceSteps,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(sequenceSteps)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: await serializeSteps(ctx, page.data, includes), links: page.links };
}

export async function getStepRow(ctx: Ctx, id: string): Promise<StepRow> {
  uuidOr404(id, 'Sequence step');
  const [row] = await ctx.db
    .select()
    .from(sequenceSteps)
    .where(and(tenantWhere(sequenceSteps, ctx.principal.workspaceId), eq(sequenceSteps.id, id)))
    .limit(1);
  if (!row) throw notFound('Sequence step');
  return row;
}

export async function getSequenceStep(ctx: Ctx, id: string, include?: unknown) {
  const includes = parseInclude(include, STEP_INCLUDES);
  const row = await getStepRow(ctx, id);
  return (await serializeSteps(ctx, [row], includes))[0]!;
}

export interface CreateStepInput {
  sequence: { id: string };
  action: string;
  interval: number;
  order?: number;
  name?: string | null;
  note?: string | null;
  emailSubject?: string;
  emailBody?: string;
  aiEmail?: { agent?: { id: string }; promptOverride?: string };
}

async function assertSingleConnectionRequest(ctx: Ctx, sequenceId: string, exceptStepId?: string) {
  const rows = await ctx.db
    .select({ id: sequenceSteps.id })
    .from(sequenceSteps)
    .where(and(eq(sequenceSteps.sequenceId, sequenceId), eq(sequenceSteps.action, 'linkedin_connection_request'), isNull(sequenceSteps.deletedAt)));
  if (rows.some((r) => r.id !== exceptStepId)) throw unprocessable('A sequence can contain only one linkedin_connection_request step');
}

function validateAiEmail(action: string, aiEmail: CreateStepInput['aiEmail'] | null | undefined) {
  if (aiEmail && !AI_EMAIL_ACTIONS.has(action)) throw badRequest('aiEmail is only valid on email steps');
}

export async function createSequenceStep(ctx: Ctx, input: CreateStepInput) {
  const seq = await ownedSequence(ctx, input.sequence.id);
  if (!seq) throw unprocessable('sequence.id does not reference a sequence in this workspace', { field: 'sequence.id' });
  assertCanEditPrivacy(ctx.principal, seq.privacy, seq.ownerId, 'add steps to this sequence');
  if (seq.type !== 'interval') throw badRequest('Only interval-based sequences accept steps through the API');
  if (input.action === 'linkedin_connection_request') await assertSingleConnectionRequest(ctx, seq.id);
  validateAiEmail(input.action, input.aiEmail);

  const row = await withTx(ctx.db, async (tx) => {
    let templateId: string | null = null;
    if (EMAIL_ACTIONS.has(input.action)) {
      const [t] = await tx
        .insert(emailTemplates)
        .values({
          workspaceId: ctx.principal.workspaceId,
          name: input.name ?? null,
          subject: REPLY_ACTIONS.has(input.action) ? '' : (input.emailSubject ?? ''),
          htmlBody: input.emailBody ?? '',
          source: 'step_auto',
          ownerId: seq.ownerId,
          privacy: seq.privacy,
        })
        .returning({ id: emailTemplates.id });
      templateId = t!.id;
    }
    const [agg] = await tx
      .select({ maxOrder: max(sequenceSteps.order) })
      .from(sequenceSteps)
      .where(and(eq(sequenceSteps.sequenceId, seq.id), isNull(sequenceSteps.deletedAt)));
    const maxOrder = agg?.maxOrder ?? 0;
    let order = maxOrder + 1;
    if (input.order !== undefined && input.order <= maxOrder) {
      order = input.order;
      await tx
        .update(sequenceSteps)
        .set({ order: sql`${sequenceSteps.order} + 1` })
        .where(and(eq(sequenceSteps.sequenceId, seq.id), isNull(sequenceSteps.deletedAt), gte(sequenceSteps.order, order)));
    }
    const [s] = await tx
      .insert(sequenceSteps)
      .values({
        workspaceId: ctx.principal.workspaceId,
        sequenceId: seq.id,
        order,
        name: input.name ?? null,
        note: input.note ?? null,
        action: input.action as StepRow['action'],
        intervalMinutes: input.interval,
        emailTemplateId: templateId,
        aiEmail: input.aiEmail ?? null,
      })
      .returning();
    return s!;
  });
  return (await serializeSteps(ctx, [row], ['template']))[0]!;
}

export interface UpdateStepInput {
  action?: string;
  interval?: number;
  name?: string | null;
  note?: string | null;
  emailSubject?: string;
  emailBody?: string;
  aiEmail?: { agent?: { id: string }; promptOverride?: string } | null;
}

export async function updateSequenceStep(ctx: Ctx, id: string, input: UpdateStepInput) {
  const step = await getStepRow(ctx, id);
  const seq = await ownedSequence(ctx, step.sequenceId);
  if (!seq) throw notFound('Sequence step');
  assertCanEditPrivacy(ctx.principal, seq.privacy, seq.ownerId, 'edit steps of this sequence');
  const action = input.action ?? step.action;
  if (input.action && channelOf(input.action) !== channelOf(step.action)) {
    throw unprocessable(`Cannot change a ${channelOf(step.action)} step into a ${channelOf(input.action)} step`, { field: 'action' });
  }
  if (action === 'linkedin_connection_request') await assertSingleConnectionRequest(ctx, step.sequenceId, step.id);
  validateAiEmail(action, input.aiEmail ?? step.aiEmail);

  const row = await withTx(ctx.db, async (tx) => {
    if ((input.emailSubject !== undefined || input.emailBody !== undefined || input.name !== undefined) && step.emailTemplateId) {
      await tx
        .update(emailTemplates)
        .set({
          ...(input.emailSubject !== undefined && !REPLY_ACTIONS.has(action) ? { subject: input.emailSubject } : {}),
          ...(input.emailBody !== undefined ? { htmlBody: input.emailBody } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
        })
        .where(eq(emailTemplates.id, step.emailTemplateId));
    }
    const [s] = await tx
      .update(sequenceSteps)
      .set({
        ...(input.action !== undefined ? { action: input.action as StepRow['action'] } : {}),
        ...(input.interval !== undefined ? { intervalMinutes: input.interval } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.aiEmail !== undefined ? { aiEmail: input.aiEmail } : {}),
      })
      .where(eq(sequenceSteps.id, id))
      .returning();
    return s!;
  });
  return (await serializeSteps(ctx, [row], ['template']))[0]!;
}

export async function deleteSequenceStep(ctx: Ctx, id: string, assertCanDelete: (seq: typeof sequences.$inferSelect) => void) {
  const step = await getStepRow(ctx, id);
  const seq = await ownedSequence(ctx, step.sequenceId);
  if (!seq) throw notFound('Sequence step');
  assertCanDelete(seq);
  await ctx.db.update(sequenceSteps).set({ deletedAt: ctx.clock.now() }).where(eq(sequenceSteps.id, id));
}
