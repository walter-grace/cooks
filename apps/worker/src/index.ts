import { loadEnv } from '@cooks/config';
import { createDb, runMigrations } from '@cooks/db';
import { createBoss, PgBossJobs } from '@cooks/jobs';
import { MemoryMailProvider, SmtpProvider } from '@cooks/core';
import { registerHandlers, registerSchedules, startOutboxLoop } from './handlers.js';

const env = loadEnv();
const handle = createDb(env.DATABASE_URL, { max: 5 });
if (env.COOKS_AUTO_MIGRATE) await runMigrations(handle.db, env.DATABASE_URL);
const boss = await createBoss(env.DATABASE_URL);
const jobs = new PgBossJobs(boss);

const dryRun = process.env.COOKS_MAIL_DRY_RUN === 'true';
const mailProvider = dryRun ? new MemoryMailProvider() : new SmtpProvider(env.SMTP_URL);
if (!dryRun) await (mailProvider as SmtpProvider).verify().catch((e: Error) => console.warn(`[worker] SMTP not reachable at ${env.SMTP_URL}: ${e.message}`));

const workerDeps = {
  db: handle.db,
  jobs,
  publicUrl: env.COOKS_PUBLIC_URL,
  mailProvider,
  fallbackFrom: process.env.COOKS_MAIL_FROM ?? 'Cooks <no-reply@cooks.local>',
  trackingSecret: env.COOKS_KEK ?? 'cooks-dev',
  kek: env.COOKS_KEK,
  connectorApps: {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    ...(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET ? { microsoft: { clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET } } : {}),
  },
  aiEnv: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY, XAI_API_KEY: env.XAI_API_KEY, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY, OLLAMA_BASE_URL: env.OLLAMA_BASE_URL, COOKS_KEK: env.COOKS_KEK },
  log: (msg: string, data?: Record<string, unknown>) => console.log(`[worker] ${msg}`, data ? JSON.stringify(data) : ''),
};
registerHandlers(boss, workerDeps);
await registerSchedules(boss);
const stopOutbox = startOutboxLoop(workerDeps);
console.log(`cooks worker running (mail: ${dryRun ? 'dry-run' : env.SMTP_URL})`);

const shutdown = async () => {
  stopOutbox();
  await boss.stop();
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
