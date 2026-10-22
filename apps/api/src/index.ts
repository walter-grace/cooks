import { serve } from '@hono/node-server';
import { loadEnv } from '@cooks/config';
import { createDb, runMigrations } from '@cooks/db';
import { createBoss, PgBossJobs } from '@cooks/jobs';
import { createApp } from './app.js';
import { PgRateLimitStore } from './middleware/rate-limit.js';

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
if (env.COOKS_AUTO_MIGRATE) await runMigrations(handle.db, env.DATABASE_URL);
const boss = await createBoss(env.DATABASE_URL);

const { app, registry } = createApp({
  db: handle.db,
  jobs: new PgBossJobs(boss),
  rateLimitStore: new PgRateLimitStore(handle.db),
  publicUrl: env.COOKS_PUBLIC_URL,
  kek: env.COOKS_KEK,
  keyPrefix: env.COOKS_API_KEY_PREFIX,
  acceptNooksPrefix: env.COOKS_ACCEPT_NOOKS_PREFIX,
  publicIps: env.COOKS_PUBLIC_IPS.split(',').map((s) => s.trim()).filter(Boolean),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`cooks api listening on http://localhost:${info.port}  (${registry.length} routes, docs at /docs)`);
});

const shutdown = async () => {
  await boss.stop();
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
