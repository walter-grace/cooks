import { createHash, randomBytes } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { SignJWT, createLocalJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { oauthAuthorizationCodes, oauthClients, oauthConsents, oauthRefreshTokens, type DbOrTx } from '@cooks/db';
import type { ActiveKey } from './keys.js';
import { publicJwks } from './keys.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const b64url = (b: Buffer) => b.toString('base64url');

export const ACCESS_TOKEN_TTL_S = 3600;
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 3600;
export const CODE_TTL_S = 600;
export const DEFAULT_AUDIENCE = 'cooks-api';

export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    description: string,
    public readonly status = 400,
  ) {
    super(description);
  }
  body() {
    return { error: this.error, error_description: this.message };
  }
}

export interface Client {
  clientId: string;
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
  clientSecretHash: string | null;
  allowedScopes: string[] | null;
}

function isAllowedRedirect(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
    // native app custom schemes, e.g. cursor://, vscode://
    return !['http:', 'https:', 'javascript:', 'data:'].includes(u.protocol) && !!u.protocol;
  } catch {
    return false;
  }
}

/** RFC 7591 dynamic client registration (public clients by default). */
export async function registerClient(
  db: DbOrTx,
  body: { client_name?: string; redirect_uris?: string[]; token_endpoint_auth_method?: string; grant_types?: string[]; scope?: string },
): Promise<Record<string, unknown>> {
  const uris = body.redirect_uris ?? [];
  if (!uris.length || !uris.every(isAllowedRedirect)) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https, localhost http, or a native app scheme');
  const method = body.token_endpoint_auth_method ?? 'none';
  if (!['none', 'client_secret_post'].includes(method)) throw new OAuthError('invalid_client_metadata', 'token_endpoint_auth_method must be none or client_secret_post');
  const clientId = `cooks_${randomBytes(12).toString('hex')}`;
  const secret = method === 'client_secret_post' ? randomBytes(32).toString('base64url') : null;
  await db.insert(oauthClients).values({
    clientId,
    clientSecretHash: secret ? sha256(secret) : null,
    name: body.client_name ?? 'Unnamed client',
    redirectUris: uris,
    grantTypes: body.grant_types ?? ['authorization_code', 'refresh_token'],
    tokenEndpointAuthMethod: method,
    allowedScopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : null,
    isDynamic: true,
  });
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name ?? 'Unnamed client',
    redirect_uris: uris,
    token_endpoint_auth_method: method,
    grant_types: body.grant_types ?? ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

export async function getClient(db: DbOrTx, clientId: string): Promise<Client | null> {
  const [c] = await db.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).limit(1);
  return c ? { clientId: c.clientId, name: c.name, redirectUris: c.redirectUris, tokenEndpointAuthMethod: c.tokenEndpointAuthMethod, clientSecretHash: c.clientSecretHash, allowedScopes: c.allowedScopes } : null;
}

export interface AuthorizeParams {
  client_id?: string;
  redirect_uri?: string;
  response_type?: string;
  scope?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  resource?: string;
}

/** Validate /oauth/authorize inputs. Errors before redirect_uri is trusted are shown, not redirected. */
export async function validateAuthorize(db: DbOrTx, p: AuthorizeParams, knownScopes: readonly string[]) {
  if (!p.client_id) throw new OAuthError('invalid_request', 'client_id is required');
  const client = await getClient(db, p.client_id);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client_id', 401);
  if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
  if (p.response_type !== 'code') throw new OAuthError('unsupported_response_type', 'response_type must be code');
  if (!p.code_challenge) throw new OAuthError('invalid_request', 'code_challenge is required (PKCE)');
  if ((p.code_challenge_method ?? 'plain') !== 'S256') throw new OAuthError('invalid_request', 'code_challenge_method must be S256');
  const scopes = (p.scope ?? '').split(/\s+/).filter(Boolean);
  if (!scopes.length) throw new OAuthError('invalid_scope', 'scope is required');
  const unknown = scopes.filter((s) => !knownScopes.includes(s));
  if (unknown.length) throw new OAuthError('invalid_scope', `Unknown scopes: ${unknown.join(', ')}`);
  if (client.allowedScopes) {
    const denied = scopes.filter((s) => !client.allowedScopes!.includes(s));
    if (denied.length) throw new OAuthError('invalid_scope', `Client may not request: ${denied.join(', ')}`);
  }
  return { client, scopes };
}

export async function hasConsent(db: DbOrTx, userId: string, clientId: string, workspaceId: string, scopes: string[]) {
  const [c] = await db
    .select()
    .from(oauthConsents)
    .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId), eq(oauthConsents.workspaceId, workspaceId)))
    .limit(1);
  return !!c && scopes.every((s) => c.scopes.includes(s));
}

export async function grantConsent(db: DbOrTx, userId: string, clientId: string, workspaceId: string, scopes: string[]) {
  const [existing] = await db
    .select()
    .from(oauthConsents)
    .where(and(eq(oauthConsents.userId, userId), eq(oauthConsents.clientId, clientId), eq(oauthConsents.workspaceId, workspaceId)))
    .limit(1);
  const merged = [...new Set([...(existing?.scopes ?? []), ...scopes])];
  if (existing) await db.update(oauthConsents).set({ scopes: merged, grantedAt: new Date() }).where(eq(oauthConsents.id, existing.id));
  else await db.insert(oauthConsents).values({ userId, clientId, workspaceId, scopes: merged });
}

export async function createAuthorizationCode(
  db: DbOrTx,
  a: { clientId: string; userId: string; workspaceId: string; scopes: string[]; codeChallenge: string; redirectUri: string; resource?: string; now?: Date },
): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  const now = a.now ?? new Date();
  await db.insert(oauthAuthorizationCodes).values({
    codeHash: sha256(code),
    clientId: a.clientId,
    userId: a.userId,
    workspaceId: a.workspaceId,
    scopes: a.scopes,
    codeChallenge: a.codeChallenge,
    codeChallengeMethod: 'S256',
    redirectUri: a.redirectUri,
    resource: a.resource ?? null,
    expiresAt: new Date(now.getTime() + CODE_TTL_S * 1000),
  });
  return code;
}

export interface TokenIssuer {
  issuer: string;
  key: ActiveKey;
}

export interface TokenSet {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issueTokens(
  db: DbOrTx,
  iss: TokenIssuer,
  a: { userId: string; workspaceId: string; clientId: string; scopes: string[]; resource?: string | null; role: string | null; familyId?: string; rotatedFrom?: string; now?: Date },
): Promise<TokenSet> {
  const now = a.now ?? new Date();
  const jti = randomBytes(16).toString('hex');
  const access = await new SignJWT({ ws: a.workspaceId, cid: a.clientId, scope: a.scopes.join(' '), role: a.role, jti })
    .setProtectedHeader({ alg: 'ES256', kid: iss.key.kid, typ: 'at+jwt' })
    .setIssuer(iss.issuer)
    .setSubject(a.userId)
    .setAudience(a.resource ?? DEFAULT_AUDIENCE)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + ACCESS_TOKEN_TTL_S)
    .sign(iss.key.privateKey);
  const refresh = randomBytes(32).toString('base64url');
  await db.insert(oauthRefreshTokens).values({
    familyId: a.familyId ?? randomBytes(12).toString('hex'),
    tokenHash: sha256(refresh),
    clientId: a.clientId,
    userId: a.userId,
    workspaceId: a.workspaceId,
    scopes: a.scopes,
    resource: a.resource ?? null,
    expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_S * 1000),
    rotatedFrom: a.rotatedFrom ?? null,
  });
  return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: a.scopes.join(' ') };
}

async function authenticateClient(db: DbOrTx, clientId: string | undefined, clientSecret: string | undefined): Promise<Client> {
  if (!clientId) throw new OAuthError('invalid_client', 'client_id is required', 401);
  const client = await getClient(db, clientId);
  if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
  if (client.tokenEndpointAuthMethod === 'client_secret_post') {
    if (!clientSecret || !client.clientSecretHash || sha256(clientSecret) !== client.clientSecretHash) throw new OAuthError('invalid_client', 'Bad client secret', 401);
  }
  return client;
}

export async function exchangeAuthorizationCode(
  db: DbOrTx,
  iss: TokenIssuer,
  p: { code?: string; client_id?: string; client_secret?: string; redirect_uri?: string; code_verifier?: string },
  roleOf: (workspaceId: string, userId: string) => Promise<string | null>,
  now = new Date(),
): Promise<TokenSet> {
  const client = await authenticateClient(db, p.client_id, p.client_secret);
  if (!p.code) throw new OAuthError('invalid_request', 'code is required');
  if (!p.code_verifier) throw new OAuthError('invalid_request', 'code_verifier is required');
  const [row] = await db.select().from(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.codeHash, sha256(p.code))).limit(1);
  if (!row || row.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'Unknown authorization code');
  if (row.usedAt) {
    // Replay: revoke anything issued from this code's family is not tracked; refuse loudly.
    throw new OAuthError('invalid_grant', 'Authorization code already used');
  }
  if (row.expiresAt < now) throw new OAuthError('invalid_grant', 'Authorization code expired');
  if (row.redirectUri !== p.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri mismatch');
  if (b64url(createHash('sha256').update(p.code_verifier).digest()) !== row.codeChallenge) throw new OAuthError('invalid_grant', 'PKCE verification failed');
  await db.update(oauthAuthorizationCodes).set({ usedAt: now }).where(eq(oauthAuthorizationCodes.codeHash, row.codeHash));
  const role = await roleOf(row.workspaceId, row.userId);
  return issueTokens(db, iss, { userId: row.userId, workspaceId: row.workspaceId, clientId: client.clientId, scopes: row.scopes, resource: row.resource, role, now });
}

/** Rotating refresh: reuse of an already-rotated token revokes the whole family. */
export async function refreshAccessToken(
  db: DbOrTx,
  iss: TokenIssuer,
  p: { refresh_token?: string; client_id?: string; client_secret?: string; scope?: string },
  roleOf: (workspaceId: string, userId: string) => Promise<string | null>,
  now = new Date(),
): Promise<TokenSet> {
  const client = await authenticateClient(db, p.client_id, p.client_secret);
  if (!p.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required');
  const [row] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, sha256(p.refresh_token))).limit(1);
  if (!row || row.clientId !== client.clientId) throw new OAuthError('invalid_grant', 'Unknown refresh token');
  if (row.revokedAt) {
    await db.update(oauthRefreshTokens).set({ revokedAt: now }).where(eq(oauthRefreshTokens.familyId, row.familyId));
    throw new OAuthError('invalid_grant', 'Refresh token reuse detected; all sessions for this grant were revoked');
  }
  if (row.expiresAt < now) throw new OAuthError('invalid_grant', 'Refresh token expired');
  let scopes = row.scopes;
  if (p.scope) {
    const requested = p.scope.split(/\s+/).filter(Boolean);
    if (requested.some((s) => !row.scopes.includes(s))) throw new OAuthError('invalid_scope', 'Cannot widen scope on refresh');
    scopes = requested;
  }
  await db.update(oauthRefreshTokens).set({ revokedAt: now }).where(eq(oauthRefreshTokens.id, row.id));
  const role = await roleOf(row.workspaceId, row.userId);
  return issueTokens(db, iss, { userId: row.userId, workspaceId: row.workspaceId, clientId: client.clientId, scopes, resource: row.resource, role, familyId: row.familyId, rotatedFrom: row.id, now });
}

export async function revokeToken(db: DbOrTx, token: string, now = new Date()): Promise<void> {
  const [row] = await db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, sha256(token))).limit(1);
  if (row) await db.update(oauthRefreshTokens).set({ revokedAt: now }).where(eq(oauthRefreshTokens.familyId, row.familyId));
  // Access tokens are stateless; revocation takes effect at expiry (1 h).
}

export interface AccessClaims extends JWTPayload {
  ws: string;
  cid: string;
  scope: string;
  role: string | null;
}

/** Verify an access token against the local JWKS. Audiences: the API itself or the MCP resource. */
export async function verifyAccessToken(db: DbOrTx, token: string, issuer: string, audiences: string[], now: Date = new Date()): Promise<AccessClaims | null> {
  try {
    const jwks = createLocalJWKSet(await publicJwks(db));
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: audiences, currentDate: now });
    if (typeof payload.ws !== 'string' || typeof payload.cid !== 'string' || typeof payload.scope !== 'string') return null;
    return payload as AccessClaims;
  } catch {
    return null;
  }
}

export function authorizationServerMetadata(issuer: string, scopes: readonly string[], opts: { dcr: boolean }) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    ...(opts.dcr ? { registration_endpoint: `${issuer}/oauth/register` } : {}),
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    scopes_supported: [...scopes],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    service_documentation: `${issuer}/docs`,
  };
}
