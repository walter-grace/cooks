import { and, eq, inArray, sql } from 'drizzle-orm';
import { analyticsCounters, type DbOrTx } from '@cooks/db';
import type { Analytics } from '../schemas/common.js';

export function emptyAnalytics(): Analytics {
  return {
    email: { delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0 },
    calls: { dialed: 0, connected: 0, meetings: 0 },
    linkedIn: { connectionRequestsSent: 0, connectionRequestsAccepted: 0, messagesSent: 0, repliesReceived: null },
    messages: { sent: 0, delivered: 0, replied: 0, blocked: 0 },
    inbox: { replies: 0 },
  };
}

export type ScopeType = 'sequence' | 'sequence_step';

/** Counter rows → nested analytics objects keyed by scope id. Missing metrics read as 0. */
export async function analyticsFor(db: DbOrTx, scopeType: ScopeType, ids: string[]): Promise<Map<string, Analytics>> {
  const out = new Map<string, Analytics>();
  for (const id of ids) out.set(id, emptyAnalytics());
  if (ids.length === 0) return out;
  const rows = await db
    .select()
    .from(analyticsCounters)
    .where(and(eq(analyticsCounters.scopeType, scopeType), inArray(analyticsCounters.scopeId, ids)));
  for (const r of rows) {
    const a = out.get(r.scopeId)!;
    const [group, metric] = r.metric.split('.') as [keyof Analytics, string];
    const g = a[group] as Record<string, number | null> | undefined;
    if (g && metric in g) g[metric] = Number(r.value);
  }
  return out;
}

export async function bumpCounter(db: DbOrTx, workspaceId: string, scopeType: ScopeType, scopeId: string, metric: string, delta = 1) {
  await db
    .insert(analyticsCounters)
    .values({ workspaceId, scopeType, scopeId, metric, value: delta })
    .onConflictDoUpdate({
      target: [analyticsCounters.scopeType, analyticsCounters.scopeId, analyticsCounters.metric],
      set: { value: sql`${analyticsCounters.value} + ${delta}` },
    });
}
