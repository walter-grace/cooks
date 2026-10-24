import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { loadEnv } from '@cooks/config';
import { createDb, runMigrations } from '@cooks/db';
import { createBoss, PgBossJobs } from '@cooks/jobs';
import { ensureSigningKey } from '@cooks/auth';
import { createApp } from './app.js';
import { apiDepsFrom } from './boot.js';

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
if (env.COOKS_AUTO_MIGRATE) await runMigrations(handle.db, env.DATABASE_URL);
const boss = await createBoss(env.DATABASE_URL);
const signingKey = await ensureSigningKey(handle.db, env.COOKS_KEK);

const { app, registry, injectWebSocket } = createApp(
  apiDepsFrom(env, {
    db: handle.db,
    jobs: new PgBossJobs(boss),
    signingKey,
    webDir: [join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'), process.env.COOKS_WEB_DIR ?? ''].find((d) => d && existsSync(join(d, 'index.html'))),
  }),
);

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`cooks api listening on http://localhost:${info.port}  (${registry.length} routes, docs at /docs${env.SPEECH_PROVIDER !== 'off' ? `, speech gate: ${env.SPEECH_PROVIDER}` : ''})`);
});
injectWebSocket(server);

const shutdown = async () => {
  await boss.stop();
  await handle.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
