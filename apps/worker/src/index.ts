import { loadEnv } from '@cooks/config';
import { createDb, runMigrations } from '@cooks/db';
import { createBoss, PgBossJobs } from '@cooks/jobs';
import { MemoryMailProvider, SmtpProvider } from '@cooks/core';
import { registerHandlers, registerSchedules, startOutboxLoop } from './handlers.js';
import { clerkGateway } from '@cooks/auth';
import { eq } from 'drizzle-orm';
import { users } from '@cooks/db';

const env = loadEnv();
const handle = createDb(env.DATABASE_URL, { max: 5 });
if (env.COOKS_AUTO_MIGRATE) await runMigrations(handle.db, env.DATABASE_URL);
const boss = await createBoss(env.DATABASE_URL);
const jobs = new PgBossJobs(boss);

const dryRun = process.env.COOKS_MAIL_DRY_RUN === 'true';
const mailProvider = dryRun ? new MemoryMailProvider() : new SmtpProvider(env.SMTP_URL);
if (!dryRun) await (mailProvider as SmtpProvider).verify().catch((e: Error) => console.warn(`[worker] SMTP not reachable at ${env.SMTP_URL}: ${e.message}`));

const gateway = env.CLERK_SECRET_KEY ? clerkGateway(env.CLERK_SECRET_KEY, { publishableKey: env.CLERK_PUBLISHABLE_KEY, jwtKey: env.CLERK_JWT_KEY }) : null;
const clerkIdOf = async (userId: string) => (await handle.db.select({ c: users.clerkUserId }).from(users).where(eq(users.id, userId)).limit(1))[0]?.c ?? null;
const workerDeps = {
  brokerToken: gateway
    ? async (userId: string, provider: 'google' | 'microsoft' | 'hubspot') => {
        const cid = await clerkIdOf(userId);
        const t = cid ? await gateway.getProviderToken(cid, provider) : null;
        return t ? { refreshToken: '', accessToken: t.token, expiresAt: t.expiresAt ?? Date.now() + 50 * 60_000, viaClerk: true } : null;
      }
    : undefined,
  brokerHubspotToken: gateway
    ? async (clerkUserId: string) => {
        const t = await gateway.getProviderToken(clerkUserId, 'hubspot');
        return t ? { accessToken: t.token, expiresAt: t.expiresAt ?? Date.now() + 25 * 60_000 } : null;
      }
    : undefined,
  db: handle.db,
  jobs,
  publicUrl: env.COOKS_PUBLIC_URL,
  mailProvider,
  fallbackFrom: process.env.COOKS_MAIL_FROM ?? 'Cooks <no-reply@cooks.local>',
  trackingSecret: env.COOKS_KEK ?? 'cooks-dev',
  kek: env.COOKS_KEK,
  hubspotApp: env.HUBSPOT_CLIENT_ID && env.HUBSPOT_CLIENT_SECRET ? { clientId: env.HUBSPOT_CLIENT_ID, clientSecret: env.HUBSPOT_CLIENT_SECRET } : undefined,
  connectorApps: {
    ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } } : {}),
    ...(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET ? { microsoft: { clientId: env.MS_CLIENT_ID, clientSecret: env.MS_CLIENT_SECRET } } : {}),
  },
  aiEnv: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY, XAI_API_KEY: env.XAI_API_KEY, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY, OLLAMA_BASE_URL: env.OLLAMA_BASE_URL, COOKS_KEK: env.COOKS_KEK, TRANSCRIBE_API_BASE: env.TRANSCRIBE_API_BASE, TRANSCRIBE_API_KEY: env.TRANSCRIBE_API_KEY, TRANSCRIBE_MODEL: env.TRANSCRIBE_MODEL },
  telephonyApiBase: env.TWILIO_API_BASE,
  spekoApiKey: env.SPEKO_API_KEY,
  spekoApiBase: env.SPEKO_API_BASE,
  inkboxApiBase: env.INKBOX_API_BASE,
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
