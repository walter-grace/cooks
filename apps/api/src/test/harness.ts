import { createApiKey } from '@cooks/auth';
import { MemoryJobs } from '@cooks/core';
import { users, workspaceMembers, workspaces } from '@cooks/db';
import { createTestDb } from '@cooks/db/test';
import { createApp } from '../app.js';
import { MemoryRateLimitStore } from '../middleware/rate-limit.js';

export interface FakeClock {
  now(): Date;
  set(d: Date): void;
  advance(ms: number): void;
}

export function fakeClock(start = new Date('2026-03-02T15:00:00Z')): FakeClock {
  let t = start;
  return { now: () => t, set: (d) => (t = d), advance: (ms) => (t = new Date(t.getTime() + ms)) };
}

export async function createTestApp(opts: { fetchImpl?: typeof fetch } = {}) {
  const t = await createTestDb();
  const [ws] = await t.db.insert(workspaces).values({ name: 'Acme', slug: 'acme' }).returning();
  const [owner] = await t.db.insert(users).values({ email: 'owner@acme.test', name: 'Olive Owner' }).returning();
  const [rep] = await t.db.insert(users).values({ email: 'rep@acme.test', name: 'Ray Rep' }).returning();
  await t.db.insert(workspaceMembers).values([
    { workspaceId: ws!.id, userId: owner!.id, role: 'admin' },
    { workspaceId: ws!.id, userId: rep!.id, role: 'user' },
  ]);
  const key = await createApiKey(t.db, { workspaceId: ws!.id, name: 'test' });
  const jobs = new MemoryJobs();
  const clock = fakeClock();
  const { app, registry } = createApp({ db: t.db, jobs, clock, rateLimitStore: new MemoryRateLimitStore(), publicIps: ['203.0.113.7'], fetchImpl: opts.fetchImpl });

  const request = async (path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token !== null) headers.set('authorization', `Bearer ${init.token ?? key.token}`);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(init.json);
    }
    const res = await app.request(path, { ...init, headers, body });
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    return { status: res.status, headers: res.headers, json, text };
  };

  return {
    app,
    db: t.db,
    registry,
    jobs,
    clock,
    token: key.token,
    workspaceId: ws!.id,
    ownerId: owner!.id,
    repId: rep!.id,
    request,
    close: () => t.close(),
  };
}

export type TestApp = Awaited<ReturnType<typeof createTestApp>>;
