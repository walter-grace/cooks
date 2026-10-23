/** Dialer (Twilio Voice), signals and coaching tables. */
import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, tenant, timestamps, workspaceId } from './_base.js';
import { accounts, prospects } from './crm.js';
import { sequenceStates, sequenceSteps, sequences } from './sequencing.js';

export const callDirection = pgEnum('call_direction', ['inbound', 'outbound']);
export const callSource = pgEnum('call_source', ['dialer', 'manual', 'sequence', 'inbound', 'api', 'practice']);
export const callOutcome = pgEnum('call_outcome', [
  'connected',
  'not_connected',
  'meeting_booked',
  'left_voicemail',
  'no_answer',
  'busy',
  'wrong_number',
  'do_not_call',
  'other',
]);

export const callDispositions = pgTable(
  'call_dispositions',
  {
    ...tenant(),
    name: text('name').notNull(),
    callOutcome: callOutcome('call_outcome').notNull().default('other'),
    order: integer('order'),
  },
  (t) => [index('call_dispositions_ws_idx').on(t.workspaceId, t.order)],
);

export const calls = pgTable(
  'calls',
  {
    ...tenant(),
    prospectId: uuid('prospect_id').references(() => prospects.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id'),
    sequenceId: uuid('sequence_id').references(() => sequences.id, { onDelete: 'set null' }),
    sequenceStateId: uuid('sequence_state_id').references(() => sequenceStates.id, { onDelete: 'set null' }),
    sequenceStepId: uuid('sequence_step_id').references(() => sequenceSteps.id, { onDelete: 'set null' }),
    callDispositionId: uuid('call_disposition_id').references(() => callDispositions.id, { onDelete: 'set null' }),
    source: callSource('source').notNull().default('manual'),
    direction: callDirection('direction').notNull().default('outbound'),
    fromNumber: text('from_number'),
    toNumber: text('to_number'),
    status: text('status').notNull().default('completed'),
    durationSeconds: integer('duration_seconds').notNull().default(0),
    time: timestamp('time', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    notes: text('notes'),
    recordingUrl: text('recording_url'),
    transcriptUrl: text('transcript_url'),
    provider: text('provider'),
    providerCallSid: text('provider_call_sid'),
    amdResult: text('amd_result'),
    /** Twilio RecordingSid once the recording webhook fires. */
    recordingSid: text('recording_sid'),
    recordingDurationSeconds: integer('recording_duration_seconds'),
    /** Set when a disposition is logged; drives the call.logged webhook. */
    loggedAt: timestamp('logged_at', { withTimezone: true }),
    taskId: uuid('task_id'),
    transcriptStatus: text('transcript_status').notNull().default('none'),
    coachingStatus: text('coaching_status').notNull().default('none'),
    /** 'bridge' (rep's phone first), 'softphone' (browser), 'ai' (Speko voice agent) or 'manual'. */
    mode: text('mode'),
    /** Speko session id for AI-voiced calls. */
    spekoSessionId: text('speko_session_id'),
    /** answered | voicemail | no_answer | failed, written once the provider reports the call ended. */
    outcome: text('outcome'),
    /** Speaker-labelled transcript entries from the provider (AI calls). */
    transcript: jsonb('transcript').$type<Array<{ index: number; role: 'agent' | 'user' | 'system' | 'rep' | 'prospect'; text: string; startedAt: string; endedAt?: string | null }>>(),
    summary: text('summary'),
    endReason: text('end_reason'),
    costUsd: numeric('cost_usd', { precision: 10, scale: 4 }),
    /** Script and limits the AI call was placed with (never credentials). */
    aiConfig: jsonb('ai_config').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('calls_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('calls_speko_session_idx').on(t.spekoSessionId),
    index('calls_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('calls_ws_time_idx').on(t.workspaceId, t.time),
    index('calls_ws_prospect_idx').on(t.workspaceId, t.prospectId),
    index('calls_ws_owner_idx').on(t.workspaceId, t.ownerId),
    index('calls_provider_sid_idx').on(t.providerCallSid),
  ],
);

export const callRecordings = pgTable('call_recordings', {
  id: id(),
  workspaceId: workspaceId(),
  callId: uuid('call_id')
    .notNull()
    .references(() => calls.id, { onDelete: 'cascade' }),
  url: text('url'),
  storageKey: text('storage_key'),
  durationSeconds: integer('duration_seconds'),
  format: text('format'),
  ...timestamps,
});

export const callTranscripts = pgTable('call_transcripts', {
  id: id(),
  workspaceId: workspaceId(),
  callId: uuid('call_id')
    .notNull()
    .references(() => calls.id, { onDelete: 'cascade' }),
  provider: text('provider'),
  segments: jsonb('segments').$type<unknown[]>().notNull().default([]),
  text: text('text'),
  summary: text('summary'),
  /** talk ratio, longest monologue, questions, wpm, interruptions */
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
});

export const signals = pgTable(
  'signals',
  {
    id: id(),
    workspaceId: workspaceId(),
    prospectId: uuid('prospect_id').references(() => prospects.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    source: text('source'),
    title: text('title'),
    url: text('url'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    score: numeric('score'),
    /** Caller-supplied or derived key so the same signal is stored once per workspace. */
    dedupeKey: text('dedupe_key'),
    /** 'new' | 'acted' | 'dismissed' */
    status: text('status').notNull().default('new'),
    actedAction: text('acted_action'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('signals_ws_kind_idx').on(t.workspaceId, t.kind, t.occurredAt), index('signals_ws_status_idx').on(t.workspaceId, t.status, t.occurredAt), uniqueIndex('signals_ws_dedupe_uq').on(t.workspaceId, t.dedupeKey)],
);

export const coachingScores = pgTable('coaching_scores', {
  id: id(),
  workspaceId: workspaceId(),
  callId: uuid('call_id')
    .notNull()
    .references(() => calls.id, { onDelete: 'cascade' }),
  rubric: text('rubric').notNull(),
  score: numeric('score'),
  feedback: jsonb('feedback').$type<Record<string, unknown>>().notNull().default({}),
  model: text('model'),
  ...timestamps,
});

/** Rules that turn signals into action: enroll in a sequence or create a task for the owner. */
export const signalRules = pgTable(
  'signal_rules',
  {
    ...tenant(),
    name: text('name').notNull(),
    /** Exact kind ('research.funding'), a prefix ('research.*') or '*'. */
    kindPattern: text('kind_pattern').notNull(),
    minScore: numeric('min_score'),
    action: text('action').notNull(), // 'enroll' | 'task'
    sequenceId: uuid('sequence_id').references(() => sequences.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id'),
    taskAction: text('task_action'),
    taskNote: text('task_note'),
    enabled: boolean('enabled').notNull().default(true),
    firedCount: integer('fired_count').notNull().default(0),
    lastFiredAt: timestamp('last_fired_at', { withTimezone: true }),
  },
  (t) => [index('signal_rules_ws_idx').on(t.workspaceId, t.enabled)],
);

/** One telephony provider per workspace. Secrets are AES-GCM encrypted with COOKS_KEK. */
export const telephonyConnections = pgTable(
  'telephony_connections',
  {
    id: id(),
    workspaceId: workspaceId(),
    provider: text('provider').notNull().default('twilio'),
    accountSid: text('account_sid').notNull(),
    authTokenEncrypted: text('auth_token_encrypted').notNull(),
    apiKeySid: text('api_key_sid'),
    apiKeySecretEncrypted: text('api_key_secret_encrypted'),
    twimlAppSid: text('twiml_app_sid'),
    fromNumbers: jsonb('from_numbers').$type<string[]>().notNull().default([]),
    record: boolean('record').notNull().default(true),
    transcribe: boolean('transcribe').notNull().default(true),
    coach: boolean('coach').notNull().default(true),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex('telephony_ws_provider_uq').on(t.workspaceId, t.provider)],
);

/* ---------------------------------------------------------------- parallel dialer */

/**
 * One parallel-dialing session: the rep sits in a carrier conference while Cooks dials several
 * prospects at once. `connectedLineId` is the atomic "first human wins" slot: a line becomes the
 * winner only by an UPDATE … WHERE connected_line_id IS NULL that returns a row.
 */
export const dialSessions = pgTable(
  'dial_sessions',
  {
    id: id(),
    workspaceId: workspaceId(),
    ownerId: uuid('owner_id').notNull(),
    provider: text('provider').notNull().default('twilio'),
    /** waiting_rep | ready | dialing | connected | wrapping | ended */
    status: text('status').notNull().default('waiting_rep'),
    /** browser (Voice SDK) or phone (carrier rings the rep first) */
    repMode: text('rep_mode').notNull().default('browser'),
    repPhone: text('rep_phone'),
    repCallSid: text('rep_call_sid'),
    fromNumber: text('from_number').notNull(),
    conferenceName: text('conference_name').notNull(),
    conferenceSid: text('conference_sid'),
    maxLines: integer('max_lines').notNull().default(3),
    /** b2b | consumer, copied from workspace settings when the session starts */
    complianceMode: text('compliance_mode').notNull().default('b2b'),
    autoDial: boolean('auto_dial').notNull().default(false),
    /** AMD and timing options the lines are dialed with (never credentials). */
    options: jsonb('options').$type<Record<string, unknown>>().notNull().default({}),
    batch: integer('batch').notNull().default(0),
    connectedLineId: uuid('connected_line_id'),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    repJoinedAt: timestamp('rep_joined_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
    stats: jsonb('stats').$type<Record<string, number>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [index('dial_sessions_ws_idx').on(t.workspaceId, t.createdAt), index('dial_sessions_rep_sid_idx').on(t.repCallSid), uniqueIndex('dial_sessions_conf_uq').on(t.conferenceName)],
);

/** One prospect leg inside a session. Carries its own call row so logging and coaching work as usual. */
export const dialLines = pgTable(
  'dial_lines',
  {
    id: id(),
    workspaceId: workspaceId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => dialSessions.id, { onDelete: 'cascade' }),
    batch: integer('batch').notNull().default(0),
    prospectId: uuid('prospect_id').references(() => prospects.id, { onDelete: 'set null' }),
    taskId: uuid('task_id'),
    callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
    toNumber: text('to_number'),
    providerCallSid: text('provider_call_sid'),
    /** queued | skipped | dialing | ringing | answered | connected | dropped | voicemail | no_answer | busy | failed | canceled | completed */
    status: text('status').notNull().default('queued'),
    answeredBy: text('answered_by'),
    /** amd (carrier) | speech (the speech gate heard the pickup) */
    verdictSource: text('verdict_source'),
    /** Speech-gate evidence: { text, reason, confidence, latencyMs, provider, judge } */
    speech: jsonb('speech').$type<Record<string, unknown>>(),
    skipReason: text('skip_reason'),
    endReason: text('end_reason'),
    recordingSid: text('recording_sid'),
    callbackTaskId: uuid('callback_task_id'),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    amdAt: timestamp('amd_at', { withTimezone: true }),
    connectedAt: timestamp('connected_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),
    ...timestamps,
  },
  (t) => [index('dial_lines_session_idx').on(t.sessionId, t.batch, t.status), index('dial_lines_sid_idx').on(t.providerCallSid), index('dial_lines_ws_created_idx').on(t.workspaceId, t.createdAt)],
);

/** Carrier webhook receipts, keyed so a redelivered callback is a no-op. */
export const dialEvents = pgTable(
  'dial_events',
  {
    id: id(),
    workspaceId: workspaceId(),
    sessionId: uuid('session_id').references(() => dialSessions.id, { onDelete: 'cascade' }),
    dedupeKey: text('dedupe_key').notNull(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dial_events_dedupe_uq').on(t.workspaceId, t.dedupeKey), index('dial_events_session_idx').on(t.sessionId, t.createdAt)],
);
