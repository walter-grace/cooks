import { PgBoss } from 'pg-boss';
import type { JobName, JobOptions, JobsPort } from '@cooks/core';
import { withDefaultUser } from '@cooks/config';

/** Queue definitions. Policies follow the engine's idempotency design. */
export const QUEUES: Record<JobName, { policy?: string; retryLimit?: number; retryDelay?: number; retryBackoff?: boolean; expireInSeconds?: number }> = {
  'enrollment.advance': { policy: 'exclusive', retryLimit: 3, retryDelay: 5, retryBackoff: true, expireInSeconds: 120 },
  'step.execute': { policy: 'exclusive', retryLimit: 5, retryDelay: 10, retryBackoff: true, expireInSeconds: 300 },
  'email.send': { policy: 'exclusive', retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 300 },
  'inbox.sync': { policy: 'exclusive', retryLimit: 1, expireInSeconds: 600 },
  'inbound.process': { policy: 'standard', retryLimit: 3, retryBackoff: true },
  'enrollment.start_pending': { policy: 'singleton', retryLimit: 0, expireInSeconds: 120 },
  'mailbox.hold_release': { policy: 'singleton', retryLimit: 0 },
  'analytics.rollup': { policy: 'singleton', retryLimit: 0, expireInSeconds: 300 },
  'outbox.publish': { policy: 'singleton', retryLimit: 0, expireInSeconds: 120 },
  'webhook.deliver': { policy: 'standard', retryLimit: 0, expireInSeconds: 60 },
  'ai.draft_email': { policy: 'standard', retryLimit: 2, retryBackoff: true, expireInSeconds: 180 },
  'ai.classify_reply': { policy: 'standard', retryLimit: 2, retryBackoff: true, expireInSeconds: 180 },
  'ai.research': { policy: 'standard', retryLimit: 1, expireInSeconds: 300 },
  'ai.nba': { policy: 'standard', retryLimit: 1, expireInSeconds: 180 },
  'crm.sync': { policy: 'standard', retryLimit: 3, retryBackoff: true, expireInSeconds: 120 },
  'crm.poll': { policy: 'singleton', retryLimit: 0, expireInSeconds: 600 },
  'signals.evaluate': { policy: 'standard', retryLimit: 2, retryBackoff: true, expireInSeconds: 120 },
  'signals.scan': { policy: 'standard', retryLimit: 1, expireInSeconds: 300 },
  'signals.scan_due': { policy: 'singleton', retryLimit: 0, expireInSeconds: 300 },
  'telephony.recording': { policy: 'standard', retryLimit: 5, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  'telephony.ai_poll': { policy: 'standard', retryLimit: 3, retryDelay: 15, retryBackoff: true, expireInSeconds: 120 },
  'ai.coach_call': { policy: 'standard', retryLimit: 2, retryBackoff: true, expireInSeconds: 300 },
};

export async function createBoss(connectionString: string, opts: { schema?: string } = {}): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: withDefaultUser(connectionString), schema: opts.schema ?? 'pgboss', application_name: 'cooks' });
  boss.on('error', (e: unknown) => console.error('[pg-boss]', e));
  await boss.start();
  for (const [name, q] of Object.entries(QUEUES)) {
    await boss.createQueue(name, q as never).catch((e: Error) => {
      if (!/already exists/i.test(e.message)) throw e;
    });
  }
  return boss;
}

/** JobsPort over pg-boss. `send` returns null when a singleton/exclusive key already holds a job. */
export class PgBossJobs implements JobsPort {
  constructor(private boss: PgBoss) {}
  async send(name: JobName, data: Record<string, unknown>, opts: JobOptions = {}) {
    return this.boss.send(name, data, {
      ...(opts.startAfter ? { startAfter: opts.startAfter } : {}),
      ...(opts.singletonKey ? { singletonKey: opts.singletonKey } : {}),
      ...(opts.priority !== undefined ? { priority: opts.priority } : {}),
    });
  }
  async cancel(name: JobName, jobId: string) {
    await this.boss.cancel(name, jobId);
  }
}

export { PgBoss };
export type { PgBoss as Boss };
