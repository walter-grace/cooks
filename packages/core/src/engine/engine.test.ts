import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from '@cooks/db/test';
import { prospects, sequenceStates, sequenceSteps, sequences, stepExecutions, tasks, users, workspaceMembers, workspaces, type Db } from '@cooks/db';
import { eq } from 'drizzle-orm';
import { alignToWindow, computeNextRunAt, seededJitterSeconds } from './scheduling.js';
import { advanceEnrollment } from './advance.js';
import { executeStep } from './execute.js';
import { finishEnrollment, onTaskResolved, pauseEnrollment, resumeEnrollment } from './transitions.js';
import { MemoryJobs } from '../jobs.js';
import { systemPrincipal } from '../principal.js';
import type { Ctx } from '../context.js';

const NY = 'America/New_York';

describe('scheduling', () => {
  it('keeps in-window times and moves others to the next window open, in the prospect zone', () => {
    const w = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
    const inside = new Date('2026-03-03T15:00:00Z'); // Tue 10:00 EST
    expect(alignToWindow(inside, w, NY).toISOString()).toBe(inside.toISOString());
    const late = new Date('2026-03-03T23:30:00Z'); // Tue 18:30 EST → Wed 08:00 EST
    expect(alignToWindow(late, w, NY).toISOString()).toBe('2026-03-04T13:00:00.000Z');
    const sat = new Date('2026-03-07T15:00:00Z'); // Sat → Mon 08:00 EST
    expect(alignToWindow(sat, w, NY).toISOString()).toBe('2026-03-09T12:00:00.000Z'); // DST started Mar 8: 08:00 EDT = 12:00Z
    const fallBack = new Date('2026-10-31T23:00:00Z'); // Sat → Mon Nov 2, 08:00 EST (DST ended Nov 1) = 13:00Z
    expect(alignToWindow(fallBack, w, NY).toISOString()).toBe('2026-11-02T13:00:00.000Z');
  });
  it('jitter is deterministic and bounded; next run never in the past', () => {
    expect(seededJitterSeconds('a', 300)).toBe(seededJitterSeconds('a', 300));
    expect(seededJitterSeconds('a', 300)).toBeLessThan(300);
    const now = new Date('2026-03-03T15:00:00Z');
    const d = computeNextRunAt({ base: new Date('2026-03-01T00:00:00Z'), intervalMinutes: 0, tz: NY, seed: 's', now, jitterSeconds: 0 });
    expect(d.getTime()).toBeGreaterThanOrEqual(now.getTime());
  });
});

describe('enrollment engine on PGlite', () => {
  let db: Db;
  let close: () => Promise<void>;
  let ctx: Ctx;
  let jobs: MemoryJobs;
  let now = new Date('2026-03-03T15:00:00Z');
  const ids = { ws: '', owner: '', prospect: '', seq: '', s1: '', s2: '', s3: '' };

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    const [ws] = await db.insert(workspaces).values({ name: 'A', slug: 'a', settings: { jitterSeconds: 0, timezone: 'UTC' } }).returning();
    const [u] = await db.insert(users).values({ email: 'o@a.test', name: 'O', timezone: 'UTC' }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: 'admin' });
    const [p] = await db.insert(prospects).values({ workspaceId: ws!.id, name: 'Ada', primaryEmail: 'ada@x.test', timezone: 'UTC' }).returning();
    const [s] = await db.insert(sequences).values({ workspaceId: ws!.id, name: 'Intro', ownerId: u!.id }).returning();
    const [s1, s2, s3] = await db
      .insert(sequenceSteps)
      .values([
        { workspaceId: ws!.id, sequenceId: s!.id, order: 1, action: 'call', intervalMinutes: 0 },
        { workspaceId: ws!.id, sequenceId: s!.id, order: 2, action: 'auto_email', intervalMinutes: 60 * 24 },
        { workspaceId: ws!.id, sequenceId: s!.id, order: 3, action: 'manual_linkedin_message', intervalMinutes: 30 },
      ])
      .returning();
    Object.assign(ids, { ws: ws!.id, owner: u!.id, prospect: p!.id, seq: s!.id, s1: s1!.id, s2: s2!.id, s3: s3!.id });
    jobs = new MemoryJobs();
    ctx = { db, principal: systemPrincipal(ws!.id), jobs, clock: { now: () => now }, traceId: 't', publicUrl: 'http://x' };
  });
  afterAll(() => close());

  it('enroll → advance schedules step 1 → execute creates a task → complete → advances to the auto email', async () => {
    const [st] = await db.insert(sequenceStates).values({ workspaceId: ids.ws, sequenceId: ids.seq, prospectId: ids.prospect, ownerId: ids.owner }).returning();
    expect(await advanceEnrollment(ctx, st!.id)).toBe('scheduled');
    let row = (await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id)))[0]!;
    expect(row.currentStepId).toBe(ids.s1);
    expect(row.stepPhase).toBe('scheduled');
    expect(row.nextRunAt!.toISOString()).toBe('2026-03-03T15:00:00.000Z'); // interval 0, inside window, jitter 0
    const job = jobs.sent.at(-1)!;
    expect(job.name).toBe('step.execute');
    expect(job.opts?.singletonKey).toBe(`${st!.id}:${ids.s1}`);

    expect(await executeStep(ctx, st!.id, ids.s1)).toBe('task_created');
    expect(await executeStep(ctx, st!.id, ids.s1)).toBe('skipped'); // phase moved on
    const [task] = await db.select().from(tasks).where(eq(tasks.sequenceStateId, st!.id));
    expect(task!.action).toBe('call');
    expect(task!.status).toBe('ready');
    const execs = await db.select().from(stepExecutions).where(eq(stepExecutions.sequenceStateId, st!.id));
    expect(execs).toHaveLength(1);

    // complete the task → engine queues advance → run it
    now = new Date('2026-03-03T16:00:00Z');
    await db.update(tasks).set({ completed: true, status: 'finished' }).where(eq(tasks.id, task!.id));
    await onTaskResolved(ctx, { ...task!, completed: true, status: 'finished' }, 'completed');
    expect(jobs.sent.at(-1)!.name).toBe('enrollment.advance');
    expect(await advanceEnrollment(ctx, st!.id, { prevDoneAt: now })).toBe('scheduled');
    row = (await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id)))[0]!;
    expect(row.currentStepId).toBe(ids.s2);
    // 24h after 16:00Z Tue = 16:00Z Wed, inside UTC window
    expect(row.nextRunAt!.toISOString()).toBe('2026-03-04T16:00:00.000Z');

    // fire the auto email step: email row + email.send job
    now = new Date('2026-03-04T16:00:00Z');
    expect(await executeStep(ctx, st!.id, ids.s2)).toBe('email_queued');
    expect(jobs.sent.at(-1)!.name).toBe('email.send');
    row = (await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id)))[0]!;
    expect(row.stepPhase).toBe('executing');

    // pause + resume keeps the pointer; finishing skips open tasks and is idempotent
    expect(await pauseEnrollment(ctx, st!.id)).toBe(true);
    expect(await resumeEnrollment(ctx, st!.id)).toBe(true);
    expect(await finishEnrollment(ctx, st!.id, 'manual')).toBe(true);
    expect(await finishEnrollment(ctx, st!.id, 'manual')).toBe(false);
    row = (await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id)))[0]!;
    expect(row.state).toBe('finished');
    expect(row.finishReason).toBe('manual');
  });

  it('a deleted step mid-flight falls through to the next one; last step finishes the enrollment', async () => {
    const [p2] = await db.insert(prospects).values({ workspaceId: ids.ws, name: 'Bob', primaryEmail: 'bob@x.test' }).returning();
    const [st] = await db.insert(sequenceStates).values({ workspaceId: ids.ws, sequenceId: ids.seq, prospectId: p2!.id, ownerId: ids.owner, currentStepOrder: 1 }).returning();
    now = new Date('2026-03-05T15:00:00Z');
    expect(await advanceEnrollment(ctx, st!.id)).toBe('scheduled');
    let row = (await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id)))[0]!;
    expect(row.currentStepId).toBe(ids.s2);
    await db.update(sequenceSteps).set({ deletedAt: now }).where(eq(sequenceSteps.id, ids.s2));
    expect(await executeStep(ctx, st!.id, ids.s2)).toBe('skipped');
    row = (await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id)))[0]!;
    expect(row.currentStepId).toBe(ids.s3);
    expect(await executeStep(ctx, st!.id, ids.s3)).toBe('task_created');
    const [task] = await db.select().from(tasks).where(eq(tasks.sequenceStateId, st!.id));
    await onTaskResolved(ctx, { ...task!, completed: false, status: 'skipped' }, 'skipped');
    expect(await advanceEnrollment(ctx, st!.id)).toBe('finished');
    row = (await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id)))[0]!;
    expect(row.finishReason).toBe('completed');
  });

  it('disabled sequence holds enrollments instead of scheduling', async () => {
    const [p3] = await db.insert(prospects).values({ workspaceId: ids.ws, name: 'Cy', primaryEmail: 'cy@x.test' }).returning();
    const [st] = await db.insert(sequenceStates).values({ workspaceId: ids.ws, sequenceId: ids.seq, prospectId: p3!.id, ownerId: ids.owner }).returning();
    await db.update(sequences).set({ enabled: false }).where(eq(sequences.id, ids.seq));
    expect(await advanceEnrollment(ctx, st!.id)).toBe('held');
    const row = (await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id)))[0]!;
    expect(row.holdReason).toBe('sequence_disabled');
    await db.update(sequences).set({ enabled: true }).where(eq(sequences.id, ids.seq));
  });
});
