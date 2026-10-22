import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@cooks/db/test';
import { emails, mailboxes, prospects, sequenceStates, sequenceSteps, sequences, suppressions, tasks, users, workspaceMembers, workspaces, type Db } from '@cooks/db';
import { extractReturnDate, parseRfc822 } from './parse.js';
import { processInbound } from './inbound.js';
import { MemoryMailProvider, type InboundMessage } from './provider.js';
import { sendQueuedEmail } from './send.js';
import { advanceEnrollment, executeStep } from '../engine/index.js';
import { MemoryJobs } from '../jobs.js';
import { systemPrincipal } from '../principal.js';
import type { Ctx } from '../context.js';

describe('parse', () => {
  it('parses a reply with threading headers', async () => {
    const m = await parseRfc822(
      ['From: Ada <ada@globex.test>', 'To: olive@acme.test', 'Subject: Re: Hello', 'Message-ID: <r1@globex.test>', 'In-Reply-To: <o1@acme.test>', 'References: <o1@acme.test>', 'Date: Tue, 03 Mar 2026 16:00:00 +0000', '', 'Sure, Thursday works.'].join('\r\n'),
      'p1',
    );
    expect(m).toMatchObject({ from: 'ada@globex.test', inReplyTo: '<o1@acme.test>', references: ['<o1@acme.test>'], autoSubmitted: false, dsn: null });
    expect(m.text.trim()).toBe('Sure, Thursday works.');
  });
  it('detects out-of-office and return dates', async () => {
    const m = await parseRfc822(['From: ada@globex.test', 'To: olive@acme.test', 'Subject: Automatic reply: Hello', 'Auto-Submitted: auto-replied', '', 'I am out of the office and will be back on March 9.'].join('\r\n'), 'p2');
    expect(m.autoSubmitted).toBe(true);
    expect(extractReturnDate(m.text, new Date('2026-03-03T00:00:00Z'))?.toISOString()).toBe('2026-03-09T00:00:00.000Z');
    expect(extractReturnDate('back on 2026-04-01', new Date('2026-03-03T00:00:00Z'))?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(extractReturnDate('no dates here', new Date())).toBeNull();
  });
  it('detects a hard bounce DSN', async () => {
    const m = await parseRfc822(
      ['From: Mail Delivery System <MAILER-DAEMON@mx.test>', 'To: olive@acme.test', 'Subject: Undeliverable: Hello', '', 'Final-Recipient: rfc822; nobody@globex.test', 'Action: failed', 'Status: 5.1.1', 'Diagnostic-Code: smtp; 550 5.1.1 user unknown', 'Original-Message-ID: <o9@acme.test>'].join('\r\n'),
      'p3',
    );
    expect(m.dsn).toMatchObject({ action: 'failed', status: '5.1.1', recipient: 'nobody@globex.test', originalMessageId: '<o9@acme.test>' });
  });
});

describe('processInbound', () => {
  let db: Db;
  let close: () => Promise<void>;
  let ctx: Ctx;
  const jobs = new MemoryJobs();
  let now = new Date('2026-03-03T15:00:00Z');
  const ids = { ws: '', owner: '', seq: '', step: '', mailbox: '' };
  let mailbox: typeof mailboxes.$inferSelect;

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    const [ws] = await db.insert(workspaces).values({ name: 'A', slug: 'a', settings: { jitterSeconds: 0, timezone: 'UTC', sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } } }).returning();
    const [u] = await db.insert(users).values({ email: 'olive@acme.test', name: 'Olive' }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: 'admin' });
    [mailbox] = (await db.insert(mailboxes).values({ workspaceId: ws!.id, userId: u!.id, email: 'olive@acme.test', isDefault: true, minGapSeconds: 0, dailySendLimit: 1000 }).returning()) as [typeof mailboxes.$inferSelect];
    const [s] = await db.insert(sequences).values({ workspaceId: ws!.id, name: 'Intro', ownerId: u!.id }).returning();
    const [st] = await db.insert(sequenceSteps).values([{ workspaceId: ws!.id, sequenceId: s!.id, order: 1, action: 'auto_email', intervalMinutes: 0 }]).returning();
    await db.insert(sequenceSteps).values({ workspaceId: ws!.id, sequenceId: s!.id, order: 2, action: 'call', intervalMinutes: 60 });
    Object.assign(ids, { ws: ws!.id, owner: u!.id, seq: s!.id, step: st!.id, mailbox: mailbox.id });
    ctx = { db, principal: systemPrincipal(ws!.id), jobs, clock: { now: () => now }, traceId: 't', publicUrl: 'http://x' };
  });
  afterAll(() => close());

  async function sendTo(email: string, overrides = { subject: 'Hello {{ prospect.firstName }}', body: '<p>hi</p>' }) {
    const [p] = await db.insert(prospects).values({ workspaceId: ids.ws, firstName: email.split('@')[0], name: email.split('@')[0], primaryEmail: email }).returning();
    const [st] = await db.insert(sequenceStates).values({ workspaceId: ids.ws, sequenceId: ids.seq, prospectId: p!.id, ownerId: ids.owner, mailboxId: ids.mailbox, emailOverrides: { [ids.step]: overrides } }).returning();
    await advanceEnrollment(ctx, st!.id);
    await executeStep(ctx, st!.id, ids.step);
    const [em] = await db.select().from(emails).where(eq(emails.sequenceStateId, st!.id));
    const mail = new MemoryMailProvider();
    expect((await sendQueuedEmail(ctx, em!.id, { providerFor: async () => mail, trackingSecret: 's' })).status).toBe('sent');
    const [sent] = await db.select().from(emails).where(eq(emails.id, em!.id));
    return { prospect: p!, state: st!, outbound: sent! };
  }
  const inbound = (over: Partial<InboundMessage>): InboundMessage => ({ providerId: `p-${Math.random()}`, messageId: `<${Math.random()}@globex.test>`, inReplyTo: null, references: [], from: 'x@globex.test', to: ['olive@acme.test'], date: now, subject: 'Re: Hello', text: 'reply', html: null, headers: {}, autoSubmitted: false, dsn: null, ...over });

  it('a real reply finishes the enrollment (default policy), marks replied, creates a high-priority task, queues classification', async () => {
    const { outbound, state } = await sendTo('ada@globex.test');
    now = new Date('2026-03-03T16:00:00Z');
    jobs.clear();
    const out = await processInbound(ctx, mailbox, inbound({ from: 'ada@globex.test', inReplyTo: outbound.messageId!, text: 'Sure, Thursday works.' }), { classify: true });
    expect(out).toMatchObject({ kind: 'reply', outboundId: outbound.id, action: 'finish' });
    const [o] = await db.select().from(emails).where(eq(emails.id, outbound.id));
    expect(o!.repliedAt).toBeTruthy();
    const [st] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, state.id));
    expect(st).toMatchObject({ state: 'finished', finishReason: 'replied' });
    const ts = await db.select().from(tasks).where(eq(tasks.prospectId, state.prospectId));
    expect(ts.some((t) => t.action === 'manual_email_reply' && t.priority === 'high' && t.status === 'ready')).toBe(true);
    expect(jobs.sent.some((j) => j.name === 'ai.classify_reply')).toBe(true);
    // same message again is a duplicate
    expect((await processInbound(ctx, mailbox, inbound({ from: 'ada@globex.test', inReplyTo: outbound.messageId!, messageId: (await db.select().from(emails).where(eq(emails.direction, 'inbound')))[0]!.messageId }))).kind).toBe('duplicate');
  });

  it('pause policy pauses instead; sender-only matching works without headers', async () => {
    await db.update(workspaces).set({ settings: { jitterSeconds: 0, timezone: 'UTC', replyBehavior: 'pause', sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } } }).where(eq(workspaces.id, ids.ws));
    const { state } = await sendTo('bob@globex.test');
    const out = await processInbound(ctx, mailbox, inbound({ from: 'bob@globex.test', subject: 'quick q' }));
    expect(out).toMatchObject({ kind: 'reply', action: 'pause' });
    const [st] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, state.id));
    expect(st!.state).toBe('paused');
  });

  it('out-of-office does not finish and pushes the scheduled next step past the return date', async () => {
    await db.update(workspaces).set({ settings: { jitterSeconds: 0, timezone: 'UTC', replyBehavior: 'finish', sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } } }).where(eq(workspaces.id, ids.ws));
    const { outbound, state } = await sendTo('cy@globex.test');
    // the engine queued an advance; run it so step 2 is scheduled
    await advanceEnrollment(ctx, state.id, { prevDoneAt: now });
    let [st] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, state.id));
    expect(st!.stepPhase).toBe('scheduled');
    jobs.clear();
    const out = await processInbound(ctx, mailbox, inbound({ from: 'cy@globex.test', inReplyTo: outbound.messageId!, subject: 'Automatic reply: Hello', text: 'Out of office until 2026-03-20.', autoSubmitted: true }));
    expect(out.kind).toBe('auto_reply');
    expect((out as { pushedTo?: Date }).pushedTo?.toISOString()).toBe('2026-03-21T00:00:00.000Z');
    [st] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, state.id));
    expect(st!.state).toBe('active');
    expect(st!.nextRunAt?.toISOString()).toBe('2026-03-21T00:00:00.000Z');
    expect(jobs.sent.at(-1)!.name).toBe('step.execute');
  });

  it('hard bounce suppresses the address, marks the prospect and finishes enrollments', async () => {
    const { outbound, state, prospect } = await sendTo('dee@globex.test');
    const out = await processInbound(ctx, mailbox, inbound({ from: 'mailer-daemon@mx.test', subject: 'Undeliverable', dsn: { action: 'failed', status: '5.1.1', recipient: 'dee@globex.test', originalMessageId: outbound.messageId, diagnostic: '550 user unknown' } }));
    expect(out).toMatchObject({ kind: 'bounce', hard: true, emailId: outbound.id });
    const [o] = await db.select().from(emails).where(eq(emails.id, outbound.id));
    expect(o!.bouncedAt).toBeTruthy();
    const [p] = await db.select().from(prospects).where(eq(prospects.id, prospect.id));
    expect(p!.emailStatus).toBe('bounced');
    const sup = await db.select().from(suppressions).where(eq(suppressions.emailLower, 'dee@globex.test'));
    expect(sup).toHaveLength(1);
    const [st] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, state.id));
    expect(st).toMatchObject({ state: 'finished', finishReason: 'bounced' });
  });

  it('unknown senders are stored as unmatched', async () => {
    const out = await processInbound(ctx, mailbox, inbound({ from: 'stranger@elsewhere.test', subject: 'newsletter' }));
    expect(out.kind).toBe('unmatched');
  });
});
