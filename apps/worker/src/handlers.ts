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
  type TwilioEnv,
 pollAiCall, sweepDialSessions, InkboxMailProvider, inkboxFor, sendQueuedMessage, runAiCallStep, pollInkboxCall, signalFromMessageEvent } from '@cooks/core';
import { mailboxCredentials, type Db } from '@cooks/db';
import { accountsDueForScan, classifyReply, coachCall, draftEmailForTask, processCallRecording, researchProspect, scanAccount, type EnvKeys, type TranscribeEnv } from '@cooks/agent';
import { applyClassification, evaluateSignal, signalFromEmailEvent, loadCreds, logCallToHubspot, logCallTaskToHubspot, logEmailToHubspot, outboundProviderFor, registerOAuthInbound, runAutoEnrollRule, syncMailbox, syncableMailboxIds, type ConnectorApps, type CrmSettings } from '@cooks/core';
import { crmConnections } from '@cooks/db';
import { emails as emailsTable, prospects as prospectsTable, accounts as accountsTable } from '@cooks/db';
import { eq } from 'drizzle-orm';
import { SmtpProvider, decrypt, indexWorkspace } from '@cooks/core';
import { workspaces } from '@cooks/db';

export interface WorkerDeps {
  db: Db;
  jobs: JobsPort;
  publicUrl: string;
  mailProvider: MailProvider;
  fallbackFrom: string | null;
  trackingSecret: string;
  kek?: string;
  aiEnv: EnvKeys & TranscribeEnv;
  /** Twilio REST base override (mock) */
  telephonyApiBase?: string;
  /** Server-wide Twilio credentials (TWILIO_* env) */
  twilioEnv?: TwilioEnv;
  /** Speko server key + base override (mock) */
  spekoApiKey?: string;
  spekoApiBase?: string;
  /** Inkbox base override (mock) */
  inkboxApiBase?: string;
  connectorApps: ConnectorApps;
  hubspotApp?: { clientId: string; clientSecret: string };
  brokerToken?: (userId: string, provider: 'google' | 'microsoft' | 'hubspot') => Promise<{ refreshToken: string; accessToken?: string; expiresAt?: number; viaClerk?: boolean } | null>;
  brokerHubspotToken?: (clerkUserId: string) => Promise<{ accessToken: string; expiresAt?: number } | null>;
  /** Daily account scans: cadence and per-workspace cap (0 disables). */
  scanEveryDays?: number;
  scanPerWorkspace?: number;
  scanWithoutEnvKeys?: boolean;
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
  registerOAuthInbound({ db: deps.db, kek: deps.kek, apps: deps.connectorApps, brokerToken: deps.brokerToken });
  const providerCache = new Map<string, MailProvider>();
  const channelDeps = { kek: deps.kek, inkbox: { apiBase: deps.inkboxApiBase }, publicUrl: deps.publicUrl };
  const providerFor = async (mailbox: Parameters<typeof outboundProviderFor>[1] | null): Promise<MailProvider> => {
    if (!mailbox) return deps.mailProvider;
    const cached = providerCache.get(mailbox.id);
    if (cached) return cached;
    if (mailbox.provider === 'inkbox') {
      const h = await inkboxFor(mkCtx(deps, mailbox.workspaceId), channelDeps);
      if (!h) throw new Error('Inkbox is not connected for this workspace');
      return new InkboxMailProvider(h.client, mailbox.email); // not cached: the key can be rotated
    }
    const creds = await loadCreds(mkCtx(deps, mailbox.workspaceId), mailbox.id, deps.kek);
    const p = outboundProviderFor({ db: deps.db, kek: deps.kek, apps: deps.connectorApps, fallback: deps.mailProvider, brokerToken: deps.brokerToken }, mailbox, creds);
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
  const researchDeps = { db: deps.db, env: deps.aiEnv, now: () => new Date(), jobs: deps.jobs };
  void work<{ prospectId: string; workspaceId: string; focus?: string | null; force?: boolean }>('ai.research', (job) => researchProspect(researchDeps, job.data.prospectId, { focus: job.data.focus, force: job.data.force }), 2);
  void work<{ signalId: string; workspaceId: string }>('signals.evaluate', (job) => evaluateSignal(mkCtx(deps, job.data.workspaceId), job.data.signalId), 5);
  void work<{ accountId: string; workspaceId: string; focus?: string | null; force?: boolean }>('signals.scan', (job) => scanAccount(researchDeps, job.data.accountId, { focus: job.data.focus, force: job.data.force }), 1);
  void work<Record<string, never>>('signals.scan_due', async () => {
    if (!hasAi(deps.aiEnv) && !deps.scanWithoutEnvKeys) return { skipped: 'no server AI keys; workspaces with their own key still scan on demand' };
    const due = await accountsDueForScan(deps.db, { everyDays: deps.scanEveryDays ?? 7, perWorkspace: deps.scanPerWorkspace ?? 10, now: new Date() });
    for (const a of due) await deps.jobs.send('signals.scan', { accountId: a.id, workspaceId: a.workspaceId }, { singletonKey: `scan:${a.id}` });
    return { queued: due.length };
  }, 1);
  void work<{ taskId: string; workspaceId: string }>('ai.draft_email', (job) => draftEmailForTask({ db: deps.db, env: deps.aiEnv, now: () => new Date() }, job.data.taskId), 2);
  void work<{ workspaceId: string; full?: boolean }>('search.index', (job) => indexWorkspace(deps.db, job.data.workspaceId, { full: !!job.data.full }), 1);
  void work<Record<string, never>>('search.index_all', async () => {
    const all = await deps.db.select({ id: workspaces.id }).from(workspaces);
    let indexed = 0;
    for (const w of all) indexed += (await indexWorkspace(deps.db, w.id)).indexed;
    return { workspaces: all.length, indexed };
  }, 1);
  void work<Record<string, never>>('outbox.publish', async () => ({ published: await publishOutbox(deps.db, deps.jobs, { onEvent: (ev) => dispatchInternal(deps, ev) }) }), 1);
  void work<{ workspaceId: string; emailId?: string; taskId?: string; callId?: string }>('crm.sync', async (job) => {
    const ctx = mkCtx(deps, job.data.workspaceId);
    const d = { kek: deps.kek, hubspotApp: deps.hubspotApp, brokerHubspotToken: deps.brokerHubspotToken };
    if (job.data.emailId) return { email: await logEmailToHubspot(ctx, job.data.emailId, d) };
    if (job.data.callId) return { call: await logCallToHubspot(ctx, job.data.callId, d) };
    if (job.data.taskId) return { call: await logCallTaskToHubspot(ctx, job.data.taskId, d) };
    return { skipped: true };
  }, 3);
  void work<Record<string, never>>('crm.poll', async () => {
    const rows = await deps.db.select().from(crmConnections).where(eq(crmConnections.type, 'hubspot'));
    const out: Record<string, unknown> = {};
    for (const row of rows) {
      const s = (row.settings ?? {}) as CrmSettings;
      for (const rule of s.autoEnroll ?? []) {
        if (!rule.enabled) continue;
        try {
          out[`${row.workspaceId}:${rule.id}`] = await runAutoEnrollRule(mkCtx(deps, row.workspaceId), rule, { kek: deps.kek, hubspotApp: deps.hubspotApp, brokerHubspotToken: deps.brokerHubspotToken });
        } catch (e) {
          out[`${row.workspaceId}:${rule.id}`] = { error: (e as Error).message };
        }
      }
      await deps.db.update(crmConnections).set({ settings: { ...s, lastPollAt: new Date().toISOString() } as Record<string, unknown> }).where(eq(crmConnections.id, row.id));
    }
    return out;
  }, 1);
  const coachDeps = { db: deps.db, env: deps.aiEnv, now: () => new Date(), publicUrl: deps.publicUrl, telephony: { kek: deps.kek, apiBase: deps.telephonyApiBase }, jobs: deps.jobs };
  void work<{ callId: string; workspaceId: string; force?: boolean }>('telephony.recording', (job) => processCallRecording(coachDeps, job.data.callId, { force: job.data.force }), 1);
  void work<{ callId: string; workspaceId: string; force?: boolean }>('ai.coach_call', (job) => coachCall(coachDeps, job.data.callId, { force: job.data.force }), 1);
  void work<{ messageId: string; workspaceId: string }>('message.send', (job) => sendQueuedMessage(mkCtx(deps, job.data.workspaceId), job.data.messageId, channelDeps), 2);
  void work<{ stateId: string; stepId: string; workspaceId: string }>('inkbox.call', (job) => runAiCallStep(mkCtx(deps, job.data.workspaceId), job.data.stateId, job.data.stepId, channelDeps), 1);
  void work<{ callId: string; workspaceId: string; attempt?: number }>('inkbox.call_poll', async (job) => {
    const attempt = job.data.attempt ?? 1;
    const r = await pollInkboxCall(mkCtx(deps, job.data.workspaceId), job.data.callId, channelDeps, { attempt });
    if (!r.done) await deps.jobs.send('inkbox.call_poll', { callId: job.data.callId, workspaceId: job.data.workspaceId, attempt: attempt + 1 }, { startAfter: new Date(Date.now() + (r.nextDelaySeconds ?? 15) * 1000), singletonKey: `inkpoll:${job.data.callId}:${attempt + 1}` });
    return r;
  }, 5);
  const aiCallDeps = { kek: deps.kek, apiBase: deps.telephonyApiBase, speko: { apiKey: deps.spekoApiKey, apiBase: deps.spekoApiBase }, publicUrl: deps.publicUrl };
  void work<{ callId: string; workspaceId: string; attempt?: number }>('telephony.ai_poll', async (job) => {
    const attempt = job.data.attempt ?? 1;
    const r = await pollAiCall(mkCtx(deps, job.data.workspaceId), job.data.callId, aiCallDeps, { attempt });
    if (!r.done) await deps.jobs.send('telephony.ai_poll', { callId: job.data.callId, workspaceId: job.data.workspaceId, attempt: attempt + 1 }, { startAfter: new Date(Date.now() + (r.nextDelaySeconds ?? 10) * 1000), singletonKey: `aipoll:${job.data.callId}:${attempt + 1}` });
    return r;
  }, 5);
  void work<Record<string, never>>('enrollment.start_pending', async () => ({ promoted: await startPendingEnrollments(mkCtx(deps, 'system')) }), 1);
  // Parallel dialer safety net: close idle sessions and settle legs the carrier never reported on.
  void work<Record<string, never>>('telephony.dial_sweep', async () => sweepDialSessions(deps.db, { ...aiCallDeps, twilioEnv: deps.twilioEnv }), 1);
}

const hasAi = (e: EnvKeys) => !!(e.ANTHROPIC_API_KEY || e.XAI_API_KEY || e.OPENAI_API_KEY || e.OPENROUTER_API_KEY || e.OLLAMA_BASE_URL);

/** Outbox events that fan into internal jobs (CRM write-back). Webhooks are handled by publishOutbox itself. */
async function dispatchInternal(deps: WorkerDeps, ev: { workspaceId: string; eventType: string; payload: Record<string, unknown> }) {
  if (ev.eventType === 'email.sent' && ev.payload.emailId) await deps.jobs.send('crm.sync', { workspaceId: ev.workspaceId, emailId: ev.payload.emailId }, { singletonKey: `crm:email:${ev.payload.emailId}` });
  if (ev.eventType === 'task.completed' && ev.payload.taskId) await deps.jobs.send('crm.sync', { workspaceId: ev.workspaceId, taskId: ev.payload.taskId }, { singletonKey: `crm:task:${ev.payload.taskId}` });
  if (ev.eventType === 'call.logged' && ev.payload.callId) await deps.jobs.send('crm.sync', { workspaceId: ev.workspaceId, callId: ev.payload.callId }, { singletonKey: `crm:call:${ev.payload.callId}` });
  if (ev.eventType === 'message.replied' && typeof ev.payload.prospectId === 'string') {
    await signalFromMessageEvent(mkCtx(deps, ev.workspaceId), ev.payload).catch((e) => deps.log('signal derive failed', { error: (e as Error).message }));
  }
  if ((ev.eventType === 'email.opened' || ev.eventType === 'email.clicked' || ev.eventType === 'email.replied') && typeof ev.payload.emailId === 'string') {
    const [em] = await deps.db.select({ id: emailsTable.id, prospectId: emailsTable.prospectId, subject: emailsTable.subject, openCount: emailsTable.openCount }).from(emailsTable).where(eq(emailsTable.id, ev.payload.emailId)).limit(1);
    await signalFromEmailEvent(mkCtx(deps, ev.workspaceId), ev.eventType, ev.payload, em ?? null).catch((e) => deps.log('signal derive failed', { error: (e as Error).message }));
  }
}

export async function registerSchedules(boss: PgBoss) {
  await boss.schedule('enrollment.start_pending', '* * * * *', {}, { tz: 'UTC' });
  await boss.schedule('inbox.sync', '*/2 * * * *', {}, { tz: 'UTC' });
  await boss.schedule('crm.poll', '*/5 * * * *', {}, { tz: 'UTC' });
  await boss.schedule('outbox.publish', '* * * * *', {}, { tz: 'UTC' });
  await boss.schedule('signals.scan_due', '15 6 * * *', {}, { tz: 'UTC' });
  await boss.schedule('telephony.dial_sweep', '* * * * *', {}, { tz: 'UTC' });
  await boss.schedule('search.index_all', '*/2 * * * *', {}, { tz: 'UTC' });
}

/** Low-latency outbox drain between the cron ticks. Safe with several workers (SKIP LOCKED). */
export function startOutboxLoop(deps: WorkerDeps, intervalMs = 2000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await publishOutbox(deps.db, deps.jobs, { onEvent: (ev) => dispatchInternal(deps, ev) });
      if (n > 0) deps.log('outbox.publish', { published: n });
    } catch (e) {
      deps.log('outbox.publish failed', { error: (e as Error).message });
    } finally {
      running = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
