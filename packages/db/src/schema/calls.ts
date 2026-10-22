/** Dialer (Twilio Voice), signals and coaching tables. */
import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, tenant, timestamps, workspaceId } from './_base.js';
import { accounts, prospects } from './crm.js';
import { sequenceStates, sequenceSteps, sequences } from './sequencing.js';

export const callDirection = pgEnum('call_direction', ['inbound', 'outbound']);
export const callSource = pgEnum('call_source', ['dialer', 'manual', 'sequence', 'inbound', 'api']);
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
    /** 'bridge' (rep's phone first) or 'softphone' (browser). */
    mode: text('mode'),
  },
  (t) => [
    index('calls_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
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
  (t) => [uniqueIndex('telephony_ws_uq').on(t.workspaceId)],
);
