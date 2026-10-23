/**
 * Outbound through Inkbox: email provider for sequence steps, SMS / iMessage with the consent and
 * quiet-hours preflight, and hosted AI calls with a task brief.
 */
import { and, desc, eq, gte, isNull } from 'drizzle-orm';
import { accounts, calls, channelIdentities, messages, prospects, sequenceStates, sequenceSteps, sequences, tasks, users, workspaces } from '@cooks/db';
import type { Ctx } from '../context.js';
import { emitEvent } from '../events.js';
import { notFound, unprocessable } from '../errors.js';
import { pickZone } from '../engine/scheduling.js';
import type { MailProvider, OutboundMessage, SendResult } from '../mail/provider.js';
import { buildMergeContext, renderText, TemplateError } from '../mail/templates.js';
import { bumpCounter } from '../services/analytics.js';
import { serializeCall } from '../services/calls.js';
import { serializeMessage } from '../services/messages.js';
import { memberIds, requireMember, uuidOr404 } from '../services/_shared.js';
import { withinCallHours, nextCallWindow } from '../telephony/ai-call.js';
import { normalizePhone } from '../telephony/twilio.js';
import { identityForUser, requireInkbox, type ChannelDeps, type IdentityRow } from './connection.js';
import { completeAutoStep, ingestInkboxCall } from './inbound.js';
import { InkboxClient, InkboxError } from './inkbox.js';

/* ---------- email ---------- */

/** Sequence email through an Inkbox identity mailbox. */
export class InkboxMailProvider implements MailProvider {
  readonly kind = 'inkbox' as const;
  constructor(
    private client: InkboxClient,
    private fromAddress: string,
  ) {}
  async send(msg: OutboundMessage): Promise<SendResult> {
    const r = await this.client.sendEmail(this.fromAddress, { to: msg.to, cc: msg.cc, bcc: msg.bcc, subject: msg.subject, text: msg.text, html: msg.html, inReplyTo: msg.inReplyTo ?? null, idempotencyKey: `cooks-${msg.messageId.replace(/[^A-Za-z0-9@.-]/g, '')}`.slice(0, 255) });
    return { providerMessageId: r.id, threadId: r.thread_id ?? null, messageId: r.message_id ?? null, accepted: msg.to, rejected: [] };
  }
}

/* ---------- SMS / iMessage preflight ---------- */

export type PreflightBlock = { ok: false; reason: 'do_not_contact' | 'opted_out' | 'not_opted_in' | 'contact_rule' | 'quiet_hours' | 'no_phone' | 'no_identity'; message: string; retryAt?: Date };
export type Preflight = { ok: true; tz: string } | PreflightBlock;

const US_LIKE = (e164: string) => /^\+1/.test(e164);

/**
 * Everything that must be true before a text goes out: a phone number, a sending identity, no
 * do-not-contact / STOP on file, 08:00–21:00 in the recipient's zone (TCPA quiet hours), SMS
 * consent in Inkbox's registry for US numbers, and no blocking outbound contact rule.
 */
export async function smsPreflight(ctx: Ctx, client: InkboxClient, identity: IdentityRow | null, p: typeof prospects.$inferSelect | null, to: string | null, channel: 'sms' | 'imessage', now: Date): Promise<Preflight> {
  if (!to) return { ok: false, reason: 'no_phone', message: 'No phone number to text' };
  if (!identity) return { ok: false, reason: 'no_identity', message: 'No Inkbox identity with a phone number is mapped' };
  if (p?.doNotContact || p?.smsOptOutAt) return { ok: false, reason: p?.smsOptOutAt ? 'opted_out' : 'do_not_contact', message: p?.smsOptOutAt ? 'Prospect texted STOP' : 'Prospect is marked do not contact' };
  const [account] = p?.accountId ? await ctx.db.select().from(accounts).where(eq(accounts.id, p.accountId)).limit(1) : [];
  const [owner] = p?.ownerId ? await ctx.db.select().from(users).where(eq(users.id, p.ownerId)).limit(1) : [];
  const [w] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ctx.principal.workspaceId)).limit(1);
  const tz = pickZone(p?.timezone, account?.timezone, owner?.timezone, w?.settings.timezone);
  if (!withinCallHours(now, tz)) return { ok: false, reason: 'quiet_hours', message: `Outside texting hours for ${tz} (08:00–21:00 local)`, retryAt: nextCallWindow(now, tz) };
  if (channel === 'sms' && US_LIKE(to)) {
    const consent = await client.smsOptIn(to).catch(() => null);
    if (consent?.status === 'opted_out') return { ok: false, reason: 'opted_out', message: 'Recipient opted out (STOP) in Inkbox' };
    if (!consent || consent.status !== 'opted_in') return { ok: false, reason: 'not_opted_in', message: 'US recipient has not texted START to your Inkbox number (TCPA consent)' };
  }
  const rules = await client.phoneContactRules(identity.handle).catch(() => []);
  const blocked = rules.some((r) => r.action === 'block' && (r.direction === 'outbound' || r.direction === 'both') && r.status !== 'inactive' && normalizePhone(r.match_target) === to);
  if (blocked) return { ok: false, reason: 'contact_rule', message: 'An outbound contact rule on the Inkbox identity blocks this number' };
  return { ok: true, tz };
}

/* ---------- send ---------- */

async function mergeContext(ctx: Ctx, p: typeof prospects.$inferSelect | null, ownerId: string | null, seqId: string | null, stepId: string | null, now: Date) {
  const [account] = p?.accountId ? await ctx.db.select().from(accounts).where(eq(accounts.id, p.accountId)).limit(1) : [];
  const [owner] = ownerId ? await ctx.db.select().from(users).where(eq(users.id, ownerId)).limit(1) : [];
  const [w] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ctx.principal.workspaceId)).limit(1);
  const [seq] = seqId ? await ctx.db.select().from(sequences).where(eq(sequences.id, seqId)).limit(1) : [];
  const [step] = stepId ? await ctx.db.select().from(sequenceSteps).where(eq(sequenceSteps.id, stepId)).limit(1) : [];
  const tz = pickZone(p?.timezone, account?.timezone, owner?.timezone, w?.settings.timezone);
  return buildMergeContext({ prospect: p ?? {}, account, owner: owner ?? {}, sequence: seq, step, now, tz, unsubscribeUrl: '' });
}

export type MessageSendOutcome = { status: 'sent'; messageId: string } | { status: 'blocked'; reason: string; messageId: string } | { status: 'deferred'; until: Date; messageId: string } | { status: 'failed'; error: string; messageId: string } | { status: 'skipped'; reason: string };

/**
 * Deliver one queued message. Renders the body, runs the preflight, sends through the identity,
 * records the outcome and lets a sequence step move on. Blocked recipients are skipped with the
 * reason on the row (and the step counts as skipped, not failed).
 */
export async function sendQueuedMessage(ctx: Ctx, messageId: string, d: ChannelDeps): Promise<MessageSendOutcome> {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const [m] = await ctx.db.select().from(messages).where(and(eq(messages.workspaceId, ws), eq(messages.id, messageId), isNull(messages.deletedAt))).limit(1);
  if (!m) return { status: 'skipped', reason: 'missing' };
  if (m.status !== 'queued') return { status: 'skipped', reason: `status=${m.status}` };
  const h = await requireInkbox(ctx, d);
  const [p] = m.prospectId ? await ctx.db.select().from(prospects).where(eq(prospects.id, m.prospectId)).limit(1) : [];
  const to = normalizePhone(m.toAddr ?? p?.phone ?? null);
  const [idRow] = m.identityId ? await ctx.db.select().from(channelIdentities).where(eq(channelIdentities.id, m.identityId)).limit(1) : [];
  const identity = idRow ?? (await identityForUser(ctx, m.ownerId, m.channel === 'imessage' ? 'imessage' : 'sms'));
  const finishStep = async (status: 'sent' | 'skipped') => {
    if (m.sequenceStateId && m.sequenceStepId) await completeAutoStep(ctx, m.sequenceStateId, m.sequenceStepId, status);
  };
  const block = async (reason: string, message: string, retryAt?: Date) => {
    if (retryAt && m.sequenceStateId) {
      // sequence steps wait for the next window rather than skip; one-off sends are refused instead
      await ctx.jobs.send('message.send', { messageId, workspaceId: ws }, { startAfter: retryAt, singletonKey: `msg:${messageId}:${retryAt.getTime()}` });
      await ctx.db.update(messages).set({ blockReason: reason, error: `${message}; retrying ${retryAt.toISOString()}`, updatedAt: now }).where(eq(messages.id, messageId));
      return { status: 'deferred' as const, until: retryAt, messageId };
    }
    await ctx.db.update(messages).set({ status: 'blocked', blockReason: reason, error: message, updatedAt: now }).where(eq(messages.id, messageId));
    if (m.sequenceId) await bumpCounter(ctx.db, ws, 'sequence', m.sequenceId, 'messages.blocked');
    if (m.sequenceStepId) await bumpCounter(ctx.db, ws, 'sequence_step', m.sequenceStepId, 'messages.blocked');
    await emitEvent(ctx.db, { workspaceId: ws, type: 'message.failed', aggregateType: 'message', aggregateId: messageId, payload: { messageId, channel: m.channel, prospectId: m.prospectId, blocked: true, reason, message }, dedupeKey: `${messageId}:blocked` });
    await finishStep('skipped');
    return { status: 'blocked' as const, reason, messageId };
  };
  const pre = await smsPreflight(ctx, h.client, identity, p ?? null, to, m.channel === 'imessage' ? 'imessage' : 'sms', now);
  if (!pre.ok) return block(pre.reason, pre.message, pre.retryAt);
  // render
  let body = m.body ?? '';
  if (/\{\{|\{%/.test(body)) {
    try {
      body = await renderText(body, await mergeContext(ctx, p ?? null, m.ownerId, m.sequenceId, m.sequenceStepId, now));
    } catch (e) {
      if (e instanceof TemplateError) return block('template', e.message);
      throw e;
    }
  }
  if (!body.trim() && !m.mediaUrls.length) return block('empty', 'Message body is empty');
  const from = m.channel === 'imessage' ? (identity!.imessageNumber ?? identity!.phoneNumber) : identity!.phoneNumber;
  try {
    let providerMessageId: string;
    let conversationId: string | null = m.conversationId;
    if (m.channel === 'imessage') {
      const r = await h.client.sendImessage(identity!.externalId, { to: conversationId ? undefined : to!, conversationId: conversationId ?? undefined, text: body, mediaUrls: m.mediaUrls, idempotencyKey: `cooks-${messageId}` });
      providerMessageId = r.message.id;
      conversationId = r.message.conversation_id ?? conversationId;
    } else {
      const r = await h.client.sendText(identity!.phoneNumberId!, { to: to!, text: body, mediaUrls: m.mediaUrls, idempotencyKey: `cooks-${messageId}` });
      providerMessageId = r.id;
      conversationId = r.conversation_id ?? conversationId;
    }
    await ctx.db.update(messages).set({ status: 'sent', body, fromAddr: from, toAddr: to, identityId: identity!.id, provider: 'inkbox', providerMessageId, conversationId, sentAt: now, updatedAt: now }).where(eq(messages.id, messageId));
  } catch (e) {
    if (e instanceof InkboxError) {
      if (['recipient_not_opted_in', 'recipient_opted_out', 'FORBIDDEN', 'message_blocked_spam_filter', 'invalid_receiver_number'].includes(e.code)) {
        if (e.code === 'recipient_opted_out' && p) await ctx.db.update(prospects).set({ smsOptOutAt: now, updatedAt: now }).where(eq(prospects.id, p.id));
        return block(e.code === 'FORBIDDEN' ? 'contact_rule' : e.code, e.message);
      }
      if (e.retryable) throw e; // pg-boss retries with backoff
      await ctx.db.update(messages).set({ status: 'failed', error: e.message, updatedAt: now }).where(eq(messages.id, messageId));
      await emitEvent(ctx.db, { workspaceId: ws, type: 'message.failed', aggregateType: 'message', aggregateId: messageId, payload: { messageId, channel: m.channel, prospectId: m.prospectId, blocked: false, code: e.code, message: e.message }, dedupeKey: `${messageId}:failed` });
      await finishStep('skipped');
      return { status: 'failed', error: e.message, messageId };
    }
    throw e;
  }
  if (m.sequenceId) await bumpCounter(ctx.db, ws, 'sequence', m.sequenceId, 'messages.sent');
  if (m.sequenceStepId) await bumpCounter(ctx.db, ws, 'sequence_step', m.sequenceStepId, 'messages.sent');
  await emitEvent(ctx.db, { workspaceId: ws, type: 'message.sent', aggregateType: 'message', aggregateId: messageId, payload: { messageId, channel: m.channel, prospectId: m.prospectId, sequenceStateId: m.sequenceStateId, to }, dedupeKey: `${messageId}:sent` });
  await finishStep('sent');
  return { status: 'sent', messageId };
}

export interface SendMessageInput {
  channel: 'sms' | 'imessage';
  prospectId?: string;
  to?: string;
  text: string;
  mediaUrls?: string[];
  ownerId?: string;
  identityId?: string;
  taskId?: string;
  /** false = queue only (the worker sends); default true sends inline and reports the outcome. */
  send?: boolean;
}

/** API / MCP: create a message and (by default) send it right away. */
export async function sendMessage(ctx: Ctx, input: SendMessageInput, d: ChannelDeps) {
  const ws = ctx.principal.workspaceId;
  const task = input.taskId ? (await ctx.db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.id, uuidOr404(input.taskId, 'Task')))).limit(1))[0] : undefined;
  if (input.taskId && !task) throw notFound('Task');
  const prospectId = input.prospectId ?? task?.prospectId ?? null;
  const [p] = prospectId ? await ctx.db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), eq(prospects.id, uuidOr404(prospectId, 'Prospect')), isNull(prospects.deletedAt))).limit(1) : [];
  if (prospectId && !p) throw notFound('Prospect');
  const to = normalizePhone(input.to ?? p?.phone ?? null);
  if (!to) throw unprocessable(p ? `${p.name ?? 'This prospect'} has no phone number` : 'to is required when no prospect is given', { field: 'to' });
  const members = await memberIds(ctx);
  const ownerId = input.ownerId ? await requireMember(ctx, input.ownerId, 'ownerId') : ([task?.ownerId, ctx.principal.userId, p?.ownerId].find((id): id is string => !!id && members.includes(id)) ?? members[0]);
  if (!ownerId) throw unprocessable('ownerId is required');
  if (input.identityId && !members) throw notFound('Identity');
  const [row] = await ctx.db
    .insert(messages)
    .values({ workspaceId: ws, prospectId: p?.id ?? null, accountId: p?.accountId ?? null, ownerId, identityId: input.identityId ?? null, taskId: task?.id ?? null, sequenceId: task?.sequenceId ?? null, sequenceStateId: task?.sequenceStateId ?? null, sequenceStepId: task?.sequenceStepId ?? null, channel: input.channel, direction: 'outbound', status: 'queued', toAddr: to, body: input.text, mediaUrls: input.mediaUrls ?? [], provider: 'inkbox' })
    .returning();
  if (input.send === false) {
    await ctx.jobs.send('message.send', { messageId: row!.id, workspaceId: ws }, { singletonKey: `msg:${row!.id}` });
    return { message: serializeMessage(row!), outcome: { status: 'queued' as const } };
  }
  const outcome = await sendQueuedMessage(ctx, row!.id, d);
  const [after] = await ctx.db.select().from(messages).where(eq(messages.id, row!.id)).limit(1);
  if (outcome.status === 'blocked') throw unprocessable(`Not sent: ${after?.error ?? outcome.reason}`, { code: outcome.reason.toUpperCase(), messageId: row!.id, blockReason: outcome.reason });
  if (outcome.status === 'deferred') throw unprocessable(`Not sent yet: ${after?.error ?? 'outside texting hours'}`, { code: 'QUIET_HOURS', messageId: row!.id, blockReason: 'quiet_hours', retryAt: outcome.until.toISOString() });
  if (outcome.status === 'failed') throw unprocessable(`Inkbox could not send: ${outcome.error}`, { code: 'SEND_FAILED', messageId: row!.id });
  return { message: serializeMessage(after!), outcome };
}

/* ---------- hosted AI calls ---------- */

export interface InkboxCallInput {
  prospectId?: string;
  to?: string;
  reason: string;
  onVoicemail?: 'leave_message' | 'hang_up' | 'ignore';
  voicemailMessage?: string;
  identityId?: string;
  ownerId?: string;
  taskId?: string;
  stateId?: string;
  stepId?: string;
}

/** Place a hosted Inkbox call from a brief. A 2xx means queued; `pollInkboxCall` / call.ended finish it. */
export async function placeInkboxCall(ctx: Ctx, input: InkboxCallInput, d: ChannelDeps) {
  const ws = ctx.principal.workspaceId;
  const now = ctx.clock.now();
  const h = await requireInkbox(ctx, d);
  const task = input.taskId ? (await ctx.db.select().from(tasks).where(and(eq(tasks.workspaceId, ws), eq(tasks.id, uuidOr404(input.taskId, 'Task')))).limit(1))[0] : undefined;
  const [state] = input.stateId ? await ctx.db.select().from(sequenceStates).where(eq(sequenceStates.id, input.stateId)).limit(1) : [];
  const prospectId = input.prospectId ?? task?.prospectId ?? state?.prospectId ?? null;
  const [p] = prospectId ? await ctx.db.select().from(prospects).where(and(eq(prospects.workspaceId, ws), eq(prospects.id, prospectId), isNull(prospects.deletedAt))).limit(1) : [];
  const to = normalizePhone(input.to ?? p?.phone ?? null);
  if (!to) throw unprocessable(p ? `${p.name ?? 'This prospect'} has no phone number` : 'to is required', { field: 'to' });
  const members = await memberIds(ctx);
  const ownerId = [input.ownerId, task?.ownerId, state?.ownerId, ctx.principal.userId, p?.ownerId].find((id): id is string => !!id && members.includes(id)) ?? members[0]!;
  const identity = input.identityId ? (await ctx.db.select().from(channelIdentities).where(eq(channelIdentities.id, input.identityId)).limit(1))[0] : await identityForUser(ctx, ownerId, 'call');
  if (!identity?.phoneNumber) throw unprocessable('No Inkbox identity with a phone number is mapped', { code: 'NO_IDENTITY' });
  if (p?.doNotContact) throw unprocessable(`${p.name ?? 'This prospect'} is on the do-not-call list`, { code: 'DO_NOT_CALL' });
  const [account] = p?.accountId ? await ctx.db.select().from(accounts).where(eq(accounts.id, p.accountId)).limit(1) : [];
  const [owner] = await ctx.db.select().from(users).where(eq(users.id, ownerId)).limit(1);
  const [w] = await ctx.db.select().from(workspaces).where(eq(workspaces.id, ws)).limit(1);
  const tz = pickZone(p?.timezone, account?.timezone, owner?.timezone, w?.settings.timezone);
  if (!withinCallHours(now, tz)) throw unprocessable(`Outside calling hours for ${tz} (08:00–21:00 local)`, { code: 'QUIET_HOURS', timezone: tz, nextWindowAt: nextCallWindow(now, tz).toISOString() });
  let reason = input.reason;
  if (/\{\{|\{%/.test(reason)) reason = await renderText(reason, await mergeContext(ctx, p ?? null, ownerId, state?.sequenceId ?? null, input.stepId ?? null, now));
  const [row] = await ctx.db
    .insert(calls)
    .values({ workspaceId: ws, prospectId: p?.id ?? null, accountId: p?.accountId ?? null, ownerId, sequenceId: state?.sequenceId ?? task?.sequenceId ?? null, sequenceStateId: state?.id ?? task?.sequenceStateId ?? null, sequenceStepId: input.stepId ?? task?.sequenceStepId ?? null, taskId: task?.id ?? null, source: state || task ? 'sequence' : 'dialer', direction: 'outbound', fromNumber: identity.phoneNumber, toNumber: to, status: 'initiated', time: now, provider: 'inkbox', mode: 'ai', aiConfig: { reason: reason.slice(0, 2000), onVoicemail: input.onVoicemail ?? 'leave_message', identity: identity.handle, timezone: tz } })
    .returning();
  const call = row!;
  try {
    const r = await h.client.placeCall({ fromNumber: identity.phoneNumber, toNumber: to, identityId: identity.externalId, reason: reason.slice(0, 2000), onVoicemail: input.onVoicemail ?? 'leave_message', voicemailMessage: input.voicemailMessage ?? null, idempotencyKey: `cooks-call-${call.id}` });
    const id = 'call_id' in r ? r.call_id : r.id;
    const [updated] = await ctx.db.update(calls).set({ providerCallSid: id, status: 'queued', updatedAt: now }).where(eq(calls.id, call.id)).returning();
    await ctx.jobs.send('inkbox.call_poll', { callId: call.id, workspaceId: ws, attempt: 1 }, { startAfter: new Date(now.getTime() + 15_000), singletonKey: `inkpoll:${call.id}:1` });
    return { call: serializeCall(updated!), status: 'queued' as const };
  } catch (e) {
    const err = e instanceof InkboxError ? e : new InkboxError(502, 'UNKNOWN', (e as Error).message, true);
    await ctx.db.update(calls).set({ status: 'failed', outcome: 'failed', endReason: err.code, notes: `Inkbox: ${err.message}`, endedAt: now, updatedAt: now }).where(eq(calls.id, call.id));
    if (input.stateId && input.stepId) await completeAutoStep(ctx, input.stateId, input.stepId, 'skipped');
    throw unprocessable(err.message, { code: err.code, provider: 'inkbox', retryable: err.retryable });
  }
}

/** Poll an Inkbox call until it ends (the call.ended webhook usually gets there first). */
export async function pollInkboxCall(ctx: Ctx, callId: string, d: ChannelDeps, opts: { attempt?: number } = {}): Promise<{ done: boolean; status: string; nextDelaySeconds?: number }> {
  const ws = ctx.principal.workspaceId;
  const [row] = await ctx.db.select().from(calls).where(and(eq(calls.workspaceId, ws), eq(calls.id, callId))).limit(1);
  if (!row || row.provider !== 'inkbox' || !row.providerCallSid) return { done: true, status: row?.status ?? 'missing' };
  if (!['initiated', 'queued', 'ringing', 'in_progress'].includes(row.status)) return { done: true, status: row.status };
  const h = await requireInkbox(ctx, d);
  const call = await h.client.getCall(row.providerCallSid);
  const now = ctx.clock.now();
  if (call.status === 'completed' || call.status === 'failed' || call.status === 'canceled') {
    await ingestInkboxCall(ctx, call, {}, d);
    return { done: true, status: call.status };
  }
  const age = (now.getTime() - row.createdAt.getTime()) / 1000;
  if (age > 60 * 30) {
    await h.client.hangupCall(row.providerCallSid).catch(() => undefined);
    await ingestInkboxCall(ctx, { ...call, status: 'failed', hangup_reason: 'max_duration', ended_at: now.toISOString() }, {}, d);
    return { done: true, status: 'failed' };
  }
  const next = call.status === 'answered' ? 'in_progress' : call.status === 'ringing' ? 'ringing' : 'queued';
  if (next !== row.status) {
    await ctx.db.update(calls).set({ status: next, ...(next === 'in_progress' ? { time: now } : {}), updatedAt: now }).where(eq(calls.id, row.id));
    if (next === 'in_progress') await emitEvent(ctx.db, { workspaceId: ws, type: 'call.started', aggregateType: 'call', aggregateId: row.id, payload: { callId: row.id, prospectId: row.prospectId, ownerId: row.ownerId, provider: 'inkbox' }, dedupeKey: `${row.id}:started` });
  }
  const attempt = opts.attempt ?? 1;
  return { done: false, status: next, nextDelaySeconds: attempt < 4 ? 15 : 30 };
}

/** A sequence `auto_ai_call` step: place the call from the step body (the brief). */
export async function runAiCallStep(ctx: Ctx, stateId: string, stepId: string, d: ChannelDeps) {
  const [step] = await ctx.db.select().from(sequenceSteps).where(eq(sequenceSteps.id, stepId)).limit(1);
  const [state] = await ctx.db.select().from(sequenceStates).where(eq(sequenceStates.id, stateId)).limit(1);
  if (!step || !state) return { skipped: 'missing' };
  if (state.stepPhase !== 'executing' || state.currentStepId !== stepId) return { skipped: 'not executing' };
  const reason = step.body?.trim() || `Call {{ prospect.firstName }} on behalf of {{ owner.name }} at {{ workspace.name }}. ${step.note ?? ''}`.trim();
  try {
    return await placeInkboxCall(ctx, { stateId, stepId, reason, onVoicemail: 'leave_message' }, d);
  } catch (e) {
    // refused (quiet hours, DNC, no identity): skip the step so the enrollment keeps moving
    const code = (e as { details?: { code?: string } }).details?.code;
    if (code === 'QUIET_HOURS') {
      const at = new Date((e as { details?: { nextWindowAt?: string } }).details?.nextWindowAt ?? Date.now() + 3_600_000);
      await ctx.jobs.send('inkbox.call', { stateId, stepId, workspaceId: ctx.principal.workspaceId }, { startAfter: at, singletonKey: `inkcall:${stateId}:${stepId}:${at.getTime()}` });
      return { deferred: at.toISOString() };
    }
    await completeAutoStep(ctx, stateId, stepId, 'skipped');
    return { skipped: code ?? (e as Error).message };
  }
}

/** Today's messaging volume, for the settings page. */
export async function messagingStats(ctx: Ctx) {
  const ws = ctx.principal.workspaceId;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const rows = await ctx.db.select({ channel: messages.channel, direction: messages.direction, status: messages.status }).from(messages).where(and(eq(messages.workspaceId, ws), gte(messages.createdAt, dayStart)));
  const out: Record<string, number> = { sentToday: 0, receivedToday: 0, blockedToday: 0 };
  for (const r of rows) {
    if (r.direction === 'inbound') out.receivedToday!++;
    else if (r.status === 'blocked') out.blockedToday!++;
    else if (r.status === 'sent' || r.status === 'delivered') out.sentToday!++;
  }
  return out;
}
export const _unusedDesc = desc;
