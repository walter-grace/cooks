import type { MiddlewareHandler } from 'hono';
import { uuidv7 } from '@cooks/db';
import type { AppEnv } from '../types.js';

export const trace: MiddlewareHandler<AppEnv> = async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const traceId = incoming && /^[\w.-]{8,128}$/.test(incoming) ? incoming : uuidv7();
  c.set('traceId', traceId);
  c.header('x-trace-id', traceId);
  await next();
};
