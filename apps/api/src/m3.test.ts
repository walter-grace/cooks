import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { emails, workspaces } from '@cooks/db';
import { MemoryMailProvider, sendQueuedEmail, systemPrincipal, type Ctx } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
const ids = { prospect: '', mailbox: '', email: '', seq: '' };
beforeAll(async () => {
  t = await createTestApp();
  await t.db.update(workspaces).set({ settings: { timezone: 'UTC', jitterSeconds: 0, sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } } });
});
afterAll(() => t.close());
const ctx = (): Ctx => ({ db: t.db, principal: systemPrincipal(t.workspaceId), jobs: t.jobs, clock: t.clock, traceId: 'test', publicUrl: 'http://localhost' });

describe('mailboxes', () => {
  it('connects a mailbox, lists by user, rejects duplicates', async () => {
    const r = await t.request('/v1/mailboxes', { method: 'POST', json: { data: { email: 'Olive@acme.test', userId: t.ownerId, isDefault: true, minGapSeconds: 0, dailySendLimit: 100 } } });
    expect(r.status).toBe(201);
    ids.mailbox = r.json.data.id;
    expect(r.json.data).toMatchObject({ email: 'olive@acme.test', isDefault: true, user: { id: t.ownerId } });
    const dup = await t.request('/v1/mailboxes', { method: 'POST', json: { data: { email: 'olive@acme.test', userId: t.ownerId } } });
    expect(dup.status).toBe(409);
    const l = await t.request(`/v1/mailboxes?filter[userId]=${t.ownerId}&include=user`);
    expect(l.json.data[0].user.email).toBe('owner@acme.test');
    const withCreds = await t.request('/v1/mailboxes', { method: 'POST', json: { data: { email: 'rep@acme.test', userId: t.repId, smtpUrl: 'smtp://u:p@relay.test:587' } } });
    expect(withCreds.status).toBe(201);
    expect(JSON.stringify(withCreds.json)).not.toContain('relay.test');
  });
});

describe('emails', () => {
  it('POST /emails creates a draft + task; send=true queues and closes the task', async () => {
    const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', primaryEmail: 'ada@globex.test' } } });
    ids.prospect = p.json.data.id;
    const draft = await t.request('/v1/emails', { method: 'POST', json: { data: { prospectId: ids.prospect, ownerId: t.ownerId, subject: 'Draft {{ prospect.firstName }}', bodyHtml: '<p>hi</p>' } } });
    expect(draft.status).toBe(201);
    expect(draft.json.data).toMatchObject({ status: 'draft', to: 'ada@globex.test', recipients: ['ada@globex.test'] });
    const task = await t.request(`/v1/tasks/${draft.json.data.task.id}`);
    expect(task.json.data).toMatchObject({ action: 'manual_email', completed: false });

    t.jobs.clear();
    const sent = await t.request('/v1/emails', { method: 'POST', json: { data: { prospectId: ids.prospect, ownerId: t.ownerId, subject: 'Hello {{ prospect.firstName }}', bodyHtml: '<p>Check <a href="https://example.com/pricing">pricing</a></p>', send: true } } });
    expect(sent.status).toBe(201);
    expect(sent.json.data.status).toBe('queued');
    ids.email = sent.json.data.id;
    expect(t.jobs.sent.map((j) => j.name)).toEqual(['email.send']);
    const closed = await t.request(`/v1/tasks/${sent.json.data.task.id}`);
    expect(closed.json.data).toMatchObject({ completed: true, status: 'finished' });

    const list = await t.request(`/v1/emails?filter[prospect][id]=${ids.prospect}&filter[status]=draft&include=task,prospect`);
    expect(list.json.data).toHaveLength(1);
    expect(list.json.data[0].prospect.name).toBe('Ada');
    expect(list.json.data[0].task.action).toBe('manual_email');
    const bad = await t.request('/v1/emails', { method: 'POST', json: { data: { prospectId: ids.prospect, ownerId: 'nobody', subject: 's', bodyHtml: 'b' } } });
    expect(bad.status).toBe(422);
  });

  it('the worker sends the queued email with tracking, and the public endpoints record opens, clicks and unsubscribes', async () => {
    const mail = new MemoryMailProvider();
    t.clock.set(new Date('2026-03-03T15:00:00Z'));
    const out = await sendQueuedEmail(ctx(), ids.email, { providerFor: async () => mail, trackingSecret: t.kek });
    expect(out.status).toBe('sent');
    const html = mail.sent[0]!.html;
    expect(html).toContain('/t/o/');
    expect(html).toContain('/t/c/');
    expect(html).not.toContain('href="https://example.com/pricing"');
    const open = /\/t\/o\/([^"]+)"/.exec(html)![1]!;
    const click = /\/t\/c\/([^"]+)"/.exec(html)![1]!;
    const unsub = /\/u\/([^"]+)"/.exec(html)![1]!;

    // open within 10s of send is treated as a scanner prefetch
    const early = await t.request(`/t/o/${open}`, { token: null });
    expect(early.status).toBe(200);
    expect(early.headers.get('content-type')).toBe('image/gif');
    let e = (await t.db.select().from(emails).where(eq(emails.id, ids.email)))[0]!;
    expect(e.openCount).toBe(0);
    t.clock.advance(60_000);
    await t.request(`/t/o/${open}`, { token: null });
    await t.request(`/t/o/${open}`, { token: null });
    e = (await t.db.select().from(emails).where(eq(emails.id, ids.email)))[0]!;
    expect(e.openCount).toBe(2);
    expect(e.openedAt).toBeTruthy();
    const bot = await t.request(`/t/o/${open}`, { token: null, headers: { 'user-agent': 'GoogleImageProxy' } });
    expect(bot.status).toBe(200);
    const forged = await t.request(`/t/o/${ids.email}.AAAAAAAAAAAAAAAAAAAAAAAA`, { token: null });
    expect(forged.status).toBe(200); // always a pixel, never a leak

    const redirect = await t.request(`/t/c/${click}`, { token: null, redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe('https://example.com/pricing');
    e = (await t.db.select().from(emails).where(eq(emails.id, ids.email)))[0]!;
    expect(e.clickCount).toBe(1);
    const gone = await t.request(`/t/c/${click}x`, { token: null, redirect: 'manual' });
    expect(gone.status).toBe(410);

    const page = await t.request(`/u/${unsub}`, { token: null });
    expect(page.status).toBe(200);
    expect(page.text).toContain("You're unsubscribed");
    const oneClick = await t.request(`/u/${unsub}`, { token: null, method: 'POST' });
    expect(oneClick.status).toBe(200);
    const prospect = await t.request(`/v1/prospects/${ids.prospect}`);
    expect(prospect.status).toBe(200);
    const blocked = await t.request('/v1/emails', { method: 'POST', json: { data: { prospectId: ids.prospect, ownerId: t.ownerId, subject: 's', bodyHtml: 'b', send: true } } });
    expect(blocked.status).toBe(422);
    const got = await t.request(`/v1/emails/${ids.email}`);
    expect(got.json.data).toMatchObject({ status: 'sent', openCount: 2, clickCount: 1 });
    expect(got.json.data.subject).toBe('Hello Ada');
  });
});

describe('calls (read-only, empty until the dialer phase)', () => {
  it('lists and 404s correctly', async () => {
    const calls = await t.request('/v1/calls?include=prospect,owner');
    expect(calls.json).toEqual({ data: [], links: { first: '/v1/calls?include=prospect%2Cowner', prev: null, next: null } });
    const disp = await t.request('/v1/callDispositions');
    expect(disp.json.data).toEqual([]);
    const nf = await t.request('/v1/calls/not-a-uuid');
    expect(nf.status).toBe(404);
    const badDate = await t.request('/v1/calls?filter[time][gte]=yesterday');
    expect(badDate.status).toBe(400);
  });
});
