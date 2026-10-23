import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, tenant, timestamps, workspaceId } from './_base.js';

export const crmType = pgEnum('crm_type', ['none', 'csv', 'salesforce', 'hubspot']);
export const associatedType = pgEnum('associated_type', ['prospect', 'account']);
export const contactPointKind = pgEnum('contact_point_kind', ['email', 'phone']);
export const emailStatus = pgEnum('prospect_email_status', ['unknown', 'valid', 'invalid', 'bounced', 'unsubscribed']);

export const accounts = pgTable(
  'accounts',
  {
    ...tenant(),
    name: text('name'),
    domain: text('domain'),
    numEmployees: integer('num_employees'),
    linkedInUrl: text('linkedin_url'),
    description: text('description'),
    industry: text('industry'),
    website: text('website'),
    city: text('city'),
    timezone: text('timezone'),
    crmId: text('crm_id'),
    crmType: crmType('crm_type'),
    crmCustomFields: jsonb('crm_custom_fields').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index('accounts_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('accounts_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('accounts_ws_domain_idx').on(t.workspaceId, t.domain),
    index('accounts_ws_crm_idx').on(t.workspaceId, t.crmId),
    index('accounts_ws_name_idx').on(t.workspaceId, sql`lower(${t.name})`),
  ],
);

export const prospects = pgTable(
  'prospects',
  {
    ...tenant(),
    accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
    firstName: text('first_name'),
    lastName: text('last_name'),
    name: text('name'),
    title: text('title'),
    primaryEmail: text('primary_email'),
    phone: text('phone'),
    linkedInUrl: text('linkedin_url'),
    city: text('city'),
    state: text('state'),
    country: text('country'),
    timezone: text('timezone'),
    crmId: text('crm_id'),
    crmType: crmType('crm_type'),
    crmCustomFields: jsonb('crm_custom_fields').$type<Record<string, unknown>>().notNull().default({}),
    emailStatus: emailStatus('email_status').notNull().default('unknown'),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    doNotContact: boolean('do_not_contact').notNull().default(false),
    /** Set when the prospect texted STOP (or was opted out through the API). Blocks SMS and iMessage. */
    smsOptOutAt: timestamp('sms_opt_out_at', { withTimezone: true }),
    ownerId: uuid('owner_id'),
  },
  (t) => [
    index('prospects_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
    index('prospects_ws_updated_idx').on(t.workspaceId, t.updatedAt),
    index('prospects_ws_email_idx').on(t.workspaceId, sql`lower(${t.primaryEmail})`),
    index('prospects_ws_crm_idx').on(t.workspaceId, t.crmId),
    index('prospects_ws_account_idx').on(t.workspaceId, t.accountId),
    index('prospects_ws_name_idx').on(t.workspaceId, sql`lower(${t.name})`),
    index('prospects_ws_title_idx').on(t.workspaceId, sql`lower(${t.title})`),
  ],
);

export const prospectContactPoints = pgTable(
  'prospect_contact_points',
  {
    id: id(),
    workspaceId: workspaceId(),
    prospectId: uuid('prospect_id')
      .notNull()
      .references(() => prospects.id, { onDelete: 'cascade' }),
    kind: contactPointKind('kind').notNull(),
    value: text('value').notNull(),
    isPrimary: boolean('is_primary').notNull().default(false),
    source: text('source'),
    ...timestamps,
  },
  (t) => [uniqueIndex('prospect_contact_points_uq').on(t.workspaceId, t.prospectId, t.kind, t.value)],
);

export const tags = pgTable(
  'tags',
  {
    ...tenant(),
    name: text('name').notNull(),
  },
  (t) => [
    uniqueIndex('tags_ws_name_ci_uq')
      .on(t.workspaceId, sql`lower(${t.name})`)
      .where(sql`${t.deletedAt} IS NULL`),
    index('tags_ws_created_idx').on(t.workspaceId, t.createdAt, t.id),
  ],
);

export const notes = pgTable(
  'notes',
  {
    ...tenant(),
    associatedType: associatedType('associated_type').notNull(),
    associatedId: uuid('associated_id').notNull(),
    text: text('text').notNull(),
    integrationType: text('integration_type').notNull(),
    externalId: text('external_id'),
    userExternalId: text('user_external_id'),
    userName: text('user_name'),
    createdBy: uuid('created_by'),
    externalCreatedAt: timestamp('external_created_at', { withTimezone: true }),
    externalUpdatedAt: timestamp('external_updated_at', { withTimezone: true }),
  },
  (t) => [index('notes_ws_assoc_idx').on(t.workspaceId, t.associatedType, t.associatedId)],
);

/** Schema only in v1 (opportunities:read scope exists upstream, no endpoint). */
export const opportunities = pgTable('opportunities', {
  ...tenant(),
  accountId: uuid('account_id').references(() => accounts.id, { onDelete: 'set null' }),
  prospectId: uuid('prospect_id').references(() => prospects.id, { onDelete: 'set null' }),
  name: text('name'),
  stage: text('stage'),
  amountCents: integer('amount_cents'),
  closeDate: timestamp('close_date', { withTimezone: true }),
  crmId: text('crm_id'),
  crmCustomFields: jsonb('crm_custom_fields').$type<Record<string, unknown>>().notNull().default({}),
});

export const crmConnections = pgTable(
  'crm_connections',
  {
    id: id(),
    workspaceId: workspaceId(),
    type: crmType('type').notNull().default('none'),
    status: text('status').notNull().default('disconnected'),
    credentialsEncrypted: text('credentials_encrypted'),
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [uniqueIndex('crm_connections_ws_uq').on(t.workspaceId)],
);
