/**
 * WorkerDeps from the environment. Shared by the long-running worker (src/index.ts) and the
 * Vercel cron tick (apps/hosted), which runs the same handlers for a minute at a time.
 */
import { eq } from 'drizzle-orm';
import type { Env } from '@cooks/config';
import type { JobsPort, MailProvider } from '@cooks/core';
import { users, type Db } from '@cooks/db';
import { clerkGateway } from '@cooks/auth';
import type { WorkerDeps } from './handlers.js';

export function workerDepsFrom(env: Env, x: { db: Db; jobs: JobsPort; mailProvider: MailProvider }): WorkerDeps {
const gateway = env.CLERK_SECRET_KEY ? clerkGateway(env.CLERK_SECRET_KEY, { publishableKey: env.CLERK_PUBLISHABLE_KEY, jwtKey: env.CLERK_JWT_KEY }) : null;
const clerkIdOf = async (userId: string) => (await x.db.select({ c: users.clerkUserId }).from(users).where(eq(users.id, userId)).limit(1))[0]?.c ?? null;
return {
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
  db: x.db,
  jobs: x.jobs,
  publicUrl: env.COOKS_PUBLIC_URL,
  mailProvider: x.mailProvider,
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
  twilioEnv: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromNumber: env.TWILIO_FROM_NUMBER, apiKeySid: env.TWILIO_API_KEY_SID, apiKeySecret: env.TWILIO_API_KEY_SECRET, twimlAppSid: env.TWILIO_TWIML_APP_SID } : undefined,
  spekoApiKey: env.SPEKO_API_KEY,
  spekoApiBase: env.SPEKO_API_BASE,
  inkboxApiBase: env.INKBOX_API_BASE,
  log: (msg: string, data?: Record<string, unknown>) => console.log(`[worker] ${msg}`, data ? JSON.stringify(data) : ''),
};
}
