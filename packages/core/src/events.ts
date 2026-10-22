import { outboxEvents } from '@cooks/db';
import type { DbOrTx } from '@cooks/db';

export type EventType =
  | 'call.logged'
  | 'email.sent'
  | 'email.delivered'
  | 'email.opened'
  | 'email.clicked'
  | 'email.replied'
  | 'email.bounced'
  | 'prospect.created'
  | 'prospect.updated'
  | 'prospect.unsubscribed'
  | 'sequence_state.created'
  | 'sequence_state.paused'
  | 'sequence_state.resumed'
  | 'sequence_state.finished'
  | 'task.created'
  | 'task.due'
  | 'task.completed'
  | 'task.skipped'
  | 'note.created'
  | 'webhook.verification';

export interface EmitArgs {
  workspaceId: string;
  type: EventType;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
}

/** Transactional outbox: write the event in the same transaction as the domain change. */
export async function emitEvent(db: DbOrTx, e: EmitArgs): Promise<string> {
  const [row] = await db
    .insert(outboxEvents)
    .values({
      workspaceId: e.workspaceId,
      eventType: e.type,
      aggregateType: e.aggregateType,
      aggregateId: e.aggregateId,
      payload: e.payload,
      dedupeKey: e.dedupeKey ?? null,
    })
    .returning({ id: outboxEvents.id });
  return row!.id;
}
