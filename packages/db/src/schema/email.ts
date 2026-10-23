import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid, boolean, date } from 'drizzle-orm/pg-core';
import { id, tenant, timestamps, workspaceId } from './_base.js';
import { prospects } from './crm.js';
import { sequenceStates, sequenceSteps, sequences, tasks } from './sequencing.js';

export const mailboxProvider = pgEnum('mailbox_provider', ['smtp', 'gmail', 'ms_graph', 'inkbox']);
export const emailDirection = pgEnum('email_direction', ['outbound', 'inbound']);
export const emailSendStatus = pgEnum('email_send_status', [
  'draft',
  'queued',
  'sending',
  'sent',
  'failed',
  'rejected',
  'received',
]);
export const emailEventKind = pgEnum('email_event_kind', [
  'sent',
  'delivered',
  'opened',
  'clicked',
  'bounced',
  'replied',
  'unsubscribed',
  'complained',
]);
export const suppressionReason = pgEnum('suppression_reason', ['unsubscribe', 'hard_bounce', 'manual', 'complaint']);

export const mailboxes = pgTable(
  'mailboxes',
  {
    ...tenant(),
    userId: uuid('user_id').notNull(),
    email: text('email').notNull(),
    provider: mailboxProvider('provider').notNull().default('smtp'),
    isDefault: boolean('is_default').notNull().default(false),
    status: text('status').notNull().default('connected'),
    dailySendLimit: integer('daily_send_limit').notNull().default(50),
    minGapSeconds: integer('min_gap_seconds').notNull().default(60),
    signatureHtml: text('signature_html'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    uniqueIndex('mailboxes_ws_email_uq').on(t.workspaceId, t.email),
    index('mailboxes_ws_user_idx').on(t.workspaceId, t.userId),
    index('mailboxes_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('mailboxes_ws_updated_idx').on(t.workspaceId, t.updatedAt),
  ],
);

export const mailboxCredentials = pgTable('mailbox_credentials', {
  mailboxId: uuid('mailbox_id')
    .primaryKey()
    .references(() => mailboxes.id, { onDelete: 'cascade' }),
  encrypted: text('encrypted').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  syncCursor: jsonb('sync_cursor').$type<Record<string, unknown>>(),
  ...timestamps,
});

export const mailboxSendState = pgTable('mailbox_send_state', {
  mailboxId: uuid('mailbox_id')
    .primaryKey()
    .references(() => mailboxes.id, { onDelete: 'cascade' }),
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }),
  dayDate: date('day_date'),
  dayCount: integer('day_count').notNull().default(0),
});

export const emails = pgTable(
  'emails',
  {
    ...tenant(),
    prospectId: uuid('prospect_id').references(() => prospects.id, { onDelete: 'set null' }),
    accountId: uuid('account_id'),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    sequenceId: uuid('sequence_id').references(() => sequences.id, { onDelete: 'set null' }),
    sequenceStateId: uuid('sequence_state_id').references(() => sequenceStates.id, { onDelete: 'set null' }),
    sequenceStepId: uuid('sequence_step_id').references(() => sequenceSteps.id, { onDelete: 'set null' }),
    mailboxId: uuid('mailbox_id').references(() => mailboxes.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id'),
    /** provider label surfaced as `type` upstream: gmail | outlook | smtp */
    type: text('type'),
    direction: emailDirection('direction').notNull().default('outbound'),
    status: emailSendStatus('status').notNull().default('draft'),
    fromAddr: text('from_addr'),
    toAddr: text('to_addr'),
    recipients: jsonb('recipients').$type<string[]>().notNull().default([]),
    cc: jsonb('cc').$type<string[]>().notNull().default([]),
    bcc: jsonb('bcc').$type<string[]>().notNull().default([]),
    subject: text('subject'),
    bodyText: text('body_text'),
    bodyHtml: text('body_html'),
    messageId: text('message_id'),
    threadId: text('thread_id'),
    inReplyTo: text('in_reply_to'),
    providerMessageId: text('provider_message_id'),
    date: timestamp('date', { withTimezone: true }),
    sendStartedAt: timestamp('send_started_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    bouncedAt: timestamp('bounced_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    openCount: integer('open_count').notNull().default(0),
    clickCount: integer('click_count').notNull().default(0),
    rejectReason: text('reject_reason'),
    error: text('error'),
    /** delivery attempts so far; transient provider errors requeue until MAX_SEND_ATTEMPTS */
    sendAttempts: integer('send_attempts').notNull().default(0),
    variantId: uuid('variant_id'),
    autoSubmitted: boolean('auto_submitted').notNull().default(false),
  },
  (t) => [
    index('emails_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('emails_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('emails_ws_prospect_idx').on(t.workspaceId, t.prospectId),
    index('emails_ws_task_idx').on(t.workspaceId, t.taskId),
    index('emails_ws_status_idx').on(t.workspaceId, t.status),
    index('emails_ws_message_id_idx').on(t.workspaceId, t.messageId),
    index('emails_ws_thread_idx').on(t.workspaceId, t.threadId),
    index('emails_ws_state_idx').on(t.workspaceId, t.sequenceStateId),
  ],
);

export const emailEvents = pgTable(
  'email_events',
  {
    id: id(),
    workspaceId: workspaceId(),
    emailId: uuid('email_id')
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    kind: emailEventKind('kind').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),
    rolledUpAt: timestamp('rolled_up_at', { withTimezone: true }),
  },
  (t) => [
    index('email_events_email_idx').on(t.emailId, t.kind),
    index('email_events_pending_idx').on(t.workspaceId, t.occurredAt),
  ],
);

export const trackingLinks = pgTable(
  'tracking_links',
  {
    id: id(),
    workspaceId: workspaceId(),
    emailId: uuid('email_id')
      .notNull()
      .references(() => emails.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    url: text('url').notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('tracking_links_email_idx').on(t.emailId)],
);

export const suppressions = pgTable(
  'suppressions',
  {
    id: id(),
    workspaceId: workspaceId(),
    emailLower: text('email_lower'),
    domain: text('domain'),
    reason: suppressionReason('reason').notNull(),
    source: text('source'),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('suppressions_ws_email_uq').on(t.workspaceId, t.emailLower),
    index('suppressions_ws_domain_idx').on(t.workspaceId, t.domain),
  ],
);
