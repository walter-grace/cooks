import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, tenant, timestamps, workspaceId } from './_base.js';
import { accounts, prospects, tags } from './crm.js';

export const STEP_ACTIONS = [
  'call',
  'manual_email',
  'auto_email',
  'manual_email_reply',
  'auto_email_reply',
  'basic_task',
  'linkedin_connection_request',
  'manual_linkedin_connection_request',
  'manual_linkedin_message',
  'automatic_linkedin_message',
  'manual_sms',
  'auto_sms',
  'manual_whatsapp',
  'manual_imessage',
  'auto_imessage',
  'auto_ai_call',
] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export const stepAction = pgEnum('step_action', STEP_ACTIONS);
export const sequenceType = pgEnum('sequence_type', ['interval', 'date']);
export const privacy = pgEnum('privacy', ['private', 'team_visible', 'team_editable']);
export const sequenceStateState = pgEnum('sequence_state_state', ['pending_start', 'active', 'paused', 'finished']);
export const stepPhase = pgEnum('step_phase', ['idle', 'scheduled', 'awaiting_task', 'executing', 'done']);
export const finishReason = pgEnum('finish_reason', [
  'completed',
  'replied',
  'unsubscribed',
  'bounced',
  'manual',
  'removed',
  'prospect_deleted',
  'error',
]);
export const replyBehavior = pgEnum('reply_behavior', ['finish', 'pause', 'continue']);
export const taskPriority = pgEnum('task_priority', ['low', 'normal', 'high', 'urgent']);
export const templateSource = pgEnum('template_source', ['user', 'step_auto', 'ai']);
export const executionStatus = pgEnum('execution_status', ['scheduled', 'running', 'sent', 'skipped', 'failed', 'task_created']);

export const sequences = pgTable(
  'sequences',
  {
    ...tenant(),
    name: text('name').notNull(),
    type: sequenceType('type').notNull().default('interval'),
    enabled: boolean('enabled').notNull().default(true),
    privacy: privacy('privacy').notNull().default('team_editable'),
    ownerId: uuid('owner_id').notNull(),
    parentSequenceId: uuid('parent_sequence_id'),
    parentSequenceStepId: uuid('parent_sequence_step_id'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('sequences_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('sequences_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('sequences_ws_owner_idx').on(t.workspaceId, t.ownerId),
    index('sequences_ws_parent_idx').on(t.workspaceId, t.parentSequenceId),
    index('sequences_ws_name_idx').on(t.workspaceId, sql`lower(${t.name})`),
  ],
);

export const sequenceTags = pgTable(
  'sequence_tags',
  {
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    tagId: uuid('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.sequenceId, t.tagId] })],
);

export const emailTemplates = pgTable(
  'email_templates',
  {
    ...tenant(),
    name: text('name'),
    subject: text('subject'),
    htmlBody: text('html_body'),
    textBody: text('text_body'),
    source: templateSource('source').notNull().default('user'),
    archived: boolean('archived').notNull().default(false),
    order: integer('order').notNull().default(0),
    ownerId: uuid('owner_id'),
    privacy: privacy('privacy').notNull().default('team_editable'),
  },
  (t) => [
    index('email_templates_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('email_templates_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('email_templates_ws_owner_idx').on(t.workspaceId, t.ownerId),
    index('email_templates_ws_archived_idx').on(t.workspaceId, t.archived),
  ],
);

export interface AiEmailConfig {
  agent?: { id: string };
  promptOverride?: string;
}

export const sequenceSteps = pgTable(
  'sequence_steps',
  {
    ...tenant(),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    order: integer('order').notNull(),
    name: text('name'),
    note: text('note'),
    action: stepAction('action').notNull(),
    intervalMinutes: integer('interval_minutes').notNull().default(0),
    emailTemplateId: uuid('email_template_id').references(() => emailTemplates.id, { onDelete: 'set null' }),
    aiEmail: jsonb('ai_email').$type<AiEmailConfig>(),
    hasAbVariants: boolean('has_ab_variants').notNull().default(false),
    /** Message text for SMS / iMessage steps, or the task brief for AI call steps (Liquid merge fields). */
    body: text('body'),
  },
  (t) => [
    index('sequence_steps_seq_order_idx').on(t.sequenceId, t.order),
    index('sequence_steps_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('sequence_steps_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    uniqueIndex('sequence_steps_one_li_cr_uq')
      .on(t.sequenceId)
      .where(sql`${t.action} = 'linkedin_connection_request' AND ${t.deletedAt} IS NULL`),
  ],
);

/** Schema only in v1 (A/B variants). */
export const sequenceStepVariants = pgTable('sequence_step_variants', {
  id: id(),
  workspaceId: workspaceId(),
  stepId: uuid('step_id')
    .notNull()
    .references(() => sequenceSteps.id, { onDelete: 'cascade' }),
  emailTemplateId: uuid('email_template_id')
    .notNull()
    .references(() => emailTemplates.id, { onDelete: 'cascade' }),
  weight: integer('weight').notNull().default(1),
  ...timestamps,
});

export type EmailOverrides = Record<string, { subject?: string; body?: string }>;

export const sequenceStates = pgTable(
  'sequence_states',
  {
    ...tenant(),
    sequenceId: uuid('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id').notNull(),
    creatorId: uuid('creator_id'),
    mailboxId: uuid('mailbox_id'),
    state: sequenceStateState('state').notNull().default('active'),
    stepPhase: stepPhase('step_phase').notNull().default('idle'),
    currentStepId: uuid('current_step_id'),
    currentStepOrder: integer('current_step_order'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastStepDoneAt: timestamp('last_step_done_at', { withTimezone: true }),
    holdReason: text('hold_reason'),
    finishReason: finishReason('finish_reason'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    pendingJobId: text('pending_job_id'),
    replyBehavior: replyBehavior('reply_behavior'),
    emailOverrides: jsonb('email_overrides').$type<EmailOverrides>().notNull().default({}),
    version: integer('version').notNull().default(0),
  },
  (t) => [
    uniqueIndex('sequence_states_active_uq')
      .on(t.workspaceId, t.sequenceId, t.prospectId)
      .where(sql`${t.deletedAt} IS NULL AND ${t.state} <> 'finished'`),
    index('sequence_states_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('sequence_states_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('sequence_states_ws_state_idx').on(t.workspaceId, t.state),
    index('sequence_states_ws_prospect_idx').on(t.workspaceId, t.prospectId),
    index('sequence_states_ws_account_idx').on(t.workspaceId, t.accountId),
    index('sequence_states_ws_sequence_idx').on(t.workspaceId, t.sequenceId),
    index('sequence_states_next_run_idx')
      .on(t.workspaceId, t.nextRunAt)
      .where(sql`${t.state} = 'active'`),
  ],
);

export const stepExecutions = pgTable(
  'step_executions',
  {
    id: id(),
    workspaceId: workspaceId(),
    sequenceStateId: uuid('sequence_state_id')
      .notNull()
      .references(() => sequenceStates.id, { onDelete: 'cascade' }),
    sequenceStepId: uuid('sequence_step_id').notNull(),
    attempt: integer('attempt').notNull().default(1),
    status: executionStatus('status').notNull().default('scheduled'),
    taskId: uuid('task_id'),
    emailId: uuid('email_id'),
    result: jsonb('result').$type<Record<string, unknown>>(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex('step_executions_once_uq').on(t.sequenceStateId, t.sequenceStepId)],
);

export const tasks = pgTable(
  'tasks',
  {
    ...tenant(),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    accountId: uuid('account_id'),
    ownerId: uuid('owner_id').notNull(),
    action: stepAction('action').notNull(),
    /** pending | ready | finished | skipped | failed */
    status: text('status').notNull().default('ready'),
    completed: boolean('completed').notNull().default(false),
    priority: taskPriority('priority').notNull().default('normal'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    note: text('note'),
    sequenceId: uuid('sequence_id').references(() => sequences.id, { onDelete: 'set null' }),
    sequenceStateId: uuid('sequence_state_id').references(() => sequenceStates.id, { onDelete: 'set null' }),
    sequenceStepId: uuid('sequence_step_id'),
    draftEmailId: uuid('draft_email_id'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    skippedAt: timestamp('skipped_at', { withTimezone: true }),
  },
  (t) => [
    index('tasks_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('tasks_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('tasks_ws_owner_due_idx').on(t.workspaceId, t.ownerId, t.dueAt),
    index('tasks_ws_status_idx').on(t.workspaceId, t.status),
    index('tasks_ws_prospect_idx').on(t.workspaceId, t.prospectId),
    index('tasks_ws_state_idx').on(t.workspaceId, t.sequenceStateId),
    index('tasks_ws_due_idx').on(t.workspaceId, t.dueAt),
  ],
);

/** Rolled-up counters read as the `analytics` object on Sequence / SequenceStep. */
export const analyticsCounters = pgTable(
  'analytics_counters',
  {
    workspaceId: workspaceId(),
    scopeType: text('scope_type').notNull(), // sequence | sequence_step
    scopeId: uuid('scope_id').notNull(),
    metric: text('metric').notNull(), // email.delivered, calls.connected, ...
    value: bigint('value', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.scopeType, t.scopeId, t.metric] })],
);
