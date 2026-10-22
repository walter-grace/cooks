import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, workspaceId } from './_base.js';

export const memberRole = pgEnum('member_role', ['user', 'manager', 'admin']);
export const apiKeyPrefix = pgEnum('api_key_prefix', ['cooks', 'nooks']);

export const workspaces = pgTable('workspaces', {
  id: id(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  /** send window, timezone, reply behavior, tracking flags, jitter, caps */
  settings: jsonb('settings').$type<WorkspaceSettings>().notNull().default({}),
  ...timestamps,
});

export interface WorkspaceSettings {
  timezone?: string;
  sendWindow?: { days: number[]; start: string; end: string };
  jitterSeconds?: number;
  replyBehavior?: 'finish' | 'pause' | 'continue';
  tracking?: { opens: boolean; clicks: boolean };
  minProspectGapHours?: number;
  requireUnsubscribeLink?: boolean;
}

export const users = pgTable(
  'users',
  {
    id: id(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    crmId: text('crm_id'),
    timezone: text('timezone'),
    title: text('title'),
    phone: text('phone'),
    calendarUrl: text('calendar_url'),
    signatureHtml: text('signature_html'),
    passwordHash: text('password_hash'),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_ci_uq').on(sql`lower(${t.email})`)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull(),
    role: memberRole('role').notNull().default('user'),
    ...timestamps,
  },
  (t) => [uniqueIndex('workspace_members_uq').on(t.workspaceId, t.userId)],
);

export const apiKeys = pgTable(
  'api_keys',
  {
    id: id(),
    workspaceId: workspaceId().references(() => workspaces.id, { onDelete: 'cascade' }),
    keyId: text('key_id').notNull().unique(),
    secretHash: text('secret_hash').notNull(),
    prefix: apiKeyPrefix('prefix').notNull().default('cooks'),
    name: text('name').notNull(),
    createdBy: uuid('created_by'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index('api_keys_ws_idx').on(t.workspaceId)],
);

export const oauthClients = pgTable('oauth_clients', {
  id: id(),
  workspaceId: text('workspace_id'),
  clientId: text('client_id').notNull().unique(),
  clientSecretHash: text('client_secret_hash'),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull().default([]),
  grantTypes: jsonb('grant_types').$type<string[]>().notNull().default(['authorization_code', 'refresh_token']),
  tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
  allowedScopes: jsonb('allowed_scopes').$type<string[]>(),
  isDynamic: boolean('is_dynamic').notNull().default(false),
  ...timestamps,
});

export const oauthAuthorizationCodes = pgTable('oauth_authorization_codes', {
  codeHash: text('code_hash').primaryKey(),
  clientId: text('client_id').notNull(),
  userId: uuid('user_id').notNull(),
  workspaceId: workspaceId(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  codeChallenge: text('code_challenge').notNull(),
  codeChallengeMethod: text('code_challenge_method').notNull().default('S256'),
  redirectUri: text('redirect_uri').notNull(),
  resource: text('resource'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamps.createdAt,
});

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: id(),
    familyId: text('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    clientId: text('client_id').notNull(),
    userId: uuid('user_id').notNull(),
    workspaceId: workspaceId(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    resource: text('resource'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedFrom: text('rotated_from'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('oauth_refresh_family_idx').on(t.familyId)],
);

export const oauthConsents = pgTable(
  'oauth_consents',
  {
    id: id(),
    userId: uuid('user_id').notNull(),
    clientId: text('client_id').notNull(),
    workspaceId: workspaceId(),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('oauth_consents_uq').on(t.userId, t.clientId, t.workspaceId)],
);

export const signingKeys = pgTable('signing_keys', {
  kid: text('kid').primaryKey(),
  alg: text('alg').notNull().default('ES256'),
  publicJwk: jsonb('public_jwk').notNull(),
  privateJwkEncrypted: text('private_jwk_encrypted').notNull(),
  createdAt: timestamps.createdAt,
  retiredAt: timestamp('retired_at', { withTimezone: true }),
});

export const sessions = pgTable('sessions', {
  id: id(),
  userId: uuid('user_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamps.createdAt,
});
