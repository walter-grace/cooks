import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@cooks/db/test';
import { workspaces, type Db } from '@cooks/db';
import { PgRateLimitStore } from './rate-limit.js';

let db: Db;
let close: () => Promise<void>;
let ws: string;
beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  close = t.close;
  ws = (await db.insert(workspaces).values({ name: 'A', slug: 'a' }).returning())[0]!.id;
});
afterAll(() => close());

describe('PgRateLimitStore', () => {
  it('counts per (workspace, bucket, window) and sweeps old windows', async () => {
    const store = new PgRateLimitStore(db);
    const w1 = new Date('2026-03-03T15:00:00Z');
    const w2 = new Date('2026-03-03T15:01:00Z');
    expect(await store.hit(ws, 'list:GET /v1/tags', w1)).toBe(1);
    expect(await store.hit(ws, 'list:GET /v1/tags', w1)).toBe(2);
    expect(await store.hit(ws, 'default', w1)).toBe(1);
    expect(await store.hit(ws, 'list:GET /v1/tags', w2)).toBe(1);
    await store.sweep(w2);
    expect(await store.hit(ws, 'list:GET /v1/tags', w1)).toBe(1);
  });
});
