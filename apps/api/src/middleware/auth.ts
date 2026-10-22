import type { MiddlewareHandler } from 'hono';
import { ALL_SCOPES, unauthorized, type Principal } from '@cooks/core';
import { looksLikeApiKey, verifyApiKey } from '@cooks/auth';
import type { Db } from '@cooks/db';
import type { AppEnv } from '../types.js';

export interface AuthDeps {
  db: Db;
  acceptNooksPrefix: boolean;
  /** M4: verify OAuth JWTs. Until then JWT-shaped tokens are rejected with a clear message. */
  verifyJwt?: (token: string) => Promise<Principal | null>;
}

const PUBLIC_PATHS = new Set(['/v1/public-ip-list']);

export function authMiddleware(deps: AuthDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const header = c.req.header('authorization') ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!m) throw unauthorized('Send an API key or OAuth access token as `Authorization: Bearer <token>`');
    const token = m[1]!.trim();

    if (looksLikeApiKey(token)) {
      const v = await verifyApiKey(deps.db, token, { acceptNooksPrefix: deps.acceptNooksPrefix });
      if (!v) throw unauthorized('Invalid or revoked API key');
      const principal: Principal = {
        workspaceId: v.workspaceId,
        userId: null,
        role: null,
        authType: 'apiKey',
        clientId: null,
        apiKeyId: v.apiKeyId,
        scopes: ALL_SCOPES,
        bypassRoleChecks: true,
        email: null,
        name: v.name,
      };
      c.set('principal', principal);
      return next();
    }

    if (token.split('.').length === 3 && deps.verifyJwt) {
      const principal = await deps.verifyJwt(token);
      if (!principal) throw unauthorized('Invalid or expired access token');
      c.set('principal', principal);
      return next();
    }
    throw unauthorized('Unrecognized credential format');
  };
}
