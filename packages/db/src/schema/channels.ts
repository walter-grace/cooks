import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, tenant, timestamps, workspaceId } from './_base.js';
import { accounts, prospects } from './crm.js';
import { sequenceStates, sequenceSteps, sequences, tasks } from './sequencing.js';

export const messageChannel = pgEnum('message_channel', ['sms', 'imessage', 'a2a']);
export const messageDirection = pgEnum('message_direction', ['outbound', 'inbound']);

/** A messaging provider connected to a workspace (Inkbox today). Secrets are encrypted with COOKS_KEK. */
export const channelConnections = pgTable(
  'channel_connections',
  {
    id: id(),
    workspaceId: workspaceId(),
    provider: text('provider').notNull().default('inkbox'),
    apiKeyEncrypted: text('api_key_encrypted').notNull(),
    /** Bearer token Inkbox sends on every delivery to /webhooks/inkbox (subscription auth_token). */
    webhookTokenEncrypted: text('webhook_token_encrypted'),
    status: text('status').notNull().default('connected'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex('channel_connections_ws_provider_uq').on(t.workspaceId, t.provider)],
);

/** One Inkbox identity (handle + email + phone + iMessage line), optionally mapped to a Cooks user. */
export const channelIdentities = pgTable(
  'channel_identities',
  {
    id: id(),
    workspaceId: workspaceId(),
    provider: text('provider').notNull().default('inkbox'),
    externalId: text('external_id').notNull(),
    handle: text('handle').notNull(),
    displayName: text('display_name'),
    emailAddress: text('email_address'),
    phoneNumber: text('phone_number'),
    phoneNumberId: text('phone_number_id'),
    smsStatus: text('sms_status'),
    imessageNumber: text('imessage_number'),
    imessageNumberId: text('imessage_number_id'),
    /** Cooks user this identity sends as (owner of tasks created from its inbound). */
    userId: uuid('user_id'),
    /** Mailbox row created for the identity email so sequences can send through it. */
    mailboxId: uuid('mailbox_id'),
    /** Identity signing key for X-Inkbox-Signature, encrypted; returned once by Inkbox. */
    signingKeyEncrypted: text('signing_key_encrypted'),
    subscriptionIds: jsonb('subscription_ids').$type<string[]>().notNull().default([]),
    raw: jsonb('raw').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex('channel_identities_ws_ext_uq').on(t.workspaceId, t.provider, t.externalId), index('channel_identities_ws_user_idx').on(t.workspaceId, t.userId)],
);

/** SMS, iMessage and agent-to-agent messages (email stays in `emails`). */
export const messages = pgTable(
  'messages',
  {
    ...tenant(),
    prospectId: uuid('prospect_id').references(() => prospects.id, { onDelete: 'set null' }),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    ownerId: uuid('owner_id'),
    identityId: uuid('identity_id').references(() => channelIdentities.id, { onDelete: 'set null' }),
    sequenceId: uuid('sequence_id').references(() => sequences.id, { onDelete: 'set null' }),
    sequenceStateId: uuid('sequence_state_id').references(() => sequenceStates.id, { onDelete: 'set null' }),
    sequenceStepId: uuid('sequence_step_id').references(() => sequenceSteps.id, { onDelete: 'set null' }),
    taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
    channel: messageChannel('channel').notNull(),
    direction: messageDirection('direction').notNull().default('outbound'),
    /** queued | sent | delivered | failed | blocked | received */
    status: text('status').notNull().default('queued'),
    fromAddr: text('from_addr'),
    toAddr: text('to_addr'),
    body: text('body'),
    mediaUrls: jsonb('media_urls').$type<string[]>().notNull().default([]),
    provider: text('provider'),
    providerMessageId: text('provider_message_id'),
    conversationId: text('conversation_id'),
    threadId: text('thread_id'),
    inReplyTo: text('in_reply_to'),
    error: text('error'),
    /** Why an outbound send was skipped: opted_out, not_opted_in, quiet_hours, contact_rule, do_not_contact, no_phone */
    blockReason: text('block_reason'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    repliedAt: timestamp('replied_at', { withTimezone: true }),
    autoSubmitted: boolean('auto_submitted').notNull().default(false),
    raw: jsonb('raw').$type<Record<string, unknown>>(),
  },
  (t) => [
    index('messages_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('messages_ws_prospect_idx').on(t.workspaceId, t.prospectId),
    index('messages_ws_state_idx').on(t.workspaceId, t.sequenceStateId),
    uniqueIndex('messages_ws_provider_msg_uq').on(t.workspaceId, t.provider, t.providerMessageId),
  ],
);

/** Dedupe ledger for provider webhook events (Inkbox evt_… ids). */
export const inboundEvents = pgTable(
  'inbound_events',
  {
    id: id(),
    workspaceId: workspaceId(),
    provider: text('provider').notNull(),
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('inbound_events_uq').on(t.workspaceId, t.provider, t.eventId)],
);
