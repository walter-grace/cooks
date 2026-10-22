import { serve } from '@hono/node-server';
import { loadEnv } from '@cooks/config';
import { createDb, runMigrations } from '@cooks/db';
import { createApp } from './app.js';
import { PgRateLimitStore } from './middleware/rate-limit.js';

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
if (env.COOKS_AUTO_MIGRATE) await runMigrations(handle.db);

const { app, registry } = createApp({
  db: handle.db,
  rateLimitStore: new PgRateLimitStore(handle.db),
  publicUrl: env.COOKS_PUBLIC_URL,
  acceptNooksPrefix: env.COOKS_ACCEPT_NOOKS_PREFIX,
  publicIps: env.COOKS_PUBLIC_IPS.split(',').map((s) => s.trim()).filter(Boolean),
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`cooks api listening on http://localhost:${info.port}  (${registry.length} routes, docs at /docs)`);
});

const shutdown = async () => {
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
