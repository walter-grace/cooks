/**
 * Inbound through Inkbox: email, SMS, iMessage, finished calls and agent-to-agent tasks.
 * One `importInboundMessage()` entry point serves the webhook and the import API; it matches
 * the sender to a prospect, threads onto the enrollment and runs the reply pipeline.
 * Inbound content is data: it is stored and shown, never executed or followed.
 */
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { callTranscripts, calls, channelIdentities, emails, inboundEvents, messages, prospects, sequenceStates, stepExecutions, tasks } from '@cooks/db';
import type { Ctx } from '../context.js';
import { emitEvent } from '../events.js';
import { unprocessable } from '../errors.js';
import { applyReplyPolicy, processInbound, type InboundMailbox, type InboundOutcome } from '../mail/inbound.js';
import type { InboundMessage } from '../mail/provider.js';
import { bumpCounter } from '../services/analytics.js';
import { memberIds } from '../services/_shared.js';
import { logCall } from '../telephony/dialer.js';
import { transcriptStats } from '../telephony/ai-call.js';
import { normalizePhone } from '../telephony/twilio.js';
import { identityByAddress, inkboxFor, type ChannelDeps, type IdentityRow } from './connection.js';
import { STOP_KEYWORDS, type InkboxCall, type InkboxTranscriptEntry } from './inkbox.js';

export interface InboundChannelMessage {
  channel: 'sms' | 'imessage' | 'a2a';
  providerId: string;
  conversationId?: string | null;
  threadId?: string | null;
  inReplyTo?: string | null;
  /** Phone number (E.164) or agent handle. */
  from: string;
  to?: string | null;
  text: string;
  mediaUrls?: string[];
  date: Date;
  identityId?: string | null;
  provider?: string;
  raw?: Record<string, unknown>;
}

export type InboundChannelOutcome =
  | { kind: 'duplicate'; messageId: string | null }
  | { kind: 'opt_out'; messageId: string; prospectId: string | null }
  | { kind: 'reply'; messageId: string; prospectId: string; action: 'finish' | 'pause' | 'continue' | 'none'; taskId: string | null }
  | { kind: 'unmatched'; messageId: string }
  | { kind: 'a2a'; messageId: string; taskId: string | null };

const digits = (p: string) => p.replace(/\D/g, '');

/** Prospect whose phone matches (any formatting, with or without country code). */
export async function findProspectByPhone(ctx: Ctx, phone: string) {
  const d = digits(phone);
  if (d.length < 7) return null;
  const tail = d.slice(-10);
  const rows = await ctx.db
    .select()
    .from(prospects)
    .where(and(eq(prospects.workspaceId, ctx.principal.workspaceId), isNull(prospects.deletedAt), sql`regexp_replace(coalesce(${prospects.phone}, ''), '[^0-9]', '', 'g') like ${'%' + tail}`))
    .orderBy(desc(prospects.updatedAt))
    .limit(5);
  const norm = normalizePhone(phone);
  return rows.find((r) => normalizePhone(r.phone) === norm) ?? rows[0] ?? null;
}

export async function findProspectByEmail(ctx: Ctx, email: string) {
  const [p] = await ctx.db.select().from(prospects).where(and(eq(prospects.workspaceId, ctx.principal.workspaceId), isNull(prospects.deletedAt), sql`lower(${prospects.primaryEmail}) = ${email.toLowerCase()}`)).limit(1);
  return p ?? null;
}

async function ownerFor(ctx: Ctx, identity: IdentityRow | null, prospectOwner: string | null): Promise<string> {
  const members = await memberIds(ctx);
  return [identity?.userId, prospectOwner, ctx.principal.userId].find((id): id is string => !!id && members.includes(id)) ?? members[0]!;
}

/**
 * SMS / iMessage / A2A inbound. Idempotent on provider message id. STOP revokes consent and
 * marks the prospect opted out; any other text from a known prospect is a reply.
 */
export async function processInboundMessage(ctx: Ctx, msg: InboundChannelMessage, opts: { classify?: boolean } = {}): Promise<InboundChannelOutcome> {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const provider = msg.provider ?? 'inkbox';
  const [dup] = await ctx.db.select({ id: messages.id }).from(messages).where(and(eq(messages.workspaceId, ws), eq(messages.provider, provider), eq(messages.providerMessageId, msg.providerId))).limit(1);
  if (dup) return { kind: 'duplicate', messageId: dup.id };

  const [idRow] = msg.identityId ? await ctx.db.select().from(channelIdentities).where(and(eq(channelIdentities.workspaceId, ws), eq(channelIdentities.id, msg.identityId))).limit(1) : [];
  const ident: IdentityRow | null = idRow ?? null;
  const prospect = msg.channel === 'a2a' ? null : await findProspectByPhone(ctx, msg.from);
  const ownerId = await ownerFor(ctx, ident, prospect?.ownerId ?? null);

  // the outbound this answers: same conversation, else the latest outbound to this prospect on this channel
  const [outbound] = prospect
    ? await ctx.db
        .select()
        .from(messages)
        .where(and(eq(messages.workspaceId, ws), eq(messages.direction, 'outbound'), eq(messages.channel, msg.channel), eq(messages.prospectId, prospect.id), ...(msg.conversationId ? [or(eq(messages.conversationId, msg.conversationId), isNull(messages.conversationId))!] : [])))
        .orderBy(desc(messages.createdAt))
        .limit(1)
    : [];

  const [stored] = await ctx.db
    .insert(messages)
    .values({
      workspaceId: ws,
      prospectId: prospect?.id ?? null,
      accountId: prospect?.accountId ?? outbound?.accountId ?? null,
      ownerId,
      identityId: ident?.id ?? null,
      sequenceId: outbound?.sequenceId ?? null,
      sequenceStateId: outbound?.sequenceStateId ?? null,
      sequenceStepId: outbound?.sequenceStepId ?? null,
      channel: msg.channel,
      direction: 'inbound',
      status: 'received',
      fromAddr: msg.channel === 'a2a' ? msg.from : (normalizePhone(msg.from) ?? msg.from),
      toAddr: msg.to ?? ident?.phoneNumber ?? null,
      body: msg.text.slice(0, 20_000),
      mediaUrls: msg.mediaUrls ?? [],
      provider,
      providerMessageId: msg.providerId,
      conversationId: msg.conversationId ?? outbound?.conversationId ?? null,
      threadId: msg.threadId ?? null,
      inReplyTo: msg.inReplyTo ?? null,
      sentAt: msg.date,
      raw: msg.raw ?? null,
    })
    .returning();
  const messageId = stored!.id;
  await emitEvent(ctx.db, { workspaceId: ws, type: 'message.received', aggregateType: 'message', aggregateId: messageId, payload: { messageId, channel: msg.channel, prospectId: prospect?.id ?? null, from: stored!.fromAddr, textPreview: msg.text.slice(0, 160) }, dedupeKey: `${messageId}:received` });

  if (msg.channel === 'a2a') {
    // tasks need a prospect row; an agent request without one is still kept in the inbox
    const pid = prospect?.id ?? (await anyProspectForA2a(ctx));
    let taskId: string | null = null;
    if (pid) {
      const [task] = await ctx.db
        .insert(tasks)
        .values({ workspaceId: ws, prospectId: pid, ownerId, action: 'basic_task', status: 'ready', completed: false, priority: 'normal', dueAt: now, note: `Agent request from ${msg.from}: ${msg.text.slice(0, 400)}` })
        .returning({ id: tasks.id });
      taskId = task?.id ?? null;
      if (taskId) await ctx.db.update(messages).set({ taskId }).where(eq(messages.id, messageId));
    }
    return { kind: 'a2a', messageId, taskId };
  }

  // STOP: revoke SMS consent, mark the prospect, finish nothing else
  if (STOP_KEYWORDS.test(msg.text)) {
    if (prospect) {
      await ctx.db.update(prospects).set({ smsOptOutAt: now, doNotContact: true, updatedAt: now }).where(eq(prospects.id, prospect.id));
      await emitEvent(ctx.db, { workspaceId: ws, type: 'prospect.opted_out', aggregateType: 'prospect', aggregateId: prospect.id, payload: { prospectId: prospect.id, channel: msg.channel, from: stored!.fromAddr, messageId }, dedupeKey: `${prospect.id}:optout:${messageId}` });
    }
    await ctx.db.update(messages).set({ autoSubmitted: true }).where(eq(messages.id, messageId));
    return { kind: 'opt_out', messageId, prospectId: prospect?.id ?? null };
  }

  if (!prospect) return { kind: 'unmatched', messageId };

  // a real reply
  if (outbound && !outbound.repliedAt) {
    await ctx.db.update(messages).set({ repliedAt: now }).where(eq(messages.id, outbound.id));
    if (outbound.sequenceId) await bumpCounter(ctx.db, ws, 'sequence', outbound.sequenceId, 'messages.replied');
    if (outbound.sequenceStepId) await bumpCounter(ctx.db, ws, 'sequence_step', outbound.sequenceStepId, 'messages.replied');
  }
  await bumpInboxReplies(ctx, prospect.id, outbound?.sequenceId ?? null);
  await emitEvent(ctx.db, { workspaceId: ws, type: 'message.replied', aggregateType: 'message', aggregateId: outbound?.id ?? messageId, payload: { messageId: outbound?.id ?? null, inboundMessageId: messageId, channel: msg.channel, prospectId: prospect.id, from: stored!.fromAddr, textPreview: msg.text.slice(0, 160) }, dedupeKey: `${messageId}:replied` });
  const action = await applyReplyPolicy(ctx, ws, prospect.id, outbound?.sequenceStateId ?? null);
  const [task] = await ctx.db
    .insert(tasks)
    .values({
      workspaceId: ws,
      prospectId: prospect.id,
      accountId: prospect.accountId,
      ownerId,
      action: msg.channel === 'imessage' ? 'manual_imessage' : 'manual_sms',
      status: 'ready',
      completed: false,
      priority: 'high',
      dueAt: now,
      note: `${msg.channel === 'imessage' ? 'iMessage' : 'Text'} reply: ${msg.text.trim().slice(0, 280)}`,
      sequenceId: outbound?.sequenceId ?? null,
      sequenceStateId: outbound?.sequenceStateId ?? null,
      sequenceStepId: outbound?.sequenceStepId ?? null,
    })
    .returning({ id: tasks.id });
  await ctx.db.update(messages).set({ taskId: task!.id }).where(eq(messages.id, messageId));
  await emitEvent(ctx.db, { workspaceId: ws, type: 'task.created', aggregateType: 'task', aggregateId: task!.id, payload: { taskId: task!.id, reason: 'reply', inboundMessageId: messageId } });
  if (opts.classify) await ctx.jobs.send('ai.classify_reply', { inboundMessageId: messageId, taskId: task!.id, workspaceId: ws }, { singletonKey: `classify:msg:${messageId}` }).catch(() => undefined);
  return { kind: 'reply', messageId, prospectId: prospect.id, action, taskId: task!.id };
}

async function anyProspectForA2a(ctx: Ctx): Promise<string | null> {
  const [p] = await ctx.db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.workspaceId, ctx.principal.workspaceId), isNull(prospects.deletedAt))).orderBy(desc(prospects.updatedAt)).limit(1);
  return p?.id ?? null;
}

/** `inbox.replies`: every reply that arrived through Inkbox, counted on the sequence the prospect is answering. */
async function bumpInboxReplies(ctx: Ctx, prospectId: string, sequenceId: string | null) {
  const ws = ctx.principal.workspaceId;
  if (sequenceId) return bumpCounter(ctx.db, ws, 'sequence', sequenceId, 'inbox.replies');
  const [st] = await ctx.db.select({ sequenceId: sequenceStates.sequenceId }).from(sequenceStates).where(and(eq(sequenceStates.workspaceId, ws), eq(sequenceStates.prospectId, prospectId), isNull(sequenceStates.deletedAt))).orderBy(desc(sequenceStates.createdAt)).limit(1);
  if (st) await bumpCounter(ctx.db, ws, 'sequence', st.sequenceId, 'inbox.replies');
}

/* ---------- shared import entry point ---------- */

export interface ImportInboundInput {
  channel: 'email' | 'sms' | 'imessage';
  /** Provider message id; dedupe key. */
  providerId: string;
  from: string;
  to?: string | null;
  subject?: string | null;
  text: string;
  html?: string | null;
  mediaUrls?: string[];
  messageId?: string | null;
  inReplyTo?: string | null;
  threadId?: string | null;
  conversationId?: string | null;
  date?: Date;
  autoSubmitted?: boolean;
  identityId?: string | null;
  provider?: string;
  raw?: Record<string, unknown>;
}

export type ImportInboundResult = { channel: 'email'; outcome: InboundOutcome; emailId: string | null } | { channel: 'sms' | 'imessage'; outcome: InboundChannelOutcome; messageId: string | null };

/**
 * One door for everything that arrives from outside: Inkbox webhooks, the import API, and future
 * Gmail imports. Email runs the mail reply pipeline through the identity's (virtual) mailbox;
 * texts and iMessages run the message pipeline.
 */
export async function importInboundMessage(ctx: Ctx, input: ImportInboundInput, opts: { classify?: boolean } = {}): Promise<ImportInboundResult> {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const identity = input.identityId ? await identityByExternalOrId(ctx, input.identityId) : await identityByAddress(ctx, { email: input.channel === 'email' ? input.to : null, phone: input.channel !== 'email' ? input.to : null });
  if (input.channel === 'email') {
    const members = await memberIds(ctx);
    const userId = identity?.userId ?? members[0];
    if (!userId) throw unprocessable('Workspace has no members to receive mail');
    const mailbox: InboundMailbox = { id: identity?.mailboxId ?? null, workspaceId: ws, userId, provider: 'inkbox', email: (input.to ?? identity?.emailAddress ?? '').toLowerCase() };
    const msg: InboundMessage = {
      providerId: input.providerId,
      messageId: input.messageId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      references: input.inReplyTo ? [input.inReplyTo] : [],
      threadId: input.threadId ?? null,
      from: input.from.toLowerCase(),
      to: [input.to ?? mailbox.email].filter(Boolean),
      date: input.date ?? now,
      subject: input.subject ?? '',
      text: input.text,
      html: input.html ?? null,
      headers: {},
      autoSubmitted: input.autoSubmitted ?? /^(automatic reply|auto(matic)?[- ]?reply|out of (the )?office)/i.test(input.subject ?? ''),
      dsn: null,
    };
    const outcome = await processInbound(ctx, mailbox, msg, { classify: opts.classify });
    const emailId = outcome.kind === 'duplicate' ? null : outcome.kind === 'bounce' ? outcome.emailId : outcome.emailId;
    if (outcome.kind === 'reply') {
      const [em] = emailId ? await ctx.db.select({ prospectId: emails.prospectId, sequenceId: emails.sequenceId }).from(emails).where(eq(emails.id, emailId)).limit(1) : [];
      if (em?.prospectId) await bumpInboxReplies(ctx, em.prospectId, em.sequenceId ?? null);
    }
    return { channel: 'email', outcome, emailId };
  }
  const outcome = await processInboundMessage(ctx, { channel: input.channel, providerId: input.providerId, conversationId: input.conversationId, threadId: input.threadId, inReplyTo: input.inReplyTo, from: input.from, to: input.to ?? identity?.phoneNumber ?? null, text: input.text, mediaUrls: input.mediaUrls, date: input.date ?? now, identityId: identity?.id ?? null, provider: input.provider ?? 'inkbox', raw: input.raw }, opts);
  return { channel: input.channel, outcome, messageId: 'messageId' in outcome ? outcome.messageId : null };
}

async function identityByExternalOrId(ctx: Ctx, id: string): Promise<IdentityRow | null> {
  const [r] = await ctx.db.select().from(channelIdentities).where(and(eq(channelIdentities.workspaceId, ctx.principal.workspaceId), /^[0-9a-f-]{36}$/i.test(id) ? or(eq(channelIdentities.id, id), eq(channelIdentities.externalId, id)) : eq(channelIdentities.externalId, id))).limit(1);
  return r ?? null;
}

/* ---------- calls ---------- */

const OUTCOME_FROM_INKBOX = (c: Pick<InkboxCall, 'status' | 'hangup_reason'>, eventOutcome?: string | null): 'answered' | 'voicemail' | 'no_answer' | 'failed' => {
  if (c.hangup_reason === 'voicemail') return 'voicemail';
  if (c.hangup_reason === 'no_answer' || c.hangup_reason === 'missed' || eventOutcome === 'no_answer') return 'no_answer';
  if (c.hangup_reason === 'busy' || c.hangup_reason === 'rejected' || c.hangup_reason === 'failed' || eventOutcome === 'declined' || eventOutcome === 'failed' || c.status === 'failed' || c.status === 'canceled') return 'failed';
  return 'answered';
};
const DISPOSITION_FOR = { answered: 'connected', voicemail: 'left_voicemail', no_answer: 'no_answer', failed: 'not_connected' } as const;

export function inkboxTranscriptEntries(entries: InkboxTranscriptEntry[], startedAt: Date) {
  const t0 = entries.find((e) => typeof e.ts_ms === 'number')?.ts_ms ?? startedAt.getTime();
  return entries
    .filter((e) => !e.marker && typeof e.text === 'string')
    .map((e, i) => ({ index: e.seq ?? i, role: e.party === 'local' ? ('agent' as const) : ('user' as const), text: e.text, startedAt: new Date(typeof e.ts_ms === 'number' ? e.ts_ms : t0).toISOString(), endedAt: null as string | null }));
}

/**
 * A finished Inkbox call (webhook or poll). Updates the call row we placed, or creates one for a
 * call that started elsewhere, stores the transcript as a call activity, logs the disposition and
 * advances a sequence step that was waiting on it.
 */
export async function ingestInkboxCall(ctx: Ctx, call: InkboxCall, extra: { outcome?: string | null; transcript?: InkboxTranscriptEntry[]; transcriptAbridged?: boolean; actionItems?: Array<{ action: string; details?: string | null }> }, d: ChannelDeps) {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const startedAt = call.started_at ? new Date(call.started_at) : call.created_at ? new Date(call.created_at) : now;
  const endedAt = call.ended_at ? new Date(call.ended_at) : now;
  const outcome = OUTCOME_FROM_INKBOX(call, extra.outcome);
  let entries = extra.transcript ?? [];
  if ((extra.transcriptAbridged || !entries.length) && outcome !== 'no_answer') {
    const h = await inkboxFor(ctx, d);
    if (h) entries = await h.client.callTranscript(call.id).catch(() => entries);
  }
  const transcript = inkboxTranscriptEntries(entries, startedAt);
  const [existing] = await ctx.db.select().from(calls).where(and(eq(calls.workspaceId, ws), eq(calls.provider, 'inkbox'), eq(calls.providerCallSid, call.id))).limit(1);
  const remote = call.direction === 'inbound' ? call.local_phone_number : call.remote_phone_number;
  void remote;
  const prospect = existing?.prospectId ? null : await findProspectByPhone(ctx, call.remote_phone_number);
  const identity = call.local_phone_number ? await identityByAddress(ctx, { phone: call.local_phone_number }) : null;
  const ownerId = existing?.ownerId ?? (await ownerFor(ctx, identity, prospect?.ownerId ?? null));
  const summary = extra.actionItems?.length ? `Next steps: ${extra.actionItems.map((a) => a.action + (a.details ? ` (${a.details})` : '')).join('; ')}` : null;
  const status = outcome === 'answered' || outcome === 'voicemail' ? 'completed' : outcome === 'no_answer' ? 'no_answer' : 'failed';
  const duration = call.duration_seconds ?? Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));
  const patch = { status, outcome, endReason: call.hangup_reason ?? extra.outcome ?? null, endedAt, durationSeconds: duration, transcript, summary, transcriptStatus: transcript.length ? 'ready' : 'none', fromNumber: call.local_phone_number ?? existing?.fromNumber ?? null, toNumber: call.remote_phone_number, updatedAt: now } as const;
  let row;
  if (existing) {
    if (!['initiated', 'queued', 'ringing', 'in_progress'].includes(existing.status)) return { callId: existing.id, duplicate: true as const };
    [row] = await ctx.db.update(calls).set(patch).where(eq(calls.id, existing.id)).returning();
  } else {
    [row] = await ctx.db
      .insert(calls)
      .values({ workspaceId: ws, prospectId: prospect?.id ?? null, accountId: prospect?.accountId ?? null, ownerId, source: 'api', direction: call.direction, time: startedAt, provider: 'inkbox', providerCallSid: call.id, mode: call.mode === 'hosted_agent' ? 'ai' : 'manual', aiConfig: call.reason ? { reason: call.reason, onVoicemail: call.on_voicemail ?? null } : null, ...patch })
      .returning();
  }
  const c = row!;
  if (transcript.length) {
    const segs = transcript.map((t) => ({ speaker: t.role === 'agent' ? ('rep' as const) : ('prospect' as const), start: Math.max(0, (new Date(t.startedAt).getTime() - startedAt.getTime()) / 1000), end: Math.max(0, (new Date(t.startedAt).getTime() - startedAt.getTime()) / 1000), text: t.text }));
    await ctx.db.delete(callTranscripts).where(eq(callTranscripts.callId, c.id));
    await ctx.db.insert(callTranscripts).values({ workspaceId: ws, callId: c.id, provider: 'inkbox', segments: segs, text: segs.map((s) => `${s.speaker === 'rep' ? 'Agent' : 'Prospect'}: ${s.text}`).join('\n'), summary, stats: transcriptStats(segs) });
  }
  await emitEvent(ctx.db, { workspaceId: ws, type: 'call.completed', aggregateType: 'call', aggregateId: c.id, payload: { callId: c.id, prospectId: c.prospectId, ownerId: c.ownerId, status, outcome, durationSeconds: duration, provider: 'inkbox' }, dedupeKey: `${c.id}:completed` });
  if (!c.loggedAt) await logCall(ctx, c.id, { outcome: DISPOSITION_FOR[outcome], notes: summary }).catch(() => undefined);
  // a sequence auto_ai_call step waiting on this call
  if (c.sequenceStateId && c.sequenceStepId) await completeAutoStep(ctx, c.sequenceStateId, c.sequenceStepId);
  return { callId: c.id, outcome, duplicate: false as const };
}

/** Mark an automatic (non-task) step done and let the enrollment move on. */
export async function completeAutoStep(ctx: Ctx, stateId: string, stepId: string, status: 'sent' | 'skipped' = 'sent') {
  const now = ctx.clock.now();
  await ctx.db.update(stepExecutions).set({ status, finishedAt: now }).where(and(eq(stepExecutions.sequenceStateId, stateId), eq(stepExecutions.sequenceStepId, stepId)));
  const rows = await ctx.db
    .update(sequenceStates)
    .set({ stepPhase: 'done', lastStepDoneAt: now })
    .where(and(eq(sequenceStates.id, stateId), eq(sequenceStates.currentStepId, stepId), eq(sequenceStates.stepPhase, 'executing')))
    .returning({ id: sequenceStates.id, state: sequenceStates.state, workspaceId: sequenceStates.workspaceId });
  if (rows[0]?.state === 'active') await ctx.jobs.send('enrollment.advance', { stateId, workspaceId: rows[0].workspaceId, prevDoneAt: now.toISOString() }, { singletonKey: `advance:${stateId}` });
}

/* ---------- webhook dispatch ---------- */

export interface InkboxEvent {
  id?: string;
  event_type: string;
  timestamp?: string;
  data: Record<string, unknown>;
}

/** Idempotent on the envelope id. Returns what happened so the endpoint can answer quickly. */
export async function handleInkboxEvent(ctx: Ctx, ev: InkboxEvent, d: ChannelDeps, opts: { classify?: boolean } = {}): Promise<Record<string, unknown>> {
  const ws = ctx.principal.workspaceId;
  const eventId = ev.id ?? `${ev.event_type}:${JSON.stringify(ev.data).length}:${(ev.data as { message?: { id?: string } }).message?.id ?? (ev.data as { text_message?: { id?: string } }).text_message?.id ?? (ev.data as { call?: { id?: string } }).call?.id ?? ev.timestamp ?? ''}`;
  const inserted = await ctx.db.insert(inboundEvents).values({ workspaceId: ws, provider: 'inkbox', eventId, eventType: ev.event_type }).onConflictDoNothing().returning({ id: inboundEvents.id });
  if (!inserted.length) return { duplicate: true, eventId };
  const data = ev.data ?? {};
  const identities = (data.agent_identities as Array<{ id?: string; address?: string }> | undefined) ?? [];
  const identityExternalId = identities.find((i) => i.id)?.id ?? null;
  switch (ev.event_type) {
    case 'message.received': {
      const m = data.message as Record<string, unknown>;
      const to = (Array.isArray(m.to_addresses) ? (m.to_addresses as string[])[0] : null) ?? (m.email_address as string | undefined) ?? null;
      const r = await importInboundMessage(ctx, { channel: 'email', providerId: String(m.id), from: String(m.from_address ?? ''), to, subject: (m.subject as string | null) ?? '', text: String(m.body ?? m.snippet ?? ''), messageId: (m.message_id as string | null) ?? null, inReplyTo: (m.in_reply_to as string | null) ?? null, threadId: (m.thread_id as string | null) ?? null, date: m.created_at ? new Date(String(m.created_at)) : undefined, identityId: identityExternalId, provider: 'inkbox', raw: { body_state: m.body_state } }, opts);
      return { eventId, kind: r.outcome.kind, emailId: r.channel === 'email' ? r.emailId : null, action: 'action' in r.outcome ? r.outcome.action : undefined };
    }
    case 'text.received': {
      const m = data.text_message as Record<string, unknown>;
      const r = await importInboundMessage(ctx, { channel: 'sms', providerId: String(m.id), from: String(m.sender_phone_number ?? m.remote_phone_number ?? ''), to: (m.local_phone_number as string | null) ?? null, text: String(m.text ?? ''), mediaUrls: Array.isArray(m.media) ? (m.media as Array<{ url?: string } | string>).map((x) => (typeof x === 'string' ? x : (x.url ?? ''))).filter(Boolean) : [], conversationId: (m.conversation_id as string | null) ?? null, date: m.created_at ? new Date(String(m.created_at)) : undefined, identityId: identityExternalId, provider: 'inkbox' }, opts);
      return { eventId, kind: r.outcome.kind, messageId: r.channel === 'email' ? r.emailId : r.messageId, action: 'action' in r.outcome ? r.outcome.action : undefined };
    }
    case 'imessage.received': {
      const m = data.message as Record<string, unknown>;
      if (data.reaction) return { eventId, kind: 'reaction', ignored: true };
      const r = await importInboundMessage(ctx, { channel: 'imessage', providerId: String(m.id), from: String(m.sender_number ?? m.remote_number ?? ''), to: null, text: String(m.content ?? ''), conversationId: (m.conversation_id as string | null) ?? null, threadId: (m.thread_id as string | null) ?? null, inReplyTo: (m.reply_to_message_id as string | null) ?? null, date: m.created_at ? new Date(String(m.created_at)) : undefined, identityId: identityExternalId, provider: 'inkbox' }, opts);
      return { eventId, kind: r.outcome.kind, messageId: r.channel === 'email' ? r.emailId : r.messageId, action: 'action' in r.outcome ? r.outcome.action : undefined };
    }
    case 'text.delivered':
    case 'text.delivery_failed':
    case 'imessage.delivered':
    case 'imessage.delivery_failed':
    case 'message.bounced':
    case 'message.failed': {
      const m = (data.text_message ?? data.message) as Record<string, unknown> | undefined;
      if (!m?.id) return { eventId, ignored: 'no message id' };
      const failed = ev.event_type.endsWith('failed') || ev.event_type.endsWith('bounced');
      await ctx.db
        .update(messages)
        .set({ status: failed ? 'failed' : 'delivered', ...(failed ? { error: String(m.error_detail ?? m.error_message ?? m.error_code ?? ev.event_type) } : { deliveredAt: ctx.clock.now() }), updatedAt: ctx.clock.now() })
        .where(and(eq(messages.workspaceId, ws), eq(messages.provider, 'inkbox'), eq(messages.providerMessageId, String(m.id))));
      return { eventId, kind: failed ? 'failed' : 'delivered' };
    }
    case 'call.ended': {
      const call = data.call as InkboxCall;
      const tr = data.transcript as { entries?: InkboxTranscriptEntry[]; abridged?: boolean } | null | undefined;
      const r = await ingestInkboxCall(ctx, call, { outcome: (data.outcome as string | null) ?? null, transcript: tr?.entries ?? [], transcriptAbridged: !!tr?.abridged, actionItems: (data.post_call_action_items as Array<{ action: string; details?: string | null }> | undefined) ?? [] }, d);
      return { eventId, kind: 'call', ...r };
    }
    case 'a2a.task.created':
    case 'a2a.task.message': {
      const caller = data.caller as { handle?: string; identity_id?: string } | undefined;
      const parts = (data.parts as Array<{ text?: string }> | undefined) ?? [];
      const text = parts.map((p) => p.text ?? '').filter(Boolean).join('\n') || `(task ${data.state ?? 'submitted'})`;
      const r = await processInboundMessage(ctx, { channel: 'a2a', providerId: String(data.message_id ?? `${data.task_id}:${ev.event_type}:${eventId}`), conversationId: (data.task_id as string) ?? null, threadId: (data.context_id as string) ?? null, from: caller?.handle ?? caller?.identity_id ?? 'agent', to: null, text, date: ev.timestamp ? new Date(ev.timestamp) : ctx.clock.now(), identityId: identityExternalId, provider: 'inkbox', raw: { task_id: data.task_id, state: data.state } }, opts);
      return { eventId, kind: r.kind, messageId: 'messageId' in r ? r.messageId : null };
    }
    default:
      return { eventId, ignored: ev.event_type };
  }
}
