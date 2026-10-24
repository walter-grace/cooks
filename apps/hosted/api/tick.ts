/**
 * The worker as a cron tick. Vercel calls this every minute with `Authorization: Bearer $CRON_SECRET`;
 * it starts pg-boss with the same handlers and schedules as the long-running worker, processes
 * jobs for most of the minute, then stops cleanly. Overlapping ticks are safe: pg-boss hands each
 * job to one consumer, and the singleton queues keep crons from doubling up.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv } from '@cooks/config';
import { MemoryMailProvider, SmtpProvider } from '@cooks/core';
import { createDb, runMigrations } from '@cooks/db';
import { createBoss, PgBossJobs } from '@cooks/jobs';
import { registerHandlers, registerSchedules } from '@cooks/worker/handlers';
import { workerDepsFrom } from '@cooks/worker/boot';

const TICK_MS = Number(process.env.COOKS_TICK_MS ?? 50_000);

export default async function tick(req: IncomingMessage, res: ServerResponse) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization ?? '';
  if (secret && auth !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.end('unauthorized');
    return;
  }
  const env = loadEnv({ COOKS_AUTO_MIGRATE: 'false' });
  const started = Date.now();
  const handle = createDb(env.DATABASE_URL, { max: 4 });
  // Migrations take an advisory lock, which needs a direct (unpooled) connection on Neon.
  if (process.env.COOKS_TICK_MIGRATE === 'true') await runMigrations(handle.db, process.env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL);
  const boss = await createBoss(env.DATABASE_URL);
  const mailProvider = process.env.COOKS_MAIL_DRY_RUN === 'true' || !process.env.SMTP_URL ? new MemoryMailProvider() : new SmtpProvider(env.SMTP_URL);
  const deps = workerDepsFrom(env, { db: handle.db, jobs: new PgBossJobs(boss), mailProvider });
  let handled = 0;
  const log = deps.log;
  deps.log = (msg, data) => {
    if (/ ok$/.test(msg)) handled++;
    log(msg, data);
  };
  registerHandlers(boss, deps);
  await registerSchedules(boss);
  await new Promise((r) => setTimeout(r, TICK_MS));
  await boss.stop({ graceful: true, timeout: 20_000 });
  await handle.close();
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, handled, ms: Date.now() - started }));
}
