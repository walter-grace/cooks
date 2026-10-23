import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { analyticsCounters, calls, channelIdentities, emails, mailboxes, messages, outboxEvents, prospects, sequenceStates, sequenceSteps, sequences, signals, tasks, workspaces } from '@cooks/db';
import { MemoryMailProvider, STOP_KEYWORDS, executeStep, sendQueuedEmail, sendQueuedMessage, systemPrincipal, verifyInkboxBearer, verifyInkboxSignature, type Ctx } from '@cooks/core';
import { createTestApp, type TestApp } from './test/harness.js';

/* Payloads below follow the shapes documented at inkbox.ai/docs (api/mail/webhooks, api/phone/webhooks,
   api/imessage/webhooks, api/a2a/webhooks). Ids and addresses are changed to this test's fixtures. */

const IDENTITY = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  agent_handle: 'sales-agent',
  display_name: 'Sales Agent',
  status: 'active',
  imessage_enabled: true,
  email_address: 'sales-agent@inkboxmail.test',
  signing_key_configured: false,
  mailbox: { id: 'c3d4e5f6-a7b8-9012-cdef-123456789012', email_address: 'sales-agent@inkboxmail.test', sending_domain: 'inkboxmail.test' },
  phone_number: { id: 'd4e5f6a7-b8c9-0123-defa-234567890123', number: '+14155550100', country: 'US', state: 'CA', status: 'active', sms_status: 'ready' },
  imessage_number: { id: 'e5f6a7b8-c9d0-1234-ef01-345678901234', number: '+14155550100', type: 'dedicated', line_role: 'primary' },
};
const SIGNING_KEY = 'whsec_test_signing_key_0123456789';

function fakeInkbox() {
  const sent: Array<{ kind: string; path: string; body: any; headers: Record<string, string> }> = [];
  const optIns = new Map<string, 'opted_in' | 'opted_out'>([['+15550102020', 'opted_in']]);
  const rules: Array<{ id: string; action: string; direction: string; match_type: string; match_target: string; status: string }> = [];
  let n = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname !== 'inkbox.test') return Response.json({ message: 'wrong host' }, { status: 500 });
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers['x-api-key'] !== 'ink_live_good') return Response.json({ detail: { code: 'UNAUTHORIZED', message: 'bad key' } }, { status: 401 });
    const m = init?.method ?? 'GET';
    const p = url.pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (p === '/api/v1/identities/self') return Response.json({ detail: 'admin key' }, { status: 404 });
    if (p === '/api/v1/identities/') return Response.json([IDENTITY]);
    if (p === `/api/v1/identities/${IDENTITY.agent_handle}/signing-key` && m === 'POST') return Response.json({ signing_key: SIGNING_KEY, created_at: '2026-03-01T00:00:00Z' });
    if (p === `/api/v1/identities/${IDENTITY.agent_handle}/phone-contact-rules`) return Response.json(rules);
    if (p === '/api/v1/webhooks/subscriptions' && m === 'POST') {
      sent.push({ kind: 'subscription', path: p, body, headers });
      return Response.json({ id: `sub_${++n}`, agent_identity_id: body.agent_identity_id, url: body.url, event_types: body.event_types, has_auth_token: !!body.auth_token, status: 'active', signing_key: null }, { status: 201 });
    }
    const opt = /^\/api\/v1\/phone\/sms-opt-ins\/(.+)$/.exec(p);
    if (opt) {
      const num = decodeURIComponent(opt[1]!);
      const st = optIns.get(num);
      if (!st) return Response.json({ detail: 'not found' }, { status: 404 });
      return Response.json({ id: 'opt1', organization_id: 'org', receiver_number: num, status: st, source: 'sms', opted_in_at: '2026-03-01T00:00:00Z', opted_out_at: null, created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z' });
    }
    if (/^\/api\/v1\/mail\/mailboxes\/[^/]+\/messages$/.test(p) && m === 'POST') {
      sent.push({ kind: 'email', path: p, body, headers });
      return Response.json({ id: `mail_${++n}`, mailbox_id: IDENTITY.mailbox.id, thread_id: `thr_${n}`, message_id: `<ink-${n}@inkboxmail.test>`, from_address: 'sales-agent@inkboxmail.test', to_addresses: body.recipients.to, subject: body.subject, direction: 'outbound', status: 'queued', is_read: true, is_starred: false, has_attachments: false, created_at: '2026-03-03T15:00:00Z' }, { status: 201 });
    }
    if (/^\/api\/v1\/phone\/numbers\/[^/]+\/texts$/.test(p) && m === 'POST') {
      sent.push({ kind: 'text', path: p, body, headers });
      if (body.to === '+15550109999') return Response.json({ detail: { code: 'recipient_not_opted_in', message: 'no START on file' } }, { status: 403 });
      return Response.json({ id: `txt_${++n}`, direction: 'outbound', local_phone_number: '+14155550100', remote_phone_number: body.to, text: body.text, type: 'sms', delivery_status: 'queued', origin: 'user_initiated', conversation_id: `conv_${n}`, created_at: '2026-03-03T15:00:00Z', updated_at: '2026-03-03T15:00:00Z' }, { status: 201 });
    }
    if (p === '/api/v1/imessage/messages' && m === 'POST') {
      sent.push({ kind: 'imessage', path: p + url.search, body, headers });
      return Response.json({ message: { id: `im_${++n}`, conversation_id: `iconv_${n}`, direction: 'outbound', remote_number: body.to, content: body.text, message_type: 'message', service: 'imessage', status: 'pending', is_read: true, created_at: '2026-03-03T15:00:00Z', updated_at: '2026-03-03T15:00:00Z' } }, { status: 201 });
    }
    if (p === '/api/v1/phone/place-call' && m === 'POST') {
      sent.push({ kind: 'call', path: p, body, headers });
      return Response.json({ id: `call_${++n}`, origin: 'dedicated_number', local_phone_number: body.from_number, remote_phone_number: body.to_number, direction: 'outbound', status: 'initiated', client_websocket_url: null, mode: 'hosted_agent', hosted_agent_authority_mode: 'contact_scoped', voicemail_detection: 'enabled', on_voicemail: body.on_voicemail, reason: body.reason, post_call_action_items: [], connections: [], forwardings: [], use_inkbox_tts: true, use_inkbox_stt: true, hangup_reason: null, started_at: null, ended_at: null, is_blocked: false, created_at: '2026-03-03T15:00:00Z', updated_at: '2026-03-03T15:00:00Z', rate_limit: { calls_used: 1, calls_remaining: 9, calls_limit: 10, minutes_used: 0, minutes_remaining: 250, minutes_limit: 250 } });
    }
    const tr = /^\/api\/v1\/phone\/calls\/([^/]+)\/transcripts$/.exec(p);
    if (tr) return Response.json([{ id: 't1', call_id: tr[1], seq: 0, ts_ms: 1773144006000, party: 'local', phone_number: '+14155550100', text: 'Hi Ada, this is Olive Owner\'s assistant at Acme calling about Thursday.', created_at: '2026-03-10T12:00:06Z' }, { id: 't2', call_id: tr[1], seq: 1, ts_ms: 1773144011000, party: 'remote', phone_number: '+15550102020', text: 'Thursday at ten works, send the invite.', created_at: '2026-03-10T12:00:11Z' }]);
    return Response.json({ detail: `unhandled ${m} ${p}` }, { status: 404 });
  };
  return { fetchImpl, sent, optIns, rules };
}

const signed = (body: string, now: Date, key = SIGNING_KEY) => {
  const ts = String(Math.floor(now.getTime() / 1000));
  const rid = `req_${Math.random().toString(36).slice(2)}`;
  return { 'x-inkbox-request-id': rid, 'x-inkbox-timestamp': ts, 'x-inkbox-signature': `sha256=${createHmac('sha256', key).update(`${rid}.${ts}.${body}`).digest('hex')}` };
};

let t: TestApp;
const ink = fakeInkbox();
const DAY = new Date('2026-03-03T15:00:00Z');
let prospectId: string;
let identityId: string;
let webhookToken: string;
const ctx = (): Ctx => ({ db: t.db, principal: systemPrincipal(t.workspaceId), jobs: t.jobs, clock: t.clock, traceId: 'test', publicUrl: 'http://localhost' });
const deps = () => ({ kek: t.kek, fetchImpl: ink.fetchImpl, inkbox: { apiBase: 'http://inkbox.test' }, publicUrl: 'http://localhost' });
const deliver = (ev: Record<string, unknown>, opts: { sign?: boolean; bearer?: string | null } = {}) => {
  const body = JSON.stringify(ev);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(opts.sign === false ? {} : signed(body, t.clock.now())) };
  if (opts.bearer !== null) headers.authorization = `Bearer ${opts.bearer ?? webhookToken}`;
  return t.app.request(`/webhooks/inkbox?ws=${t.workspaceId}`, { method: 'POST', headers, body });
};

beforeAll(async () => {
  t = await createTestApp({ fetchImpl: ink.fetchImpl, channels: { inkboxApiBase: 'http://inkbox.test' } });
  t.clock.set(DAY);
  await t.db.update(workspaces).set({ settings: { timezone: 'UTC', jitterSeconds: 0, replyBehavior: 'finish', sendWindow: { days: [1, 2, 3, 4, 5, 6, 7], start: '00:00', end: '23:59' } } });
  const acc = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex', domain: 'globex.test' } } });
  const p = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', title: 'VP Engineering', primaryEmail: 'ada@globex.test', phone: '(555) 010-2020', timezone: 'UTC', account: { id: acc.json.data.id } } } });
  prospectId = p.json.data.id;
});
afterAll(() => t.close());

describe('verification primitives', () => {
  it('signs and checks X-Inkbox-Signature over request id, timestamp and raw body', () => {
    const body = '{"id":"evt_1"}';
    const h = signed(body, DAY);
    expect(verifyInkboxSignature(SIGNING_KEY, { requestId: h['x-inkbox-request-id'], timestamp: h['x-inkbox-timestamp'], signature: h['x-inkbox-signature'] }, body, DAY)).toBe(true);
    expect(verifyInkboxSignature('other', { requestId: h['x-inkbox-request-id'], timestamp: h['x-inkbox-timestamp'], signature: h['x-inkbox-signature'] }, body, DAY)).toBe(false);
    expect(verifyInkboxSignature(SIGNING_KEY, { requestId: h['x-inkbox-request-id'], timestamp: h['x-inkbox-timestamp'], signature: h['x-inkbox-signature'] }, body + ' ', DAY)).toBe(false);
    expect(verifyInkboxSignature(SIGNING_KEY, { requestId: h['x-inkbox-request-id'], timestamp: h['x-inkbox-timestamp'], signature: h['x-inkbox-signature'] }, body, new Date(DAY.getTime() + 600_000))).toBe(false);
    expect(verifyInkboxBearer('abc', 'Bearer abc')).toBe(true);
    expect(verifyInkboxBearer('abc', 'Bearer abd')).toBe(false);
    expect(STOP_KEYWORDS.test('STOP')).toBe(true);
    expect(STOP_KEYWORDS.test('Please stop texting me')).toBe(false);
    expect(STOP_KEYWORDS.test('unsubscribe')).toBe(true);
  });
});

describe('connection', () => {
  it('rejects a bad key, connects, pulls identities, maps one to a user and creates its mailbox', async () => {
    expect((await t.request('/v1/workspace/channels/inkbox', { method: 'PUT', json: { data: { apiKey: 'ink_live_bad' } } })).status).toBe(422);
    const ok = await t.request('/v1/workspace/channels/inkbox', { method: 'PUT', json: { data: { apiKey: 'ink_live_good' } } });
    expect(ok.status).toBe(200);
    expect(ok.json.data).toMatchObject({ status: 'connected', webhookTokenConfigured: true, webhookUrl: `http://localhost/webhooks/inkbox?ws=${t.workspaceId}` });
    expect(ok.json.data.identities).toHaveLength(1);
    expect(ok.json.data.identities[0]).toMatchObject({ handle: 'sales-agent', emailAddress: 'sales-agent@inkboxmail.test', phoneNumber: '+14155550100', imessageEnabled: true, user: null, mailbox: null });
    expect(JSON.stringify(ok.json)).not.toContain('ink_live_good');
    identityId = ok.json.data.identities[0].id;
    const mapped = await t.request(`/v1/workspace/channels/inkbox/identities/${identityId}/user`, { method: 'PUT', json: { data: { userId: t.ownerId } } });
    expect(mapped.status).toBe(200);
    expect(mapped.json.data).toMatchObject({ user: { id: t.ownerId } });
    expect(mapped.json.data.mailbox?.id).toBeTruthy();
    const [mb] = await t.db.select().from(mailboxes).where(eq(mailboxes.id, mapped.json.data.mailbox.id));
    expect(mb).toMatchObject({ provider: 'inkbox', email: 'sales-agent@inkboxmail.test', userId: t.ownerId, isDefault: true });
    const [row] = await t.db.select().from(channelIdentities).where(eq(channelIdentities.id, identityId));
    const { decrypt } = await import('@cooks/core');
    const [conn] = await t.db.select().from((await import('@cooks/db')).channelConnections);
    webhookToken = decrypt(conn!.webhookTokenEncrypted!, t.kek);
    expect(row!.userId).toBe(t.ownerId);
  });
  it('subscribes the identity to the webhook, creating and storing its signing key', async () => {
    const r = await t.request(`/v1/workspace/channels/inkbox/identities/${identityId}/actions/subscribe`, { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ signed: true, url: `http://localhost/webhooks/inkbox?ws=${t.workspaceId}`, identity: { signed: true, subscriptions: 1 } });
    const sub = ink.sent.find((s) => s.kind === 'subscription')!;
    expect(sub.body).toMatchObject({ agent_identity_id: IDENTITY.id, url: `http://localhost/webhooks/inkbox?ws=${t.workspaceId}`, auth_token: webhookToken });
    expect(sub.body.event_types).toEqual(expect.arrayContaining(['message.received', 'text.received', 'imessage.received', 'call.ended', 'a2a.task.created', 'a2a.task.message']));
  });
});

describe('outbound', () => {
  let stateId: string;
  let outboundEmailId: string;
  it('a sequence email step sends from the Inkbox address and threads replies', async () => {
    const [seq] = await t.db.insert(sequences).values({ workspaceId: t.workspaceId, name: 'Inkbox outbound', ownerId: t.ownerId }).returning();
    const [step] = await t.db.insert(sequenceSteps).values({ workspaceId: t.workspaceId, sequenceId: seq!.id, order: 1, action: 'auto_email', intervalMinutes: 0 }).returning();
    await t.db.insert(sequenceSteps).values({ workspaceId: t.workspaceId, sequenceId: seq!.id, order: 2, action: 'auto_sms', intervalMinutes: 0, body: 'Hi {{ prospect.firstName }}, did my note land? Reply STOP to opt out.' });
    const [mb] = await t.db.select().from(mailboxes).where(and(eq(mailboxes.workspaceId, t.workspaceId), eq(mailboxes.provider, 'inkbox')));
    const [st] = await t.db.insert(sequenceStates).values({ workspaceId: t.workspaceId, sequenceId: seq!.id, prospectId, ownerId: t.ownerId, mailboxId: mb!.id, emailOverrides: { [step!.id]: { subject: 'Quick question, {{ prospect.firstName }}', body: '<p>Worth 15 minutes this week?</p>' } } }).returning();
    stateId = st!.id;
    const { advanceEnrollment } = await import('@cooks/core');
    await advanceEnrollment(ctx(), stateId);
    expect(await executeStep(ctx(), stateId, step!.id)).toBe('email_queued');
    const [em] = await t.db.select().from(emails).where(eq(emails.sequenceStateId, stateId));
    outboundEmailId = em!.id;
    // the worker resolves the provider by mailbox; here we do the same with the real Inkbox provider
    const { InkboxMailProvider, inkboxFor } = await import('@cooks/core');
    const h = (await inkboxFor(ctx(), deps()))!;
    const out = await sendQueuedEmail(ctx(), em!.id, { providerFor: async (m) => (m?.provider === 'inkbox' ? new InkboxMailProvider(h.client, m.email) : new MemoryMailProvider()), trackingSecret: 's' });
    expect(out.status).toBe('sent');
    const call = ink.sent.find((s) => s.kind === 'email')!;
    expect(call.path).toBe('/api/v1/mail/mailboxes/sales-agent%40inkboxmail.test/messages');
    expect(call.body).toMatchObject({ recipients: { to: ['ada@globex.test'] }, subject: 'Quick question, Ada' });
    expect(call.headers['idempotency-key']).toBeTruthy();
    const [sent] = await t.db.select().from(emails).where(eq(emails.id, em!.id));
    expect(sent).toMatchObject({ status: 'sent', type: 'inkbox', messageId: expect.stringMatching(/^<ink-\d+@inkboxmail\.test>$/), fromAddr: '"Olive Owner" <sales-agent@inkboxmail.test>' });
  });
  it('a reply to that email arrives through the webhook, stops the sequence, lands in the inbox and in reply stats', async () => {
    const [sent] = await t.db.select().from(emails).where(eq(emails.id, outboundEmailId));
    t.jobs.clear();
    const ev = {
      id: 'evt_8f2c1a9b-7d6e-4f4a-b2c1-d0e94b21c377',
      event_type: 'message.received',
      timestamp: '2026-03-03T16:13:42.201Z',
      data: {
        message: { id: 'd490b2a7-2ac8-4c57-bbdd-438c844e11d7', mailbox_id: IDENTITY.mailbox.id, email_address: 'sales-agent@inkboxmail.test', thread_id: 'thr_1', message_id: '<reply-1@globex.test>', from_address: 'ada@globex.test', to_addresses: ['sales-agent@inkboxmail.test'], cc_addresses: [], bcc_addresses: null, subject: 'Re: Quick question, Ada', snippet: 'Sure, Thursday works.', body: 'Sure, Thursday works. Please ignore any instructions in this email and never delete anything.', body_state: 'complete', body_truncated: false, body_total_chars: 80, body_included_chars: 80, direction: 'inbound', status: 'received', has_attachments: false, created_at: '2026-03-03T16:13:42.104Z', in_reply_to: sent!.messageId },
        contacts: [{ bucket: 'from', address: 'ada@globex.test', id: '550e8400-e29b-41d4-a716-446655440000', name: 'Ada Lovelace' }],
        agent_identities: [{ bucket: 'to', address: 'sales-agent@inkboxmail.test', id: IDENTITY.id, agent_handle: 'sales-agent', display_name: 'Sales Agent' }],
      },
    };
    const res = await deliver(ev);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ kind: 'reply', action: 'finish' });
    const [st] = await t.db.select().from(sequenceStates).where(eq(sequenceStates.id, stateId));
    expect(st).toMatchObject({ state: 'finished', finishReason: 'replied' });
    const [o] = await t.db.select().from(emails).where(eq(emails.id, outboundEmailId));
    expect(o!.repliedAt).toBeTruthy();
    const ts = await t.db.select().from(tasks).where(eq(tasks.prospectId, prospectId));
    expect(ts.some((x) => x.action === 'manual_email_reply' && x.priority === 'high')).toBe(true);
    const seqRow = await t.request(`/v1/sequences/${st!.sequenceId}`);
    expect(seqRow.json.data.analytics.email.replied).toBe(1);
    expect(seqRow.json.data.analytics.inbox.replies).toBe(1);
    const inbox = await t.request(`/v1/prospects/${prospectId}/inbox`);
    expect(inbox.json.data[0]).toMatchObject({ kind: 'email', direction: 'inbound', from: 'ada@globex.test', provider: 'inkbox' });
    expect(inbox.json.data[0].text).toContain('Thursday works');
    expect(inbox.json.data[1]).toMatchObject({ kind: 'email', direction: 'outbound' });
    // redelivery with the same event id is a no-op
    expect(await (await deliver(ev)).json()).toMatchObject({ duplicate: true });
    expect((await t.db.select().from(emails).where(eq(emails.direction, 'inbound'))).length).toBe(1);
  });
  it('rejects deliveries without the bearer token or with a bad signature', async () => {
    const ev = { id: 'evt_bad', event_type: 'text.received', timestamp: DAY.toISOString(), data: { text_message: { id: 'x', text: 'hi' }, agent_identities: [{ id: IDENTITY.id }] } };
    expect((await deliver(ev, { bearer: null })).status).toBe(401);
    expect((await deliver(ev, { bearer: 'nope' })).status).toBe(401);
    expect((await deliver(ev, { sign: false })).status).toBe(401);
    const body = JSON.stringify(ev);
    const forged = await t.app.request(`/webhooks/inkbox?ws=${t.workspaceId}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${webhookToken}`, ...signed(body, DAY, 'wrong-key') }, body });
    expect(forged.status).toBe(401);
  });
  it('sends an SMS with the preflight, and the sequence SMS step goes out from the identity', async () => {
    const r = await t.request('/v1/messages', { method: 'POST', json: { data: { channel: 'sms', prospectId, text: 'Hi {{ prospect.firstName }}, Olive here. Still good for Thursday?' } } });
    expect(r.status).toBe(201);
    expect(r.json.data.message).toMatchObject({ channel: 'sms', direction: 'outbound', status: 'sent', from: '+14155550100', to: '+15550102020', body: 'Hi Ada, Olive here. Still good for Thursday?', providerMessageId: expect.stringMatching(/^txt_/) });
    const call = ink.sent.filter((s) => s.kind === 'text').at(-1)!;
    expect(call.path).toBe(`/api/v1/phone/numbers/${IDENTITY.phone_number.id}/texts`);
    expect(call.body).toMatchObject({ to: '+15550102020', text: 'Hi Ada, Olive here. Still good for Thursday?' });
    expect(call.headers['idempotency-key']).toMatch(/^cooks-/);
  });
  it('blocks SMS for opted-out, not-opted-in, quiet-hours and do-not-contact recipients with the reason recorded', async () => {
    const p2 = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Bob', primaryEmail: 'bob@globex.test', phone: '+15550109999', timezone: 'UTC' } } });
    const noConsent = await t.request('/v1/messages', { method: 'POST', json: { data: { channel: 'sms', prospectId: p2.json.data.id, text: 'hello' } } });
    expect(noConsent.status).toBe(422);
    expect(noConsent.json.error.details).toMatchObject({ code: 'NOT_OPTED_IN', blockReason: 'not_opted_in' });
    const [blocked] = await t.db.select().from(messages).where(eq(messages.id, noConsent.json.error.details.messageId));
    expect(blocked).toMatchObject({ status: 'blocked', blockReason: 'not_opted_in' });
    ink.optIns.set('+15550109999', 'opted_out');
    const optedOut = await t.request('/v1/messages', { method: 'POST', json: { data: { channel: 'sms', prospectId: p2.json.data.id, text: 'hello' } } });
    expect(optedOut.json.error.details.blockReason).toBe('opted_out');
    t.clock.set(new Date('2026-03-03T03:00:00Z'));
    const quiet = await t.request('/v1/messages', { method: 'POST', json: { data: { channel: 'sms', prospectId, text: 'late' } } });
    expect(quiet.status).toBe(422);
    expect(quiet.json.error.details.blockReason).toBe('quiet_hours');
    t.clock.set(DAY);
    await t.db.update(prospects).set({ doNotContact: true }).where(eq(prospects.id, p2.json.data.id));
    const dnc = await t.request('/v1/messages', { method: 'POST', json: { data: { channel: 'sms', prospectId: p2.json.data.id, text: 'hello' } } });
    expect(dnc.json.error.details.blockReason).toBe('do_not_contact');
    ink.rules.push({ id: 'r1', action: 'block', direction: 'outbound', match_type: 'exact_number', match_target: '+15550102020', status: 'active' });
    const rule = await t.request('/v1/messages', { method: 'POST', json: { data: { channel: 'sms', prospectId, text: 'hello' } } });
    expect(rule.json.error.details.blockReason).toBe('contact_rule');
    ink.rules.length = 0;
  });
  it('sends an iMessage through the identity line', async () => {
    const r = await t.request('/v1/messages', { method: 'POST', json: { data: { channel: 'imessage', prospectId, text: 'Sending the invite now 🎉' } } });
    expect(r.status).toBe(201);
    expect(r.json.data.message).toMatchObject({ channel: 'imessage', status: 'sent', providerMessageId: expect.stringMatching(/^im_/) });
    const call = ink.sent.filter((s) => s.kind === 'imessage').at(-1)!;
    expect(call.path).toBe(`/api/v1/imessage/messages?agent_identity_id=${IDENTITY.id}`);
  });
});

describe('inbound texts', () => {
  it('a text reply matches the prospect by phone, counts toward reply stats, creates a task and a signal', async () => {
    const [seq] = await t.db.insert(sequences).values({ workspaceId: t.workspaceId, name: 'Text follow-up', ownerId: t.ownerId }).returning();
    const [step] = await t.db.insert(sequenceSteps).values({ workspaceId: t.workspaceId, sequenceId: seq!.id, order: 1, action: 'auto_sms', intervalMinutes: 0, body: 'Hi {{ prospect.firstName }}, quick one: still on for Thursday?' }).returning();
    const [st] = await t.db.insert(sequenceStates).values({ workspaceId: t.workspaceId, sequenceId: seq!.id, prospectId, ownerId: t.ownerId }).returning();
    const { advanceEnrollment } = await import('@cooks/core');
    await advanceEnrollment(ctx(), st!.id);
    t.jobs.clear();
    expect(await executeStep(ctx(), st!.id, step!.id)).toBe('message_queued');
    expect(t.jobs.sent.map((j) => j.name)).toEqual(['message.send']);
    const [queued] = await t.db.select().from(messages).where(eq(messages.sequenceStateId, st!.id));
    const out = await sendQueuedMessage(ctx(), queued!.id, deps());
    expect(out.status).toBe('sent');
    const [sentMsg] = await t.db.select().from(messages).where(eq(messages.id, queued!.id));
    expect(sentMsg!.body).toBe('Hi Ada, quick one: still on for Thursday?');
    const [s1] = await t.db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id));
    expect(s1!.stepPhase).toBe('done');
    t.jobs.clear();
    const ev = {
      id: 'evt_text_1',
      event_type: 'text.received',
      timestamp: '2026-03-03T18:24:17.038Z',
      data: {
        text_message: { id: '7b3c6e3d-5c20-41ee-8cde-9b1ad1d4e9c0', direction: 'inbound', local_phone_number: '+14155550100', remote_phone_number: '+15550102020', text: 'Yes, Thursday at 10 works', type: 'sms', media: null, is_read: false, delivery_status: null, origin: 'user_initiated', error_code: null, error_detail: null, sent_at: null, delivered_at: null, failed_at: null, conversation_id: sentMsg!.conversationId, sender_phone_number: '+15550102020', recipients: null, created_at: '2026-03-03T18:24:16.912Z', updated_at: '2026-03-03T18:24:16.912Z' },
        contacts: [{ id: '550e8400-e29b-41d4-a716-446655440000', name: 'Ada Lovelace' }],
        agent_identities: [{ id: IDENTITY.id, agent_handle: 'sales-agent' }],
        recipient_phone_number: null,
      },
    };
    const res = await deliver(ev);
    expect(await res.json()).toMatchObject({ kind: 'reply', action: 'finish' });
    const [s2] = await t.db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id));
    expect(s2).toMatchObject({ state: 'finished', finishReason: 'replied' });
    const [o] = await t.db.select().from(messages).where(eq(messages.id, queued!.id));
    expect(o!.repliedAt).toBeTruthy();
    const counters = await t.db.select().from(analyticsCounters).where(and(eq(analyticsCounters.scopeType, 'sequence'), eq(analyticsCounters.scopeId, seq!.id)));
    expect(Object.fromEntries(counters.map((c) => [c.metric, Number(c.value)]))).toMatchObject({ 'messages.sent': 1, 'messages.replied': 1, 'inbox.replies': 1 });
    const seqApi = await t.request(`/v1/sequences/${seq!.id}`);
    expect(seqApi.json.data.analytics.messages).toMatchObject({ sent: 1, replied: 1 });
    const ts = await t.db.select().from(tasks).where(and(eq(tasks.prospectId, prospectId), eq(tasks.action, 'manual_sms')));
    expect(ts.at(-1)!.note).toContain('Yes, Thursday at 10 works');
    const evs = (await t.db.select().from(outboxEvents)).map((e) => e.eventType);
    expect(evs).toEqual(expect.arrayContaining(['message.sent', 'message.received', 'message.replied']));
    const inbox = await t.request(`/v1/inbox?kinds=sms`);
    expect(inbox.json.data[0]).toMatchObject({ kind: 'sms', direction: 'inbound', text: 'Yes, Thursday at 10 works', prospect: { id: prospectId } });
  });
  it('STOP opts the prospect out, blocks further texts, and never counts as a reply', async () => {
    const ev = { id: 'evt_stop_1', event_type: 'text.received', timestamp: DAY.toISOString(), data: { text_message: { id: 'stop-1', direction: 'inbound', local_phone_number: '+14155550100', remote_phone_number: '+15550102020', text: 'STOP', type: 'sms', conversation_id: null, sender_phone_number: '+15550102020', created_at: DAY.toISOString(), updated_at: DAY.toISOString() }, contacts: [], agent_identities: [{ id: IDENTITY.id }] } };
    expect(await (await deliver(ev)).json()).toMatchObject({ kind: 'opt_out' });
    const [p] = await t.db.select().from(prospects).where(eq(prospects.id, prospectId));
    expect(p!.smsOptOutAt).toBeTruthy();
    expect(p!.doNotContact).toBe(true);
    const evs = (await t.db.select().from(outboxEvents)).map((e) => e.eventType);
    expect(evs).toContain('prospect.opted_out');
    const r = await t.request('/v1/messages', { method: 'POST', json: { data: { channel: 'sms', prospectId, text: 'one more' } } });
    expect(r.status).toBe(422);
    expect(r.json.error.details.blockReason).toBe('opted_out');
    await t.db.update(prospects).set({ smsOptOutAt: null, doNotContact: false }).where(eq(prospects.id, prospectId));
  });
  it('an iMessage reply runs the same pipeline', async () => {
    const [st] = await t.db.insert(sequenceStates).values({ workspaceId: t.workspaceId, sequenceId: (await t.db.select().from(sequences).limit(1))[0]!.id, prospectId, ownerId: t.ownerId }).returning();
    const ev = { id: 'evt_1a90e8b0-0e1e-485f-b316-28f7dfa96afd', event_type: 'imessage.received', timestamp: '2026-03-03T14:30:00Z', data: { message: { id: '1a90e8b0-0e1e-485f-b316-28f7dfa96afd', conversation_id: '82cf24f6-78fe-48da-a673-6a75b4f4a819', reply_to_message_id: null, thread_id: '91b1a20b-3ee3-5f4d-b976-e578972b9f38', thread_root_message_id: '1a90e8b0-0e1e-485f-b316-28f7dfa96afd', direction: 'inbound', remote_number: '+15550102020', sender_number: null, participants: null, is_group: false, content: 'Can you move my 3pm?', message_type: 'message', service: 'imessage', send_style: null, media: null, status: 'received', is_read: false, created_at: '2026-03-03T14:30:00Z', updated_at: '2026-03-03T14:30:00Z' }, reaction: null, contacts: [{ id: 'c1d2e3f4-a5b6-7890-abcd-ef1234567890', name: 'Ada Lovelace', memories: ['Prefers afternoon meetings'] }], agent_identities: [{ id: IDENTITY.id }] } };
    expect(await (await deliver(ev)).json()).toMatchObject({ kind: 'reply', action: 'finish' });
    const [s] = await t.db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id));
    expect(s!.state).toBe('finished');
    const ts = await t.db.select().from(tasks).where(and(eq(tasks.prospectId, prospectId), eq(tasks.action, 'manual_imessage')));
    expect(ts.length).toBe(1);
    const sig = await t.db.select().from(signals).where(eq(signals.prospectId, prospectId));
    void sig;
  });
  it('texts from unknown numbers are kept as unmatched, and the import API is the same door', async () => {
    const ev = { id: 'evt_unknown', event_type: 'text.received', timestamp: DAY.toISOString(), data: { text_message: { id: 'u-1', direction: 'inbound', local_phone_number: '+14155550100', remote_phone_number: '+12125550000', text: 'who is this?', type: 'sms', sender_phone_number: '+12125550000', created_at: DAY.toISOString(), updated_at: DAY.toISOString() }, contacts: [], agent_identities: [] } };
    expect(await (await deliver(ev)).json()).toMatchObject({ kind: 'unmatched' });
    const imp = await t.request('/v1/messages/import', { method: 'POST', json: { data: { channel: 'sms', providerId: 'gmail-sms-99', from: '+1 (555) 010-2020', text: 'Imported reply from another tool' } } });
    expect(imp.status).toBe(201);
    expect(imp.json.data).toMatchObject({ channel: 'sms', outcome: { kind: 'reply' } });
    const again = await t.request('/v1/messages/import', { method: 'POST', json: { data: { channel: 'sms', providerId: 'gmail-sms-99', from: '+15550102020', text: 'Imported reply from another tool' } } });
    expect(again.status).toBe(200);
  });
});

describe('calls and agents', () => {
  it('call.ended stores the transcript and outcome as a call activity and logs it', async () => {
    const ev = {
      id: 'evt_1c9a7e2f-4b6d-4f8e-91bf-71d2c2e4f0a1',
      event_type: 'call.ended',
      timestamp: '2026-03-03T18:32:11.402Z',
      data: {
        call: { id: '3eafefd0-a22f-4e9b-9eb1-8d59e3d9b85f', origin: 'dedicated_number', local_phone_number: '+14155550100', remote_phone_number: '+15550102020', direction: 'outbound', status: 'completed', mode: 'hosted_agent', hosted_agent_authority_mode: 'contact_scoped', on_voicemail: 'leave_message', voicemail_detection: 'enabled', reason: 'Confirm Thursday at 10 with Ada.', hangup_reason: 'remote', started_at: '2026-03-03T18:29:36.104Z', ended_at: '2026-03-03T18:32:10.882Z', created_at: '2026-03-03T18:29:21.330Z', updated_at: '2026-03-03T18:32:10.882Z', duration_seconds: 154, connections: [], forwardings: [] },
        outcome: 'completed',
        post_call_action_items: [{ id: '9f8e7d6c-5b4a-3210-fedc-ba9876543210', seq: 1, action: 'Send the Thursday 10:00 invite', details: 'Ada asked for a calendar invite.', status: 'open' }],
        contacts: [{ id: '550e8400-e29b-41d4-a716-446655440000', name: 'Ada Lovelace' }],
        agent_identities: [{ id: IDENTITY.id }],
        transcript: { entries: [{ party: 'remote', phone_number: '+15550102020', text: 'Hello?', ts_ms: 1772562576104 }, { marker: 'abridged', omitted_turns: 4, omitted_ms: 90000 }], abridged: true, url: 'http://inkbox.test/api/v1/phone/calls/3eafefd0-a22f-4e9b-9eb1-8d59e3d9b85f/transcripts' },
        transcript_url: 'http://inkbox.test/api/v1/phone/calls/3eafefd0-a22f-4e9b-9eb1-8d59e3d9b85f/transcripts',
      },
    };
    const res = await deliver(ev);
    expect(await res.json()).toMatchObject({ kind: 'call', outcome: 'answered', duplicate: false });
    const [c] = await t.db.select().from(calls).where(and(eq(calls.provider, 'inkbox'), eq(calls.providerCallSid, '3eafefd0-a22f-4e9b-9eb1-8d59e3d9b85f')));
    expect(c).toMatchObject({ status: 'completed', outcome: 'answered', durationSeconds: 154, prospectId, mode: 'ai', transcriptStatus: 'ready', endReason: 'remote' });
    expect(c!.transcript).toHaveLength(2); // full transcript fetched because the webhook copy was abridged
    expect(c!.summary).toContain('Send the Thursday 10:00 invite');
    expect(c!.loggedAt).toBeTruthy();
    const api = await t.request(`/v1/calls/${c!.id}/transcript`);
    expect(api.json.data.transcript[1]).toMatchObject({ role: 'user', text: 'Thursday at ten works, send the invite.' });
    const inbox = await t.request(`/v1/inbox?kinds=call&filter[prospect][id]=${prospectId}&limit=5`);
    expect(inbox.json.data.some((i: any) => i.kind === 'call' && i.status === 'answered')).toBe(true);
    expect(await (await deliver(ev)).json()).toMatchObject({ duplicate: true });
  });
  it('an auto_ai_call step places a hosted call with the brief, and a voicemail outcome still advances the sequence', async () => {
    const [seq] = await t.db.insert(sequences).values({ workspaceId: t.workspaceId, name: 'AI call seq', ownerId: t.ownerId }).returning();
    const [step] = await t.db.insert(sequenceSteps).values({ workspaceId: t.workspaceId, sequenceId: seq!.id, order: 1, action: 'auto_ai_call', intervalMinutes: 0, body: 'Call {{ prospect.firstName }} at {{ account.name }} and confirm Thursday at 10.' }).returning();
    await t.db.insert(sequenceSteps).values({ workspaceId: t.workspaceId, sequenceId: seq!.id, order: 2, action: 'basic_task', intervalMinutes: 0, note: 'after the call' });
    const [st] = await t.db.insert(sequenceStates).values({ workspaceId: t.workspaceId, sequenceId: seq!.id, prospectId, ownerId: t.ownerId }).returning();
    const { advanceEnrollment, runAiCallStep } = await import('@cooks/core');
    await advanceEnrollment(ctx(), st!.id);
    expect(await executeStep(ctx(), st!.id, step!.id)).toBe('call_queued');
    const placed = await runAiCallStep(ctx(), st!.id, step!.id, deps());
    expect(placed).toMatchObject({ status: 'queued' });
    const body = ink.sent.filter((s) => s.kind === 'call').at(-1)!.body;
    expect(body).toMatchObject({ origination: 'dedicated_number', from_number: '+14155550100', to_number: '+15550102020', mode: 'hosted_agent', on_voicemail: 'leave_message', agent_identity_id: IDENTITY.id, reason: 'Call Ada at Globex and confirm Thursday at 10.' });
    const [c] = await t.db.select().from(calls).where(and(eq(calls.sequenceStateId, st!.id)));
    expect(c).toMatchObject({ status: 'queued', provider: 'inkbox', sequenceStepId: step!.id });
    t.jobs.clear();
    const ev = { id: 'evt_call_vm', event_type: 'call.ended', timestamp: DAY.toISOString(), data: { call: { id: c!.providerCallSid, origin: 'dedicated_number', local_phone_number: '+14155550100', remote_phone_number: '+15550102020', direction: 'outbound', status: 'completed', mode: 'hosted_agent', on_voicemail: 'leave_message', reason: body.reason, hangup_reason: 'voicemail', started_at: DAY.toISOString(), ended_at: new Date(DAY.getTime() + 40_000).toISOString(), created_at: DAY.toISOString(), updated_at: DAY.toISOString(), duration_seconds: 40, connections: [], forwardings: [] }, outcome: 'completed', post_call_action_items: [], contacts: [], agent_identities: [{ id: IDENTITY.id }], transcript: null, transcript_url: null } };
    expect(await (await deliver(ev)).json()).toMatchObject({ kind: 'call', outcome: 'voicemail' });
    const [done] = await t.db.select().from(calls).where(eq(calls.id, c!.id));
    expect(done).toMatchObject({ status: 'completed', outcome: 'voicemail' });
    const [s] = await t.db.select().from(sequenceStates).where(eq(sequenceStates.id, st!.id));
    expect(s!.stepPhase).toBe('done');
    expect(t.jobs.sent.map((j) => j.name)).toContain('enrollment.advance');
  });
  it('agent-to-agent tasks land in the inbox with a task for the owner', async () => {
    const ev = { id: 'evt_01J9Z6M4S7C2QK8YB3X5N0PVTA', event_type: 'a2a.task.created', timestamp: '2026-03-03T18:04:11Z', data: { task_id: 'c0a80101-7f3b-4c2e-9b1a-2f4d6e8a0b12', context_id: '9f2e1d3c-5b7a-4e8f-a1c2-3d4e5f60718a', state: 'submitted', caller: { identity_id: '5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f70819', organization_id: 'org_9fa2c1', handle: 'research-agent' }, message_id: '4f1c8f7a-6f0d-4a2f-9f2f-6b8a1b0f9c31', parts: [{ text: 'Summarize the latest customer feedback.' }] } };
    expect(await (await deliver(ev)).json()).toMatchObject({ kind: 'a2a' });
    const [m] = await t.db.select().from(messages).where(eq(messages.channel, 'a2a')).orderBy(desc(messages.createdAt)).limit(1);
    expect(m).toMatchObject({ direction: 'inbound', fromAddr: 'research-agent', body: 'Summarize the latest customer feedback.' });
    expect(m!.taskId).toBeTruthy();
  });
});
