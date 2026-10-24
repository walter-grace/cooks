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
import { createMcpHttpApp } from 'cooks-mcp/http';
import { Hono } from 'hono';
import { CooksError } from '@cooks/core';

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

// The MCP transport sits in front of the API and calls it in-process, with the caller's token.
const root = new Hono();
root.route('/', createMcpHttpApp({ apiUrl: 'http://cooks.internal', publicUrl: env.COOKS_PUBLIC_URL, mcpPublicUrl: env.COOKS_MCP_PUBLIC_URL ?? env.COOKS_PUBLIC_URL, fetchImpl: ((input, init) => app.request(input, init)) as typeof fetch }));
root.route('/', app);
root.notFound((c) => c.json(new CooksError(404, 'NOT_FOUND', `No route for ${c.req.method} ${c.req.path}`).toBody(''), 404));

const server = createAdaptorServer({ fetch: root.fetch });
injectWebSocket(server);
server.once('listening', () => log(`listening on ${JSON.stringify(server.address())}`));

export default server;
