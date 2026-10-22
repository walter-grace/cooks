import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { emailEvents, emails, sequenceStates, sequenceSteps, sequences, tasks, workspaces } from '@cooks/db';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
const ids = { prospect: '', seq: '', state: '', outbound: '' };

beforeAll(async () => {
  t = await createTestApp();
  await t.db.update(workspaces).set({ settings: { timezone: 'UTC', jitterSeconds: 0, replyBehavior: 'finish', sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } } });
  const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', primaryEmail: 'ada@globex.test' } } });
  ids.prospect = p.json.data.id;
  const [seq] = await t.db.insert(sequences).values({ workspaceId: t.workspaceId, name: 'Outbound Q4', ownerId: t.ownerId }).returning();
  ids.seq = seq!.id;
  await t.db.insert(sequenceSteps).values({ workspaceId: t.workspaceId, sequenceId: ids.seq, order: 1, action: 'call', intervalMinutes: 0 });
  const [st] = await t.db.insert(sequenceStates).values({ workspaceId: t.workspaceId, sequenceId: ids.seq, prospectId: ids.prospect, ownerId: t.ownerId }).returning();
  ids.state = st!.id;
});
afterAll(() => t.close());

describe('POST /v1/emails/import', () => {
  it('records an outbound email sent elsewhere, linked to the active enrollment, idempotent on messageId', async () => {
    const r = await t.request('/v1/emails/import', {
      method: 'POST',
      json: { data: { prospectId: ids.prospect, direction: 'outbound', subject: 'Quick question', bodyHtml: '<p>Hi Ada, worth 15 minutes?</p>', messageId: 'CAFx123@mail.gmail.com', threadId: 'thr-1', sentAt: '2026-10-20T14:00:00Z', provider: 'gmail' } },
    });
    expect(r.status).toBe(201);
    expect(r.json.meta).toEqual({ created: true, outcome: { kind: 'outbound' } });
    expect(r.json.data).toMatchObject({ status: 'sent', direction: 'outbound', type: 'gmail', to: 'ada@globex.test', messageId: '<CAFx123@mail.gmail.com>', threadId: 'thr-1', bodyText: 'Hi Ada, worth 15 minutes?', sequence: { id: ids.seq } });
    expect(r.json.data.date).toBe('2026-10-20T14:00:00.000Z');
    ids.outbound = r.json.data.id;
    const again = await t.request('/v1/emails/import', { method: 'POST', json: { data: { prospectId: ids.prospect, direction: 'outbound', subject: 'Quick question', messageId: '<CAFx123@mail.gmail.com>' } } });
    expect(again.status).toBe(200);
    expect(again.json.meta.created).toBe(false);
    expect(again.json.data.id).toBe(ids.outbound);
  });

  it('an inbound reply runs the reply pipeline: matches the thread, finishes the enrollment, opens a task, counts the reply', async () => {
    t.jobs.clear();
    const r = await t.request('/v1/emails/import', {
      method: 'POST',
      json: { data: { prospectId: ids.prospect, direction: 'inbound', subject: 'Re: Quick question', bodyText: 'Sure, Thursday works.', messageId: 'reply-1@globex.test', inReplyTo: 'CAFx123@mail.gmail.com', sentAt: '2026-10-21T09:30:00Z', provider: 'gmail' } },
    });
    expect(r.status).toBe(201);
    expect(r.json.meta).toEqual({ created: true, outcome: { kind: 'reply', action: 'finish', outboundId: ids.outbound } });
    expect(r.json.data).toMatchObject({ status: 'received', direction: 'inbound', from: 'ada@globex.test', inReplyTo: '<CAFx123@mail.gmail.com>', prospect: { id: ids.prospect } });

    const [out] = await t.db.select().from(emails).where(eq(emails.id, ids.outbound));
    expect(out!.repliedAt).toBeTruthy();
    const replied = await t.db.select().from(emailEvents).where(and(eq(emailEvents.emailId, ids.outbound), eq(emailEvents.kind, 'replied')));
    expect(replied).toHaveLength(1);
    const [st] = await t.db.select().from(sequenceStates).where(eq(sequenceStates.id, ids.state));
    expect(st).toMatchObject({ state: 'finished', finishReason: 'replied' });
    const ts = await t.db.select().from(tasks).where(eq(tasks.prospectId, ids.prospect));
    expect(ts.some((x) => x.action === 'manual_email_reply' && x.priority === 'high' && x.status === 'ready')).toBe(true);
    expect(t.jobs.sent.some((j) => j.name === 'ai.classify_reply')).toBe(true);

    const dup = await t.request('/v1/emails/import', { method: 'POST', json: { data: { prospectId: ids.prospect, direction: 'inbound', subject: 'Re: Quick question', bodyText: 'Sure, Thursday works.', messageId: 'reply-1@globex.test' } } });
    expect(dup.status).toBe(200);
    expect(dup.json.meta).toEqual({ created: false, outcome: { kind: 'duplicate' } });
    const list = await t.request(`/v1/emails?filter[prospect][id]=${ids.prospect}`);
    expect(list.json.data).toHaveLength(2);
  });

  it('out-of-office is detected from the subject and never finishes an enrollment', async () => {
    const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Grace', primaryEmail: 'grace@globex.test' } } });
    const [st] = await t.db.insert(sequenceStates).values({ workspaceId: t.workspaceId, sequenceId: ids.seq, prospectId: p.json.data.id, ownerId: t.ownerId }).returning();
    const r = await t.request('/v1/emails/import', { method: 'POST', json: { data: { prospectId: p.json.data.id, direction: 'inbound', subject: 'Automatic reply: Quick question', bodyText: 'I am out of the office until next week.' } } });
    expect(r.status).toBe(201);
    expect(r.json.meta.outcome.kind).toBe('auto_reply');
    const [s] = await t.db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id));
    expect(s!.state).not.toBe('finished');
  });

  it('validates input', async () => {
    const bad = await t.request('/v1/emails/import', { method: 'POST', json: { data: { prospectId: '00000000-0000-7000-8000-000000000000', direction: 'inbound', subject: 'x' } } });
    expect(bad.status).toBe(422);
    const noDir = await t.request('/v1/emails/import', { method: 'POST', json: { data: { prospectId: ids.prospect, subject: 'x' } } });
    expect(noDir.status).toBe(400);
    const badDate = await t.request('/v1/emails/import', { method: 'POST', json: { data: { prospectId: ids.prospect, direction: 'outbound', sentAt: 'yesterday' } } });
    expect(badDate.status).toBe(400);
  });

  it('appears in the OpenAPI document as a Cooks extension', async () => {
    const spec = await t.request('/openapi.json', { token: null });
    const op = spec.json.paths['/emails/import'].post;
    expect(op.operationId).toBe('importEmail');
    expect(op.tags).toContain('Cooks extensions');
  });
});
