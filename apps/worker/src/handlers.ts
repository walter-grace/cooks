import type { PgBoss } from 'pg-boss';
import {
  advanceEnrollment,
  deliverWebhook,
  publishOutbox,
  executeStep,
  sendQueuedEmail,
  startPendingEnrollments,
  systemPrincipal,
  type Ctx,
  type JobsPort,
  type MailProvider,
} from '@cooks/core';
import { mailboxCredentials, type Db } from '@cooks/db';
import { eq } from 'drizzle-orm';
import { SmtpProvider, decrypt } from '@cooks/core';

export interface WorkerDeps {
  db: Db;
  jobs: JobsPort;
  publicUrl: string;
  mailProvider: MailProvider;
  fallbackFrom: string | null;
  trackingSecret: string;
  kek?: string;
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
  const providerCache = new Map<string, MailProvider>();
  const providerFor = async (mailbox: { id: string } | null): Promise<MailProvider> => {
    if (!mailbox || !deps.kek) return deps.mailProvider;
    const cached = providerCache.get(mailbox.id);
    if (cached) return cached;
    const [cred] = await deps.db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailbox.id)).limit(1);
    if (!cred) return deps.mailProvider;
    const { smtpUrl } = JSON.parse(decrypt(cred.encrypted, deps.kek)) as { smtpUrl?: string };
    const p = smtpUrl ? new SmtpProvider(smtpUrl) : deps.mailProvider;
    providerCache.set(mailbox.id, p);
    return p;
  };
  void work<{ emailId: string; workspaceId: string }>('email.send', (job) =>
    sendQueuedEmail(mkCtx(deps, job.data.workspaceId), job.data.emailId, {
      providerFor,
      fallbackFrom: deps.fallbackFrom,
      trackingSecret: deps.trackingSecret,
    }),
    1,
  );
  void work<{ deliveryId: string }>('webhook.deliver', (job) => deliverWebhook({ db: deps.db, jobs: deps.jobs, kek: deps.kek }, job.data.deliveryId), 5);
  void work<Record<string, never>>('outbox.publish', async () => ({ published: await publishOutbox(deps.db, deps.jobs) }), 1);
  void work<Record<string, never>>('enrollment.start_pending', async () => ({ promoted: await startPendingEnrollments(mkCtx(deps, 'system')) }), 1);
}

export async function registerSchedules(boss: PgBoss) {
  await boss.schedule('enrollment.start_pending', '* * * * *', {}, { tz: 'UTC' });
  await boss.schedule('outbox.publish', '* * * * *', {}, { tz: 'UTC' });
}

/** Low-latency outbox drain between the cron ticks. Safe with several workers (SKIP LOCKED). */
export function startOutboxLoop(deps: WorkerDeps, intervalMs = 2000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await publishOutbox(deps.db, deps.jobs);
      if (n > 0) deps.log('outbox.publish', { published: n });
    } catch (e) {
      deps.log('outbox.publish failed', { error: (e as Error).message });
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
