import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { mailboxes, prospects, sequenceStates, sequenceSteps, sequences, withTx } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, conflict, notFound, pgConstraint, unprocessable } from '../errors.js';
import { emitEvent } from '../events.js';
import { parseInclude, ref, refOrNull, type ReferenceObject } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { parseEnum } from '../query.js';
import { finishEnrollment, pauseEnrollment, resumeEnrollment } from '../engine/transitions.js';
import { getProspectRow, serializeProspect } from './prospects.js';
import { getSequenceRow, serializeSequences } from './sequences.js';
import { serializeStep, stepsForSequences } from './sequence-steps.js';
import { serializeUser, usersByIds } from './users.js';
import { idFilter, isUuid, isoReq, paginate, requireMember, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

export type StateRow = typeof sequenceStates.$inferSelect;
export const STATE_INCLUDES = ['sequence', 'prospect', 'creator', 'sequenceStep'] as const;

export interface SequenceStateDto {
  id: string;
  state: StateRow['state'];
  sequence: unknown;
  prospect: unknown;
  account: ReferenceObject | null;
  creator: unknown;
  owner: ReferenceObject;
  sequenceStep: unknown;
  createdAt: string;
  updatedAt: string;
}

export function serializeSequenceStateRow(s: StateRow): SequenceStateDto {
  return {
    id: s.id,
    state: s.state,
    sequence: ref('sequences', s.sequenceId),
    prospect: ref('prospects', s.prospectId),
    account: refOrNull('accounts', s.accountId),
    creator: ref('users', s.creatorId ?? s.ownerId),
    owner: ref('users', s.ownerId),
    sequenceStep: refOrNull('sequenceSteps', s.currentStepId),
    createdAt: isoReq(s.createdAt),
    updatedAt: isoReq(s.updatedAt),
  };
}

async function serializeStates(ctx: Ctx, rows: StateRow[], includes: string[]): Promise<SequenceStateDto[]> {
  const base: SequenceStateDto[] = rows.map(serializeSequenceStateRow);
  if (includes.length === 0) return base;
  const seqIds = [...new Set(rows.map((r) => r.sequenceId))];
  const [seqRows, prospectRows, creators, stepMap] = await Promise.all([
    includes.includes('sequence')
      ? ctx.db.select().from(sequences).where(inArray(sequences.id, seqIds)).then((rs) => serializeSequences(ctx, rs, []))
      : Promise.resolve([]),
    includes.includes('prospect')
      ? ctx.db.select().from(prospects).where(inArray(prospects.id, [...new Set(rows.map((r) => r.prospectId))]))
      : Promise.resolve([]),
    includes.includes('creator') ? usersByIds(ctx, rows.map((r) => r.creatorId ?? r.ownerId)) : Promise.resolve(new Map()),
    includes.includes('sequenceStep') ? stepsForSequences(ctx, seqIds) : Promise.resolve(new Map()),
  ]);
  const seqById = new Map(seqRows.map((s) => [s.id, s]));
  const prospectById = new Map(prospectRows.map((p) => [p.id, p]));
  const stepById = new Map([...stepMap.values()].flat().map((s) => [s.id, s]));
  return base.map((b, i) => {
    const r = rows[i]!;
    if (includes.includes('sequence') && seqById.has(r.sequenceId)) b.sequence = seqById.get(r.sequenceId);
    if (includes.includes('prospect') && prospectById.has(r.prospectId)) b.prospect = serializeProspect(prospectById.get(r.prospectId)!, { customFields: false, states: [r.id] });
    if (includes.includes('creator')) {
      const u = creators.get(r.creatorId ?? r.ownerId);
      if (u) b.creator = serializeUser(u);
    }
    if (includes.includes('sequenceStep') && r.currentStepId && stepById.has(r.currentStepId)) b.sequenceStep = serializeStep(stepById.get(r.currentStepId)!, undefined, undefined);
    return b;
  });
}

export async function listSequenceStates(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; include?: unknown; requestUrl: string }) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, STATE_INCLUDES);
  const conds: SQL[] = [tenantWhere(sequenceStates, ctx.principal.workspaceId)];
  for (const [key, col] of [
    ['sequence', sequenceStates.sequenceId],
    ['prospect', sequenceStates.prospectId],
    ['account', sequenceStates.accountId],
  ] as const) {
    const v = (f[key] as Record<string, unknown> | undefined)?.id;
    if (typeof v === 'string' && v) {
      if (!isUuid(v)) throw badRequest(`filter[${key}][id] must be a UUID`);
      conds.push(eq(col, v));
    }
  }
  const state = parseEnum(f.state, ['active', 'paused', 'finished', 'pending_start'] as const, 'filter[state]');
  if (state) conds.push(eq(sequenceStates.state, state));
  conds.push(...updatedAtFilter(sequenceStates.updatedAt, f, 'lt'));
  const page = await paginate({
    table: sequenceStates,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(sequenceStates)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: await serializeStates(ctx, page.data, includes), links: page.links };
}

export async function getStateRow(ctx: Ctx, id: string): Promise<StateRow> {
  uuidOr404(id, 'Sequence state');
  const [row] = await ctx.db
    .select()
    .from(sequenceStates)
    .where(and(tenantWhere(sequenceStates, ctx.principal.workspaceId), eq(sequenceStates.id, id)))
    .limit(1);
  if (!row) throw notFound('Sequence state');
  return row;
}

export async function getSequenceState(ctx: Ctx, id: string, include?: unknown) {
  const includes = parseInclude(include, STATE_INCLUDES);
  const row = await getStateRow(ctx, id);
  return (await serializeStates(ctx, [row], includes))[0]!;
}

export interface EnrollInput {
  prospect: { id: string };
  sequence: { id: string };
  owner: { id: string };
  state?: 'active' | 'paused';
  mailbox?: { id: string };
  scheduledAt?: string;
  sequenceStep?: { id: string };
  emailOverrides?: Record<string, { subject?: string; body?: string }>;
  enrich?: { phoneNumbers?: boolean; emails?: boolean };
}

async function validateOverrides(ctx: Ctx, sequenceId: string, overrides: EnrollInput['emailOverrides']) {
  if (!overrides || Object.keys(overrides).length === 0) return overrides ?? {};
  const ids = Object.keys(overrides);
  const rows = await ctx.db
    .select({ id: sequenceSteps.id })
    .from(sequenceSteps)
    .where(and(eq(sequenceSteps.sequenceId, sequenceId), inArray(sequenceSteps.id, ids), isNull(sequenceSteps.deletedAt)));
  const have = new Set(rows.map((r) => r.id));
  const unknown = ids.filter((i) => !have.has(i));
  if (unknown.length) throw unprocessable('emailOverrides keys must be step ids of this sequence', { unknown });
  return overrides;
}

export async function createSequenceState(ctx: Ctx, input: EnrollInput) {
  const seq = await getSequenceRow(ctx, input.sequence.id).catch(() => {
    throw unprocessable('sequence.id does not reference a sequence in this workspace', { field: 'sequence.id' });
  });
  const prospect = await getProspectRow(ctx, input.prospect.id).catch(() => {
    throw unprocessable('prospect.id does not reference a prospect in this workspace', { field: 'prospect.id' });
  });
  const ownerId = await requireMember(ctx, input.owner.id, 'owner.id');
  const steps = (await stepsForSequences(ctx, [seq.id])).get(seq.id) ?? [];
  const hasEmailStep = steps.some((s) => s.action.includes('email'));
  if (hasEmailStep && !prospect.primaryEmail) throw unprocessable('Prospect has no valid email address for an email sequence', { field: 'prospect.id' });
  if (prospect.unsubscribedAt || prospect.doNotContact) throw unprocessable('Prospect has unsubscribed or is marked do-not-contact');

  let mailboxId: string | null = null;
  if (input.mailbox) {
    const [mb] = await ctx.db
      .select({ id: mailboxes.id, userId: mailboxes.userId })
      .from(mailboxes)
      .where(and(tenantWhere(mailboxes, ctx.principal.workspaceId), eq(mailboxes.id, input.mailbox.id)))
      .limit(1);
    if (!mb) throw unprocessable('mailbox.id does not reference a mailbox in this workspace', { field: 'mailbox.id' });
    mailboxId = mb.id;
  }
  let startOrder: number | null = null;
  if (input.sequenceStep) {
    const start = steps.find((s) => s.id === input.sequenceStep!.id);
    if (!start) throw unprocessable('sequenceStep.id is not a step of this sequence', { field: 'sequenceStep.id' });
    startOrder = start.order - 1;
  }
  const overrides = await validateOverrides(ctx, seq.id, input.emailOverrides);
  const now = ctx.clock.now();
  const scheduledAt = input.scheduledAt ? new Date(input.scheduledAt) : null;
  const requested = input.state ?? 'active';
  const state: StateRow['state'] = requested === 'paused' ? 'paused' : scheduledAt && scheduledAt > now ? 'pending_start' : 'active';

  let row: StateRow;
  try {
    row = await withTx(ctx.db, async (tx) => {
      const [s] = await tx
        .insert(sequenceStates)
        .values({
          workspaceId: ctx.principal.workspaceId,
          sequenceId: seq.id,
          prospectId: prospect.id,
          accountId: prospect.accountId,
          ownerId,
          creatorId: ctx.principal.userId ?? ownerId,
          mailboxId,
          state,
          stepPhase: 'idle',
          currentStepOrder: startOrder,
          scheduledAt,
          emailOverrides: overrides,
        })
        .returning();
      await emitEvent(tx, {
        workspaceId: ctx.principal.workspaceId,
        type: 'sequence_state.created',
        aggregateType: 'sequence_state',
        aggregateId: s!.id,
        payload: { sequenceStateId: s!.id, sequenceId: seq.id, prospectId: prospect.id, state },
      });
      return s!;
    });
  } catch (e) {
    if (pgConstraint(e) === 'sequence_states_active_uq') throw conflict('Prospect is already enrolled in this sequence');
    throw e;
  }
  if (state === 'active') {
    await ctx.jobs.send('enrollment.advance', { stateId: row.id, workspaceId: row.workspaceId }, { singletonKey: `advance:${row.id}` });
  }
  return (await serializeStates(ctx, [row], []))[0]!;
}

/** Full replace of emailOverrides (upstream semantics: not a merge). */
export async function updateSequenceState(ctx: Ctx, id: string, overrides: Record<string, { subject?: string; body?: string }>) {
  const row = await getStateRow(ctx, id);
  const validated = await validateOverrides(ctx, row.sequenceId, overrides);
  const [updated] = await ctx.db.update(sequenceStates).set({ emailOverrides: validated }).where(eq(sequenceStates.id, id)).returning();
  return (await serializeStates(ctx, [updated!], []))[0]!;
}

export async function deleteSequenceState(ctx: Ctx, id: string) {
  const row = await getStateRow(ctx, id);
  await finishEnrollment(ctx, row.id, 'removed');
  await ctx.db.update(sequenceStates).set({ deletedAt: ctx.clock.now() }).where(eq(sequenceStates.id, id));
}

export async function finishSequenceState(ctx: Ctx, id: string) {
  const row = await getStateRow(ctx, id);
  await finishEnrollment(ctx, row.id, 'manual');
}

export async function pauseSequenceState(ctx: Ctx, id: string) {
  const row = await getStateRow(ctx, id);
  if (row.state === 'finished') throw conflict('Enrollment is already finished');
  await pauseEnrollment(ctx, row.id);
  return getSequenceState(ctx, id);
}

export async function resumeSequenceState(ctx: Ctx, id: string) {
  const row = await getStateRow(ctx, id);
  if (row.state === 'finished') throw conflict('Enrollment is already finished');
  await resumeEnrollment(ctx, row.id);
  return getSequenceState(ctx, id);
}

export { idFilter };
