import { sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { rateLimited } from '@cooks/core';
import type { Db } from '@cooks/db';
import type { AppEnv } from '../types.js';

export type RateClass = 'list' | 'get' | 'write' | 'noteWrite' | 'sync' | 'default';

/** Per workspace, fixed 60 s window. Matches the documented upstream limits. */
export const RATE_LIMITS: Record<RateClass, number> = {
  list: 300,
  get: 600,
  write: 120,
  noteWrite: 30,
  sync: 20,
  default: 30,
};

/** Buckets shared across endpoints vs. per-endpoint. */
const SHARED: Record<RateClass, boolean> = { list: false, get: false, write: false, noteWrite: true, sync: true, default: true };

export interface RateLimitStore {
  /** Increment and return the new count for (workspace, bucket, window). */
  hit(workspaceId: string, bucket: string, windowStart: Date): Promise<number>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private m = new Map<string, number>();
  async hit(workspaceId: string, bucket: string, windowStart: Date) {
    const k = `${workspaceId}|${bucket}|${windowStart.getTime()}`;
    const n = (this.m.get(k) ?? 0) + 1;
    this.m.set(k, n);
    return n;
  }
}

export class PgRateLimitStore implements RateLimitStore {
  constructor(private db: Db) {}
  async hit(workspaceId: string, bucket: string, windowStart: Date) {
    const rows = (await this.db.execute(sql`
      INSERT INTO rate_limit_buckets (workspace_id, bucket, window_start, count)
      VALUES (${workspaceId}, ${bucket}, ${windowStart}, 1)
      ON CONFLICT (workspace_id, bucket, window_start)
      DO UPDATE SET count = rate_limit_buckets.count + 1
      RETURNING count
    `)) as unknown as { rows?: Array<{ count: number }> } | Array<{ count: number }>;
    const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
    return Number(list[0]?.count ?? 1);
  }
  async sweep(olderThan: Date) {
    await this.db.execute(sql`DELETE FROM rate_limit_buckets WHERE window_start < ${olderThan}`);
  }
}

export async function enforceRateLimit(
  c: Context<AppEnv>,
  store: RateLimitStore,
  rateClass: RateClass,
  endpointKey: string,
  now: Date = new Date(),
): Promise<void> {
  const limit = RATE_LIMITS[rateClass];
  const bucket = SHARED[rateClass] ? rateClass : `${rateClass}:${endpointKey}`;
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const reset = Math.floor((windowStart.getTime() + 60_000) / 1000);
  const count = await store.hit(c.get('principal').workspaceId, bucket, windowStart);
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(Math.max(0, limit - count)));
  c.header('X-RateLimit-Reset', String(reset));
  if (count > limit) {
    const retry = Math.max(1, reset - Math.floor(now.getTime() / 1000));
    c.header('Retry-After', String(retry));
    throw rateLimited(retry);
  }
}
