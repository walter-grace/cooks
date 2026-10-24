import { loadEnv } from '@cooks/config';
import { createDb, runMigrations } from '@cooks/db';
import { createBoss, PgBossJobs } from '@cooks/jobs';
import { MemoryMailProvider, SmtpProvider } from '@cooks/core';
import { registerHandlers, registerSchedules, startOutboxLoop } from './handlers.js';
import { workerDepsFrom } from './boot.js';

const env = loadEnv();
const handle = createDb(env.DATABASE_URL, { max: 5 });
if (env.COOKS_AUTO_MIGRATE) await runMigrations(handle.db, env.DATABASE_URL);
const boss = await createBoss(env.DATABASE_URL);
const jobs = new PgBossJobs(boss);

const dryRun = process.env.COOKS_MAIL_DRY_RUN === 'true';
const mailProvider = dryRun ? new MemoryMailProvider() : new SmtpProvider(env.SMTP_URL);
if (!dryRun) await (mailProvider as SmtpProvider).verify().catch((e: Error) => console.warn(`[worker] SMTP not reachable at ${env.SMTP_URL}: ${e.message}`));

const workerDeps = workerDepsFrom(env, { db: handle.db, jobs, mailProvider });
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
