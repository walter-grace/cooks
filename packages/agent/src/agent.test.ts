import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@cooks/db/test';
import { agentRuns, emails, prospects, sequenceStates, sequenceSteps, sequences, tasks, users, workspaceAiSettings, workspaceMembers, workspaces, type Db } from '@cooks/db';
import { advanceEnrollment, executeStep, MemoryJobs, systemPrincipal, type Ctx } from '@cooks/core';
import { draftEmailForTask } from './jobs/draft-email.js';
import { estimateCostUsd } from './providers/pricing.js';
import { inputHash, redact } from './runs/store.js';
import type { LlmProvider, StructuredRequest, StructuredResult } from './providers/types.js';
import { DraftEmailOutput } from './contracts/draft-email.js';

class FakeProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model = 'fake-1';
  public calls: StructuredRequest<unknown>[] = [];
  constructor(private answer: (req: StructuredRequest<unknown>) => unknown) {}
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    const value = this.answer(req as StructuredRequest<unknown>);
    const r = req.schema.safeParse(value);
    if (!r.success) return { kind: 'invalid', error: r.error.message, text: JSON.stringify(value), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.0001 }, model: this.model, latencyMs: 1 };
    return { kind: 'ok', value: r.data, usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 }, model: this.model, latencyMs: 5 };
  }
}

describe('pricing + hashing + redaction', () => {
  it('prices known models, nulls unknown; hashes are order-independent; PII is masked', () => {
    expect(estimateCostUsd('claude-opus-5-5', { input: 1_000_000, output: 0 })).toBe(4);
    expect(estimateCostUsd('mystery', { input: 1, output: 1 })).toBeNull();
    expect(inputHash('k', 'm', 1, { a: 1, b: 2 })).toBe(inputHash('k', 'm', 1, { b: 2, a: 1 }));
    const r = redact({ email: 'Ada@Globex.test', phone: '+1 (415) 555-0199', note: 'call 2026' });
    expect(r.email).toMatch(/^email:[0-9a-f]{8}$/);
    expect(r.phone).toBe('phone:***');
    expect(r.note).toBe('call 2026');
  });
});

describe('ai.draft_email for an aiEmail step', () => {
  let db: Db;
  let close: () => Promise<void>;
  const ids = { ws: '', owner: '', task: '' };
  const env = { ANTHROPIC_API_KEY: 'test-key' };
  const now = () => new Date('2026-03-03T15:00:00Z');

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    const [ws] = await db.insert(workspaces).values({ name: 'A', slug: 'a', settings: { jitterSeconds: 0, timezone: 'UTC', sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } } }).returning();
    const [u] = await db.insert(users).values({ email: 'olive@acme.test', name: 'Olive Owner', title: 'AE', calendarUrl: 'https://cal/olive' }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: 'admin' });
    const [p] = await db.insert(prospects).values({ workspaceId: ws!.id, firstName: 'Ada', lastName: 'Lovelace', name: 'Ada Lovelace', title: 'CTO', primaryEmail: 'ada@globex.test' }).returning();
    const [s] = await db.insert(sequences).values({ workspaceId: ws!.id, name: 'Intro', ownerId: u!.id }).returning();
    const [st] = await db.insert(sequenceSteps).values({ workspaceId: ws!.id, sequenceId: s!.id, order: 1, action: 'manual_email', intervalMinutes: 0, aiEmail: { promptOverride: 'Mention our migration tooling.' }, note: 'First touch' }).returning();
    const [en] = await db.insert(sequenceStates).values({ workspaceId: ws!.id, sequenceId: s!.id, prospectId: p!.id, ownerId: u!.id }).returning();
    const jobs = new MemoryJobs();
    const ctx: Ctx = { db, principal: systemPrincipal(ws!.id), jobs, clock: { now }, traceId: 't', publicUrl: 'http://x' };
    await advanceEnrollment(ctx, en!.id);
    expect(await executeStep(ctx, en!.id, st!.id)).toBe('task_created');
    // the engine asks for a draft when the step has aiEmail
    expect(jobs.sent.some((j) => j.name === 'ai.draft_email')).toBe(true);
    const [task] = await db.select().from(tasks).where(eq(tasks.sequenceStateId, en!.id));
    Object.assign(ids, { ws: ws!.id, owner: u!.id, task: task!.id });
  });
  afterAll(() => close());

  it('attaches a reviewed draft to the task and records the run with cost', async () => {
    const fake = new FakeProvider(() => ({ subject: 'Migration at Globex', bodyText: 'Hi Ada,\n\nQuick note about migration tooling for CTOs.\n\nWorth 15 minutes?', usedFacts: ['Ada is CTO'], riskFlags: [], confidence: 0.9, rationale: 'clear ask' }));
    const out = await draftEmailForTask({ db, env, now, providerOverride: fake }, ids.task);
    expect(out.status).toBe('drafted');
    expect(fake.calls[0]!.user).toContain('Mention our migration tooling.');
    expect(fake.calls[0]!.schema).toBe(DraftEmailOutput);
    const [task] = await db.select().from(tasks).where(eq(tasks.id, ids.task));
    expect(task!.draftEmailId).toBeTruthy();
    const [draft] = await db.select().from(emails).where(eq(emails.id, task!.draftEmailId!));
    expect(draft).toMatchObject({ status: 'draft', subject: 'Migration at Globex', toAddr: 'ada@globex.test' });
    expect(draft!.bodyHtml).toBe('<p>Hi Ada,</p><p>Quick note about migration tooling for CTOs.</p><p>Worth 15 minutes?</p>');
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.workspaceId, ids.ws));
    expect(run).toMatchObject({ kind: 'draft_email', status: 'succeeded', provider: 'anthropic', model: 'fake-1', tokensIn: 100, tokensOut: 50 });
    expect(Number(run!.costUsd)).toBe(0.001);
    expect(JSON.stringify(run!.inputRedacted)).not.toContain('ada@globex.test');
    // second call is a no-op
    expect((await draftEmailForTask({ db, env, now, providerOverride: fake }, ids.task)).status).toBe('skipped');
  });

  it('low confidence routes to needs_review; no provider configured skips; budget stops spend', async () => {
    const [p2] = await db.insert(prospects).values({ workspaceId: ids.ws, firstName: 'Bob', name: 'Bob', primaryEmail: 'bob@globex.test' }).returning();
    const [st] = await db.select().from(sequenceSteps).limit(1);
    const mk = async () => (await db.insert(tasks).values({ workspaceId: ids.ws, prospectId: p2!.id, ownerId: ids.owner, action: 'manual_email', dueAt: now(), sequenceId: st!.sequenceId, sequenceStepId: st!.id }).returning())[0]!.id;
    const low = new FakeProvider(() => ({ subject: 's', bodyText: 'b', usedFacts: [], riskFlags: ['unverified_claim'], confidence: 0.4, rationale: 'thin' }));
    const t1 = await mk();
    const out = await draftEmailForTask({ db, env, now, providerOverride: low }, t1);
    expect(out.status).toBe('needs_review');
    const [task] = await db.select().from(tasks).where(eq(tasks.id, t1));
    expect(task!.note).toContain('needs review');
    const t2 = await mk();
    expect((await draftEmailForTask({ db, env: {}, now, providerOverride: low }, t2)).status).toBe('skipped');
    await db.insert(workspaceAiSettings).values({ workspaceId: ids.ws, provider: 'anthropic', monthlyBudgetUsd: '0.0005' });
    const t3 = await mk();
    const stopped = await draftEmailForTask({ db, env, now, providerOverride: low }, t3);
    expect(stopped).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/budget/) });
  });
});
