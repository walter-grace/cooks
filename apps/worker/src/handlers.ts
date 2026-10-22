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
import { classifyReply, draftEmailForTask, researchProspect, type EnvKeys } from '@cooks/agent';
import { applyClassification, loadCreds, outboundProviderFor, registerOAuthInbound, syncMailbox, syncableMailboxIds, type ConnectorApps } from '@cooks/core';
import { emails as emailsTable, prospects as prospectsTable, accounts as accountsTable } from '@cooks/db';
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
  aiEnv: EnvKeys;
  connectorApps: ConnectorApps;
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
  registerOAuthInbound({ db: deps.db, kek: deps.kek, apps: deps.connectorApps });
  const providerCache = new Map<string, MailProvider>();
  const providerFor = async (mailbox: Parameters<typeof outboundProviderFor>[1] | null): Promise<MailProvider> => {
    if (!mailbox) return deps.mailProvider;
    const cached = providerCache.get(mailbox.id);
    if (cached) return cached;
    const creds = await loadCreds(mkCtx(deps, mailbox.workspaceId), mailbox.id, deps.kek);
    const p = outboundProviderFor({ db: deps.db, kek: deps.kek, apps: deps.connectorApps, fallback: deps.mailProvider }, mailbox, creds);
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
  // inbox.sync with no mailboxId fans out to every connected mailbox (cron); with one it syncs that mailbox.
  void work<{ mailboxId?: string; workspaceId?: string }>('inbox.sync', async (job) => {
    if (job.data.mailboxId && job.data.workspaceId) return syncMailbox(mkCtx(deps, job.data.workspaceId), job.data.mailboxId, { kek: deps.kek, classify: hasAi(deps.aiEnv) });
    const all = await syncableMailboxIds(mkCtx(deps, 'system'));
    for (const m of all) await deps.jobs.send('inbox.sync', { mailboxId: m.id, workspaceId: m.workspaceId }, { singletonKey: `inbox:${m.id}` });
    return { fanned: all.length };
  }, 1);
  void work<{ inboundEmailId: string; taskId: string | null; workspaceId: string }>('ai.classify_reply', async (job) => {
    const ctx = mkCtx(deps, job.data.workspaceId);
    const [inb] = await deps.db.select().from(emailsTable).where(eq(emailsTable.id, job.data.inboundEmailId)).limit(1);
    if (!inb) return { skipped: 'missing' };
    const [out] = inb.inReplyTo ? await deps.db.select().from(emailsTable).where(eq(emailsTable.messageId, inb.inReplyTo)).limit(1) : [];
    const [p] = inb.prospectId ? await deps.db.select().from(prospectsTable).where(eq(prospectsTable.id, inb.prospectId)).limit(1) : [];
    const [a] = p?.accountId ? await deps.db.select().from(accountsTable).where(eq(accountsTable.id, p.accountId)).limit(1) : [];
    const result = await classifyReply(
      { db: deps.db, env: deps.aiEnv, now: () => new Date(), workspaceId: job.data.workspaceId },
      {
        outbound: out ? { subject: out.subject ?? '', text: (out.bodyText ?? '').slice(0, 4000), sentAt: out.date?.toISOString() ?? '' } : null,
        reply: { from: inb.fromAddr ?? '', subject: inb.subject ?? '', text: (inb.bodyText ?? '').slice(0, 6000), receivedAt: inb.date?.toISOString() ?? '', autoSubmitted: inb.autoSubmitted },
        prospect: { name: p?.name ?? null, title: p?.title ?? null, company: a?.name ?? null },
      },
      { type: 'email', id: inb.id },
    );
    if (result.status !== 'ok' && result.status !== 'needs_review') return { skipped: result.status };
    return applyClassification(ctx, { inboundEmailId: inb.id, taskId: job.data.taskId, result: result.value, reviewed: result.status === 'needs_review' });
  }, 2);
  void work<{ prospectId: string; workspaceId: string; focus?: string | null; force?: boolean }>('ai.research', (job) => researchProspect({ db: deps.db, env: deps.aiEnv, now: () => new Date() }, job.data.prospectId, { focus: job.data.focus, force: job.data.force }), 2);
  void work<{ taskId: string; workspaceId: string }>('ai.draft_email', (job) => draftEmailForTask({ db: deps.db, env: deps.aiEnv, now: () => new Date() }, job.data.taskId), 2);
  void work<Record<string, never>>('outbox.publish', async () => ({ published: await publishOutbox(deps.db, deps.jobs) }), 1);
  void work<Record<string, never>>('enrollment.start_pending', async () => ({ promoted: await startPendingEnrollments(mkCtx(deps, 'system')) }), 1);
}

const hasAi = (e: EnvKeys) => !!(e.ANTHROPIC_API_KEY || e.XAI_API_KEY || e.OPENAI_API_KEY || e.OPENROUTER_API_KEY || e.OLLAMA_BASE_URL);

export async function registerSchedules(boss: PgBoss) {
  await boss.schedule('enrollment.start_pending', '* * * * *', {}, { tz: 'UTC' });
  await boss.schedule('inbox.sync', '*/2 * * * *', {}, { tz: 'UTC' });
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
