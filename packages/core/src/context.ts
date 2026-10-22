import type { DbOrTx } from '@cooks/db';
import type { JobsPort } from './jobs.js';
import type { Principal } from './principal.js';

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };

/** Everything a service needs. Built per request by the API, per job by the worker. */
export interface Ctx {
  db: DbOrTx;
  principal: Principal;
  jobs: JobsPort;
  clock: Clock;
  traceId: string;
  publicUrl: string;
}
