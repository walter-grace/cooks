export type ErrorCode =
  | 'BAD_REQUEST'
  | 'NO_CRM_CONNECTION'
  | 'UNAUTHORIZED'
  | 'INSUFFICIENT_SCOPE'
  | 'INSUFFICIENT_PERMISSION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNPROCESSABLE_ENTITY'
  | 'RATE_LIMIT_EXCEEDED'
  | 'INTERNAL_ERROR';

export class CooksError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CooksError';
  }
  toBody(traceId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details !== undefined ? { details: this.details } : {}),
        ...(this.extra ?? {}),
      },
      traceId,
    };
  }
}

export const badRequest = (message: string, details?: unknown) => new CooksError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Missing or invalid credentials') => new CooksError(401, 'UNAUTHORIZED', message);
export const insufficientScope = (scope: string) =>
  new CooksError(403, 'INSUFFICIENT_SCOPE', `This operation requires the ${scope} scope`, undefined, { requiredScope: scope });
export const insufficientPermission = (message = 'You do not have permission to perform this action') =>
  new CooksError(403, 'INSUFFICIENT_PERMISSION', message);
export const notFound = (what = 'Resource') => new CooksError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string, details?: unknown) => new CooksError(409, 'CONFLICT', message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new CooksError(422, 'UNPROCESSABLE_ENTITY', message, details);
export const rateLimited = (retryAfterSeconds: number) =>
  new CooksError(429, 'RATE_LIMIT_EXCEEDED', 'Rate limit exceeded', undefined, { retryAfterSeconds });
export const noCrmConnection = (integrationType: string) =>
  new CooksError(400, 'NO_CRM_CONNECTION', `No ${integrationType} connection is configured for this workspace`, undefined, {
    integrationType,
  });
export const internal = (message = 'Internal error') => new CooksError(500, 'INTERNAL_ERROR', message);

export function isCooksError(e: unknown): e is CooksError {
  return e instanceof CooksError;
}

/** Translate a Postgres unique-violation into a domain error when it matches a known constraint. */
export function pgConstraint(e: unknown): string | undefined {
  const err = e as { cause?: { constraint_name?: string; constraint?: string; message?: string }; message?: string };
  const c = err?.cause;
  if (c?.constraint_name) return c.constraint_name;
  if (c?.constraint) return c.constraint;
  const m = /constraint "([^"]+)"/.exec(`${c?.message ?? ''} ${err?.message ?? ''}`);
  return m?.[1];
}
