import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@cooks/db/test';
import { emails, mailboxes, prospects, sequenceStates, sequenceSteps, sequences, suppressions, tasks, users, workspaceMembers, workspaces, type Db } from '@cooks/db';
import { buildMergeContext, htmlToText, renderTemplate } from './templates.js';
import { MemoryMailProvider } from './provider.js';
import { MAX_SEND_ATTEMPTS, classifyMailError, retryDelayMs, sendQueuedEmail } from './send.js';
import { smtpTransportOptions } from './smtp.js';
import { advanceEnrollment, executeStep } from '../engine/index.js';
import { MemoryJobs } from '../jobs.js';
import { systemPrincipal } from '../principal.js';
import type { Ctx } from '../context.js';

describe('templates', () => {
  const ctx = buildMergeContext({
    prospect: { firstName: 'Ada', lastName: 'Lovelace', title: 'CTO', primaryEmail: 'ada@globex.test', crmCustomFields: { tier: 'A' } },
    account: { name: 'Globex', domain: 'globex.test' },
    owner: { name: 'Olive Owner', email: 'olive@acme.test', calendarUrl: 'https://cal/olive' },
    sequence: { name: 'Intro' },
    step: { order: 2 },
    now: new Date('2026-03-03T15:00:00Z'),
    tz: 'America/New_York',
    unsubscribeUrl: 'http://x/u/t',
  });
  it('renders merge fields and filters', async () => {
    const r = await renderTemplate('Quick one, {{ prospect.firstName }} @ {{ account.name }}', '<p>Hi {{ prospect.firstName | first_name_or }}, it is {{ now.dayOfWeek }}. Tier {{ prospect.custom.tier }}. <a href="{{ owner.calendarUrl }}">Book</a></p>', ctx);
    expect(r.subject).toBe('Quick one, Ada @ Globex');
    expect(r.html).toContain('Hi Ada, it is Tuesday. Tier A.');
    expect(r.text).toBe('Hi Ada, it is Tuesday. Tier A. Book (https://cal/olive)');
  });
  it('blocks unknown variables (strict mode) and refuses JS-ish access', async () => {
    await expect(renderTemplate('Hi {{ prospect.nickname }}', 'x', ctx)).rejects.toThrow(/Subject template failed/);
    await expect(renderTemplate('ok', '{{ prospect.constructor.name }}', ctx)).rejects.toThrow(/Body template failed/);
  });
  it('html to text handles lists and breaks', () => {
    expect(htmlToText('<ul><li>a</li><li>b</li></ul><p>c<br>d</p>')).toBe('- a\n- b\nc\nd');
  });
});

describe('sendQueuedEmail on PGlite', () => {
  let db: Db;
  let close: () => Promise<void>;
  let jobs: MemoryJobs;
  let mail: MemoryMailProvider;
  let now = new Date('2026-03-03T15:00:00Z');
  const ids = { ws: '', owner: '', seq: '', step: '', mailbox: '' };
  let ctx: Ctx;
  const deps = () => ({ providerFor: async () => mail, fallbackFrom: null, trackingSecret: 's' });

  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    const [ws] = await db.insert(workspaces).values({ name: 'A', slug: 'a', settings: { jitterSeconds: 0, timezone: 'UTC' } }).returning();
    const [u] = await db.insert(users).values({ email: 'olive@acme.test', name: 'Olive Owner', timezone: 'UTC' }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: 'admin' });
    const [mb] = await db.insert(mailboxes).values({ workspaceId: ws!.id, userId: u!.id, email: 'olive@acme.test', isDefault: true, dailySendLimit: 2, minGapSeconds: 0 }).returning();
    const [s] = await db.insert(sequences).values({ workspaceId: ws!.id, name: 'Intro', ownerId: u!.id }).returning();
    const [st] = await db
      .insert(sequenceSteps)
      .values({ workspaceId: ws!.id, sequenceId: s!.id, order: 1, action: 'auto_email', intervalMinutes: 0 })
      .returning();
    Object.assign(ids, { ws: ws!.id, owner: u!.id, seq: s!.id, step: st!.id, mailbox: mb!.id });
    jobs = new MemoryJobs();
    mail = new MemoryMailProvider();
    ctx = { db, principal: systemPrincipal(ws!.id), jobs, clock: { now: () => now }, traceId: 't', publicUrl: 'http://cooks.test' };
  });
  afterAll(() => close());

  async function enrollAndQueue(email: string, overrides?: Record<string, { subject?: string; body?: string }>) {
    const [p] = await db.insert(prospects).values({ workspaceId: ids.ws, firstName: email.split('@')[0], name: email.split('@')[0], primaryEmail: email, timezone: 'UTC' }).returning();
    const [st] = await db.insert(sequenceStates).values({ workspaceId: ids.ws, sequenceId: ids.seq, prospectId: p!.id, ownerId: ids.owner, mailboxId: ids.mailbox, emailOverrides: overrides ?? {} }).returning();
    await advanceEnrollment(ctx, st!.id);
    expect(await executeStep(ctx, st!.id, ids.step)).toBe('email_queued');
    const [em] = await db.select().from(emails).where(eq(emails.sequenceStateId, st!.id));
    return { prospect: p!, state: st!, email: em! };
  }

  it('renders the override, sends with unsubscribe footer, records, and advances the enrollment', async () => {
    const { email, state } = await enrollAndQueue('ada@globex.test', { [ids.step]: { subject: 'Hello {{ prospect.firstName }}', body: '<p>Body for {{ prospect.name }}</p>' } });
    jobs.clear();
    const out = await sendQueuedEmail(ctx, email.id, deps());
    expect(out.status).toBe('sent');
    expect(mail.sent).toHaveLength(1);
    const m = mail.sent[0]!;
    expect(m.subject).toBe('Hello ada');
    expect(m.from).toBe('"Olive Owner" <olive@acme.test>');
    expect(m.to).toEqual(['ada@globex.test']);
    expect(m.html).toContain('Unsubscribe');
    expect(m.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const [row] = await db.select().from(emails).where(eq(emails.id, email.id));
    expect(row!.status).toBe('sent');
    expect(row!.messageId).toMatch(/^<.+@acme\.test>$/);
    const [s] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, state.id));
    expect(s!.stepPhase).toBe('done');
    expect(jobs.sent.map((j) => j.name)).toEqual(['enrollment.advance']);
    // second call is a no-op
    expect((await sendQueuedEmail(ctx, email.id, deps())).status).toBe('skipped');
  });

  it('rejects suppressed recipients and blocks the enrollment on a task instead of sending', async () => {
    await db.insert(suppressions).values({ workspaceId: ids.ws, emailLower: 'bob@globex.test', reason: 'unsubscribe' });
    const { email, state } = await enrollAndQueue('bob@globex.test');
    const out = await sendQueuedEmail(ctx, email.id, deps());
    expect(out).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/suppression/) });
    const [t] = await db.select().from(tasks).where(eq(tasks.sequenceStateId, state.id));
    expect(t!.action).toBe('manual_email');
    expect(t!.draftEmailId).toBe(email.id);
    const [s] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, state.id));
    expect(s!.stepPhase).toBe('awaiting_task');
    expect(mail.sent).toHaveLength(1);
  });

  it('rejects when the template has no subject or a bad variable', async () => {
    const { email } = await enrollAndQueue('cy@globex.test', { [ids.step]: { subject: '', body: 'x' } });
    expect((await sendQueuedEmail(ctx, email.id, deps())).status).toBe('rejected');
    const { email: e2 } = await enrollAndQueue('dee@globex.test', { [ids.step]: { subject: 'Hi {{ nope }}', body: 'x' } });
    const out = await sendQueuedEmail(ctx, e2.id, deps());
    expect(out).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/Subject template failed/) });
  });

  it('defers once the mailbox daily cap is hit', async () => {
    const { email: a } = await enrollAndQueue('e1@globex.test', { [ids.step]: { subject: 's', body: 'b' } });
    expect((await sendQueuedEmail(ctx, a.id, deps())).status).toBe('sent'); // 2nd send today (cap 2)
    const { email: b } = await enrollAndQueue('e2@globex.test', { [ids.step]: { subject: 's', body: 'b' } });
    jobs.clear();
    const out = await sendQueuedEmail(ctx, b.id, deps());
    expect(out.status).toBe('deferred');
    expect(jobs.sent[0]!.name).toBe('email.send');
    expect(jobs.sent[0]!.opts?.startAfter!.getTime()).toBeGreaterThan(now.getTime());
    // next day the cap resets
    now = new Date('2026-03-04T15:00:00Z');
    expect((await sendQueuedEmail(ctx, b.id, deps())).status).toBe('sent');
  });

  it('a transient provider failure keeps the email queued, counts the attempt and schedules a retry that then sends', async () => {
    const { email } = await enrollAndQueue('f@globex.test', { [ids.step]: { subject: 's', body: 'b' } });
    jobs.clear();
    mail.failNext = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1025'), { code: 'ECONNREFUSED' });
    const out = await sendQueuedEmail(ctx, email.id, deps());
    expect(out).toMatchObject({ status: 'deferred', reason: expect.stringMatching(/attempt 1 of 5/) });
    let [row] = await db.select().from(emails).where(eq(emails.id, email.id));
    expect(row).toMatchObject({ status: 'queued', sendAttempts: 1, error: 'connect ECONNREFUSED 127.0.0.1:1025' });
    const retry = jobs.sent.find((j) => j.name === 'email.send');
    expect(retry?.data).toEqual({ emailId: email.id, workspaceId: ids.ws });
    expect(retry!.opts!.startAfter!.getTime() - now.getTime()).toBe(60_000);
    // the retry is not skipped: the row is still queued, so the next run sends
    const sentBefore = mail.sent.length;
    expect((await sendQueuedEmail(ctx, email.id, deps())).status).toBe('sent');
    expect(mail.sent).toHaveLength(sentBefore + 1);
    [row] = await db.select().from(emails).where(eq(emails.id, email.id));
    expect(row).toMatchObject({ status: 'sent', sendAttempts: 1 });
  });

  it('a permanent SMTP 5xx fails immediately and blocks the enrollment on a task', async () => {
    now = new Date('2026-03-05T15:00:00Z'); // fresh day: the mailbox cap in this suite is 2
    const { email, state } = await enrollAndQueue('g@globex.test', { [ids.step]: { subject: 's', body: 'b' } });
    jobs.clear();
    mail.failNext = Object.assign(new Error('Message rejected: 550 5.1.1 user unknown'), { responseCode: 550 });
    const out = await sendQueuedEmail(ctx, email.id, deps());
    expect(out).toMatchObject({ status: 'failed', error: expect.stringMatching(/550/) });
    const [row] = await db.select().from(emails).where(eq(emails.id, email.id));
    expect(row).toMatchObject({ status: 'failed', sendAttempts: 1 });
    expect(jobs.sent.some((j) => j.name === 'email.send')).toBe(false);
    const [t] = await db.select().from(tasks).where(eq(tasks.sequenceStateId, state.id));
    expect(t).toMatchObject({ action: 'manual_email', draftEmailId: email.id, priority: 'high' });
    const [s] = await db.select().from(sequenceStates).where(eq(sequenceStates.id, state.id));
    expect(s!.stepPhase).toBe('awaiting_task');
    // a failed row is never re-sent by a stray job
    expect((await sendQueuedEmail(ctx, email.id, deps())).status).toBe('skipped');
  });

  it('gives up after the last transient attempt', async () => {
    now = new Date('2026-03-06T15:00:00Z');
    const { email } = await enrollAndQueue('h@globex.test', { [ids.step]: { subject: 's', body: 'b' } });
    await db.update(emails).set({ sendAttempts: MAX_SEND_ATTEMPTS - 1 }).where(eq(emails.id, email.id));
    jobs.clear();
    mail.failNext = Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' });
    const out = await sendQueuedEmail(ctx, email.id, deps());
    expect(out).toMatchObject({ status: 'failed', error: expect.stringMatching(/gave up after 5 attempts/) });
    const [row] = await db.select().from(emails).where(eq(emails.id, email.id));
    expect(row).toMatchObject({ status: 'failed', sendAttempts: MAX_SEND_ATTEMPTS });
    expect(jobs.sent.some((j) => j.name === 'email.send')).toBe(false);
  });
});

describe('classifyMailError', () => {
  const t = (e: unknown) => classifyMailError(e).transient;
  it('treats network, DNS, timeouts, SMTP 4xx and HTTP 429/5xx as transient', () => {
    expect(t(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
    expect(t(Object.assign(new Error('x'), { code: 'ECONNECTION' }))).toBe(true);
    expect(t(Object.assign(new Error('x'), { code: 'EDNS' }))).toBe(true);
    expect(t(Object.assign(new Error('421 4.7.0 Try again later'), { responseCode: 421 }))).toBe(true);
    expect(t(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(true);
    expect(t(Object.assign(new Error('bad gateway'), { status: 502 }))).toBe(true);
    expect(t(new Error('Connection timeout'))).toBe(true);
    expect(t(new Error('something odd'))).toBe(true); // unknown: retry, bounded by MAX_SEND_ATTEMPTS
  });
  it('treats SMTP 5xx, HTTP 4xx and auth failures as permanent', () => {
    expect(t(Object.assign(new Error('550 user unknown'), { responseCode: 550 }))).toBe(false);
    expect(t(Object.assign(new Error('553 relaying denied'), { response: '553 5.7.1 relaying denied' }))).toBe(false);
    expect(t(Object.assign(new Error('forbidden'), { status: 403 }))).toBe(false);
    expect(t(Object.assign(new Error('Invalid login: 535 Authentication failed'), { code: 'EAUTH', responseCode: 535 }))).toBe(false);
    expect(t(Object.assign(new Error('Invalid login'), { code: 'EAUTH' }))).toBe(false);
  });
  it('backs off 1, 5, 15 then 60 minutes', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([60_000, 300_000, 900_000, 3_600_000, 3_600_000]);
  });
});

describe('smtpTransportOptions', () => {
  it('rewrites localhost to 127.0.0.1 and keeps credentials, port and scheme', () => {
    const o = smtpTransportOptions('smtp://user:p%40ss@localhost:1025');
    expect(o.url).toBe('smtp://user:p%40ss@127.0.0.1:1025');
    expect(o.connectionTimeout).toBeLessThanOrEqual(15_000);
    expect(smtpTransportOptions('smtps://relay.test:465').url).toBe('smtps://relay.test:465');
  });
  it('rejects a malformed URL without echoing credentials', () => {
    expect(() => smtpTransportOptions('not a url')).toThrow(/not a valid URL/);
    expect(() => smtpTransportOptions('smtp://u:secret@')).toThrow(/\*\*\*@/);
  });
});
