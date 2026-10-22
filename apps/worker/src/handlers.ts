import type { PgBoss } from 'pg-boss';
import {
  advanceEnrollment,
  executeStep,
  sendQueuedEmail,
  startPendingEnrollments,
  systemPrincipal,
  type Ctx,
  type JobsPort,
  type MailProvider,
} from '@cooks/core';
import type { Db } from '@cooks/db';

export interface WorkerDeps {
  db: Db;
  jobs: JobsPort;
  publicUrl: string;
  mailProvider: MailProvider;
  fallbackFrom: string | null;
  trackingSecret: string;
  log: (msg: string, data?: Record<string, unknown>) => void;
}

const mkCtx = (deps: WorkerDeps, workspaceId: string): Ctx => ({
  db: deps.db,
  principal: systemPrincipal(workspaceId),
  jobs: deps.jobs,
  clock: { now: () => new Date() },
  traceId: 'worker',
  publicUrl: deps.publicUrl,
});

type JobLike<T> = { id: string; name: string; data: T };

export function registerHandlers(boss: PgBoss, deps: WorkerDeps) {
  const work = <T>(name: string, fn: (job: JobLike<T>) => Promise<unknown>, batchSize = 5) =>
    boss.work<T>(name, { batchSize }, async (jobs: Array<JobLike<T>>) => {
      for (const job of jobs) {
        const started = Date.now();
        try {
          const result = await fn(job as JobLike<T>);
          deps.log(`${name} ok`, { id: job.id, ms: Date.now() - started, result });
        } catch (e) {
          deps.log(`${name} failed`, { id: job.id, error: (e as Error).message });
          throw e;
        }
      }
    });

  void work<{ stateId: string; workspaceId: string; prevDoneAt?: string }>('enrollment.advance', (job) =>
    advanceEnrollment(mkCtx(deps, job.data.workspaceId), job.data.stateId, job.data.prevDoneAt ? { prevDoneAt: new Date(job.data.prevDoneAt) } : {}),
  );
  void work<{ stateId: string; stepId: string; workspaceId: string }>('step.execute', (job) => executeStep(mkCtx(deps, job.data.workspaceId), job.data.stateId, job.data.stepId));
  void work<{ emailId: string; workspaceId: string }>('email.send', (job) =>
    sendQueuedEmail(mkCtx(deps, job.data.workspaceId), job.data.emailId, {
      providerFor: async () => deps.mailProvider,
      fallbackFrom: deps.fallbackFrom,
      trackingSecret: deps.trackingSecret,
    }),
    1,
  );
  void work<Record<string, never>>('enrollment.start_pending', async () => ({ promoted: await startPendingEnrollments(mkCtx(deps, 'system')) }), 1);
}

export async function registerSchedules(boss: PgBoss) {
  await boss.schedule('enrollment.start_pending', '* * * * *', {}, { tz: 'UTC' });
}
