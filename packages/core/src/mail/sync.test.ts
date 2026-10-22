import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@cooks/db/test';
import { emails, mailboxCredentials, mailboxes, prospects, sequenceStates, sequences, suppressions, tasks, users, workspaceMembers, workspaces, type Db } from '@cooks/db';
import { applyClassification, syncMailbox } from './sync.js';
import type { InboundMessage, InboundProvider, SyncCursor } from './provider.js';
import { MemoryJobs } from '../jobs.js';
import { systemPrincipal } from '../principal.js';
import type { Ctx } from '../context.js';

class FakeInbox implements InboundProvider {
  public queue: InboundMessage[] = [];
  public lastCursor: SyncCursor | null = null;
  async sync(cursor: SyncCursor | null) {
    this.lastCursor = cursor;
    const messages = this.queue.splice(0);
    return { messages, cursor: { n: Number(cursor?.n ?? 0) + messages.length } };
  }
}

describe('syncMailbox + applyClassification', () => {
  let db: Db;
  let close: () => Promise<void>;
  let ctx: Ctx;
  const jobs = new MemoryJobs();
  const now = new Date('2026-03-03T15:00:00Z');
  let mailboxId = '';
  let ws = '';
  let owner = '';
  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    const [w] = await db.insert(workspaces).values({ name: 'A', slug: 'a' }).returning();
    const [u] = await db.insert(users).values({ email: 'olive@acme.test', name: 'Olive' }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: w!.id, userId: u!.id, role: 'admin' });
    const [mb] = await db.insert(mailboxes).values({ workspaceId: w!.id, userId: u!.id, email: 'olive@acme.test' }).returning();
    ws = w!.id;
    owner = u!.id;
    mailboxId = mb!.id;
    ctx = { db, principal: systemPrincipal(ws), jobs, clock: { now: () => now }, traceId: 't', publicUrl: 'http://x' };
  });
  afterAll(() => close());

  it('syncs messages through the provider, persists the cursor, and counts outcomes', async () => {
    const [p] = await db.insert(prospects).values({ workspaceId: ws, name: 'Ada', primaryEmail: 'ada@globex.test' }).returning();
    const fake = new FakeInbox();
    fake.queue.push({ providerId: 'm1', messageId: '<m1@g>', inReplyTo: null, references: [], from: 'ada@globex.test', to: ['olive@acme.test'], date: now, subject: 'hi', text: 'interested', html: null, headers: {}, autoSubmitted: false, dsn: null });
    fake.queue.push({ providerId: 'm2', messageId: '<m2@g>', inReplyTo: null, references: [], from: 'nobody@else.test', to: ['olive@acme.test'], date: now, subject: 'spam', text: 'x', html: null, headers: {}, autoSubmitted: false, dsn: null });
    const counts = await syncMailbox(ctx, mailboxId, { classify: false, providerOverride: fake });
    expect(counts).toEqual({ fetched: 2, reply: 1, unmatched: 1 });
    expect(fake.lastCursor).toBeNull();
    const again = await syncMailbox(ctx, mailboxId, { classify: false, providerOverride: fake });
    expect(again).toEqual({ fetched: 0 });
    expect(fake.lastCursor).toEqual({ n: 2 });
    const [cred] = await db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId));
    expect(cred!.syncCursor).toEqual({ n: 2 });
    const t = await db.select().from(tasks).where(eq(tasks.prospectId, p!.id));
    expect(t).toHaveLength(1);
  });

  it('classification: high-confidence unsubscribe suppresses + skips the task; low confidence only annotates', async () => {
    const [p] = await db.insert(prospects).values({ workspaceId: ws, name: 'Bob', primaryEmail: 'bob@globex.test' }).returning();
    const [seq] = await db.insert(sequences).values({ workspaceId: ws, name: 'S', ownerId: owner }).returning();
    const [st] = await db.insert(sequenceStates).values({ workspaceId: ws, sequenceId: seq!.id, prospectId: p!.id, ownerId: owner }).returning();
    const [inb] = await db.insert(emails).values({ workspaceId: ws, prospectId: p!.id, mailboxId, direction: 'inbound', status: 'received', fromAddr: 'bob@globex.test', subject: 'stop', bodyText: 'remove me', sequenceStateId: st!.id }).returning();
    const [task] = await db.insert(tasks).values({ workspaceId: ws, prospectId: p!.id, ownerId: owner, action: 'manual_email_reply', dueAt: now, note: 'Reply received' }).returning();
    const base = { intent: 'unsubscribe', confidence: 0.95, summary: 'asked to be removed', suggestedAction: 'unsubscribe', pauseUntil: null, draftReply: null };
    const low = await applyClassification(ctx, { inboundEmailId: inb!.id, taskId: task!.id, result: { ...base, confidence: 0.6 }, reviewed: true });
    expect(low.applied).toBe('note');
    expect((await db.select().from(suppressions)).some((s) => s.emailLower === 'bob@globex.test')).toBe(false);
    const high = await applyClassification(ctx, { inboundEmailId: inb!.id, taskId: task!.id, result: base, reviewed: false });
    expect(high.applied).toBe('unsubscribe');
    expect((await db.select().from(suppressions)).some((s) => s.emailLower === 'bob@globex.test')).toBe(true);
    const [t] = await db.select().from(tasks).where(eq(tasks.id, task!.id));
    expect(t!.status).toBe('skipped');
    expect(t!.note).toContain('AI: unsubscribe (95%)');
    const [s] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id));
    expect(s!.finishReason).toBe('unsubscribed');
  });

  it('classification: not_now with a near pauseUntil pauses the enrollment', async () => {
    const [p] = await db.insert(prospects).values({ workspaceId: ws, name: 'Cy', primaryEmail: 'cy@globex.test' }).returning();
    const [seq] = await db.insert(sequences).values({ workspaceId: ws, name: 'S2', ownerId: owner }).returning();
    const [st] = await db.insert(sequenceStates).values({ workspaceId: ws, sequenceId: seq!.id, prospectId: p!.id, ownerId: owner }).returning();
    const [inb] = await db.insert(emails).values({ workspaceId: ws, prospectId: p!.id, mailboxId, direction: 'inbound', status: 'received', fromAddr: 'cy@globex.test', subject: 'later', bodyText: 'ping me in April', sequenceStateId: st!.id }).returning();
    const r = await applyClassification(ctx, { inboundEmailId: inb!.id, taskId: null, result: { intent: 'not_now', confidence: 0.8, summary: 'try April', suggestedAction: 'pause_until', pauseUntil: '2026-04-06T00:00:00Z', draftReply: null }, reviewed: false });
    expect(r.applied).toBe('pause_until');
    const [s] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id));
    expect(s!.state).toBe('paused');
    expect(s!.scheduledAt?.toISOString()).toBe('2026-04-06T00:00:00.000Z');
  });
});
