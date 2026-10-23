import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { loadEnv } from '@cooks/config';
import { createDb, runMigrations } from '@cooks/db';
import { createBoss, PgBossJobs } from '@cooks/jobs';
import { clerkGateway, ensureSigningKey } from '@cooks/auth';
import { createApp } from './app.js';
import { PgRateLimitStore } from './middleware/rate-limit.js';

const env = loadEnv();
const handle = createDb(env.DATABASE_URL);
if (env.COOKS_AUTO_MIGRATE) await runMigrations(handle.db, env.DATABASE_URL);
const boss = await createBoss(env.DATABASE_URL);
const signingKey = await ensureSigningKey(handle.db, env.COOKS_KEK);

const { app, registry, injectWebSocket } = createApp({
  db: handle.db,
  jobs: new PgBossJobs(boss),
  rateLimitStore: new PgRateLimitStore(handle.db),
  publicUrl: env.COOKS_PUBLIC_URL,
  kek: env.COOKS_KEK,
  keyPrefix: env.COOKS_API_KEY_PREFIX,
  oauth: { key: signingKey, dcrEnabled: env.COOKS_OAUTH_DCR, mcpPublicUrl: env.COOKS_MCP_PUBLIC_URL },
  connectorApps: {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    ...(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET ? { microsoft: { clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET } } : {}),
  },
  msTenant: env.MS_TENANT,
  clerk: env.CLERK_SECRET_KEY ? { gateway: clerkGateway(env.CLERK_SECRET_KEY, { publishableKey: env.CLERK_PUBLISHABLE_KEY, jwtKey: env.CLERK_JWT_KEY }), publishableKey: env.CLERK_PUBLISHABLE_KEY, defaultWorkspaceSlug: env.COOKS_CLERK_DEFAULT_WORKSPACE } : undefined,
  hubspotApp: process.env.HUBSPOT_CLIENT_ID && process.env.HUBSPOT_CLIENT_SECRET ? { clientId: process.env.HUBSPOT_CLIENT_ID, clientSecret: process.env.HUBSPOT_CLIENT_SECRET } : undefined,
  telephony: {
    apiBase: env.TWILIO_API_BASE,
    speko: { apiKey: env.SPEKO_API_KEY, apiBase: env.SPEKO_API_BASE },
    twilioEnv: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromNumber: env.TWILIO_FROM_NUMBER, apiKeySid: env.TWILIO_API_KEY_SID, apiKeySecret: env.TWILIO_API_KEY_SECRET, twimlAppSid: env.TWILIO_TWIML_APP_SID } : undefined,
    speech: { provider: env.SPEECH_PROVIDER, apiKey: env.SPEECH_API_KEY ?? env.OPENAI_API_KEY, apiBase: env.SPEECH_API_BASE, model: env.SPEECH_MODEL, modelDir: env.SPEECH_MODEL_DIR, jev: { apiKey: env.OPENROUTER_API_KEY, model: env.SPEECH_JEV_MODEL } },
  },
  channels: { inkboxApiBase: env.INKBOX_API_BASE },
  webDir: [join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist'), process.env.COOKS_WEB_DIR ?? ''].find((d) => d && existsSync(join(d, 'index.html'))),
  acceptNooksPrefix: env.COOKS_ACCEPT_NOOKS_PREFIX,
  publicIps: env.COOKS_PUBLIC_IPS.split(',').map((s) => s.trim()).filter(Boolean),
});

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
