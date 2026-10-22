import type { Context } from 'hono';
import { nestBracketQuery, pageArgs } from '@cooks/core';
import type { AppEnv } from '../types.js';

/** Common list arguments from the raw query string (bracket keys nested). */
export function listArgs(c: Context<AppEnv>) {
  const raw = c.req.query();
  const nested = nestBracketQuery(raw);
  return {
    page: pageArgs(raw),
    filter: (nested.filter ?? {}) as Record<string, unknown>,
    include: raw.include,
    includeCRMCustomFields: raw.includeCRMCustomFields,
    requestUrl: c.req.url,
  };
}
