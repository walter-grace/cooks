import { and, eq } from 'drizzle-orm';
import { crmConnections, notes } from '@cooks/db';
import type { Ctx } from '../context.js';
import { noCrmConnection, unprocessable } from '../errors.js';
import { pushNote, type CrmDeps } from '../crm/connector.js';
import { emitEvent } from '../events.js';
import { ref } from '../include.js';
import { getAccountRow } from './accounts.js';
import { getProspectRow } from './prospects.js';
import { iso, isoReq } from './_shared.js';

export type NoteRow = typeof notes.$inferSelect;

export function serializeNote(n: NoteRow) {
  const collection = n.associatedType === 'prospect' ? 'prospects' : 'accounts';
  return {
    id: n.id,
    externalId: n.externalId ?? n.id,
    text: n.text,
    associatedType: n.associatedType,
    associated: ref(collection, n.associatedId),
    integrationType: n.integrationType,
    userExternalId: n.userExternalId,
    userName: n.userName,
    externalCreatedAt: iso(n.externalCreatedAt) ?? isoReq(n.createdAt),
    externalUpdatedAt: iso(n.externalUpdatedAt) ?? isoReq(n.updatedAt),
    createdAt: isoReq(n.createdAt),
    updatedAt: isoReq(n.updatedAt),
  };
}

/**
 * Notes are written to the CRM upstream. Cooks v1 has no CRM connector, so this mirrors
 * the documented failure (`NO_CRM_CONNECTION`) unless the workspace has a `csv`/local
 * connection, in which case the note is stored locally.
 */
export async function createNote(
  ctx: Ctx,
  args: { associatedType: 'prospect' | 'account'; associatedId: string; text: string; integrationType: 'salesforce' | 'hubspot' },
  deps: CrmDeps = {},
) {
  if (args.associatedType === 'prospect') await getProspectRow(ctx, args.associatedId);
  else await getAccountRow(ctx, args.associatedId);

  const [conn] = await ctx.db
    .select()
    .from(crmConnections)
    .where(eq(crmConnections.workspaceId, ctx.principal.workspaceId))
    .limit(1);
  const type = conn?.type ?? 'none';
  if (type === 'none') throw noCrmConnection(args.integrationType);
  if ((type === 'salesforce' || type === 'hubspot') && type !== args.integrationType) {
    throw unprocessable(`integrationType must be ${type} for this workspace`, { field: 'integrationType' });
  }
  if (type === 'hubspot') {
    const row = await pushNote(ctx, args, deps);
    await emitEvent(ctx.db, { workspaceId: ctx.principal.workspaceId, type: 'note.created', aggregateType: 'note', aggregateId: row.id, payload: { noteId: row.id, associatedType: args.associatedType, associatedId: args.associatedId, integrationType: 'hubspot' } });
    return serializeNote(row);
  }
  if (type === 'salesforce') throw noCrmConnection(args.integrationType);
  const [row] = await ctx.db
    .insert(notes)
    .values({
      workspaceId: ctx.principal.workspaceId,
      associatedType: args.associatedType,
      associatedId: args.associatedId,
      text: args.text,
      integrationType: args.integrationType,
      createdBy: ctx.principal.userId,
      userName: ctx.principal.name ?? null,
    })
    .returning();
  await emitEvent(ctx.db, {
    workspaceId: ctx.principal.workspaceId,
    type: 'note.created',
    aggregateType: 'note',
    aggregateId: row!.id,
    payload: { noteId: row!.id, associatedType: args.associatedType, associatedId: args.associatedId },
  });
  return serializeNote(row!);
}

export async function setCrmConnection(ctx: Ctx, type: 'none' | 'csv' | 'salesforce' | 'hubspot') {
  await ctx.db
    .insert(crmConnections)
    .values({ workspaceId: ctx.principal.workspaceId, type, status: type === 'none' ? 'disconnected' : 'connected' })
    .onConflictDoUpdate({ target: crmConnections.workspaceId, set: { type, status: type === 'none' ? 'disconnected' : 'connected' } });
}
