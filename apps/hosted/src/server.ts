/**
 * The Cooks API as one Vercel Function. Exporting the Node http server lets Vercel route HTTP
 * and WebSocket upgrades (practice calls, the speech gate's media streams) to the same Hono app.
 * The built web app is served from /public by the CDN, with vercel.json rewriting /app/* to it.
 *
 * Nothing here runs the job queue; the cron tick in ./tick.ts does. Migrations run at build time.
 */
import { serve } from '@hono/node-server';
import { ensureSigningKey } from '@cooks/auth';
import { loadEnv } from '@cooks/config';
import { createDb } from '@cooks/db';
import { createBoss, PgBossJobs } from '@cooks/jobs';
import { createApp } from '@cooks/api/app';
import { apiDepsFrom } from '@cooks/api/boot';

const env = loadEnv({ COOKS_AUTO_MIGRATE: 'false' });
const handle = createDb(env.DATABASE_URL, { max: 3 });
// Enqueue only: no supervision or cron clock inside a request handler.
const boss = await createBoss(env.DATABASE_URL, { supervise: false, schedule: false });
const signingKey = await ensureSigningKey(handle.db, env.COOKS_KEK);
const { app, injectWebSocket } = createApp(apiDepsFrom(env, { db: handle.db, jobs: new PgBossJobs(boss), signingKey }));

const server = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 0) });
injectWebSocket(server);

export default server;
