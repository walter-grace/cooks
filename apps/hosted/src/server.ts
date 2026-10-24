/**
 * The Cooks API as one Vercel Function. Exporting the Node http server lets Vercel route HTTP
 * and WebSocket upgrades (practice calls, the speech gate's media streams) to the same Hono app.
 * The built web app is served from /public by the CDN, with vercel.json rewriting /app/* to it.
 *
 * The server is exported without calling listen(): Vercel's launcher binds it to the port it
 * proxies to, the same way it treats an Express `createServer(app)`. Listening ourselves on a
 * port Vercel did not pick left every request waiting until the function timed out.
 *
 * Nothing here runs the job queue; the cron tick in ./tick.ts does. Migrations run at build time.
 */
import { createAdaptorServer } from '@hono/node-server';
import { ensureSigningKey } from '@cooks/auth';
import { loadEnv } from '@cooks/config';
import { createDb } from '@cooks/db';
import { createBoss, LazyPgBossJobs } from '@cooks/jobs';
import { createApp } from '@cooks/api/app';
import { apiDepsFrom } from '@cooks/api/boot';

const t0 = Date.now();
const log = (m: string) => console.log(`[hosted] ${m} +${Date.now() - t0}ms`);
log('init');
process.on('unhandledRejection', (e) => console.error('[hosted] unhandled rejection', e));
process.on('uncaughtException', (e) => console.error('[hosted] uncaught exception', e));
const env = loadEnv({ COOKS_AUTO_MIGRATE: 'false' });
const handle = createDb(env.DATABASE_URL, { max: 3, connectTimeout: 10, idleTimeout: 20 });
// pg-boss starts on the first enqueue, not at cold start; enqueue only, no supervision or cron clock here.
const jobs = new LazyPgBossJobs(() => createBoss(env.DATABASE_URL, { supervise: false, schedule: false }));
const signingKey = await ensureSigningKey(handle.db, env.COOKS_KEK);
log('signing key ready');
const { app, injectWebSocket } = createApp(apiDepsFrom(env, { db: handle.db, jobs, signingKey }));
log('app ready');

const server = createAdaptorServer({ fetch: app.fetch });
injectWebSocket(server);
server.once('listening', () => log(`listening on ${JSON.stringify(server.address())}`));

export default server;
