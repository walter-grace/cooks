/**
 * Everything createApp needs, read from the environment. Shared by the long-running server
 * (src/index.ts) and the Vercel function (apps/hosted), which differ only in how they listen.
 */
import type { Env } from '@cooks/config';
import type { Db } from '@cooks/db';
import type { JobsPort } from '@cooks/core';
import { clerkGateway, type ActiveKey } from '@cooks/auth';
import { authMailerFrom } from './auth-mail.js';
import type { AppDeps } from './app.js';
import { PgRateLimitStore } from './middleware/rate-limit.js';

export interface ApiBoot {
  db: Db;
  jobs: JobsPort;
  signingKey: ActiveKey;
  /** Built web app to serve at /app; omit when a CDN serves it. */
  webDir?: string;
}

export function apiDepsFrom(env: Env, x: ApiBoot): AppDeps {
  return {
  db: x.db,
  jobs: x.jobs,
  rateLimitStore: new PgRateLimitStore(x.db),
  publicUrl: env.COOKS_PUBLIC_URL,
  kek: env.COOKS_KEK,
  keyPrefix: env.COOKS_API_KEY_PREFIX,
  oauth: { key: x.signingKey, dcrEnabled: env.COOKS_OAUTH_DCR, mcpPublicUrl: env.COOKS_MCP_PUBLIC_URL },
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
    practice: { provider: env.PRACTICE_PROVIDER, apiKey: env.PRACTICE_API_KEY ?? env.OPENAI_API_KEY, apiBase: env.PRACTICE_API_BASE, model: env.PRACTICE_MODEL, voice: env.PRACTICE_VOICE, localUrl: env.PRACTICE_LOCAL_URL, maxSeconds: env.PRACTICE_MAX_SECONDS },
  },
  channels: { inkboxApiBase: env.INKBOX_API_BASE },
  chat: { env: { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY, OPENAI_API_KEY: env.OPENAI_API_KEY, XAI_API_KEY: env.XAI_API_KEY, OPENROUTER_API_KEY: env.OPENROUTER_API_KEY, OLLAMA_BASE_URL: env.OLLAMA_BASE_URL, COOKS_KEK: env.COOKS_KEK } },
  account: { signup: env.COOKS_SIGNUP, mailer: authMailerFrom(env).mailer, log: (msg, data) => console.log(msg, data ? JSON.stringify(data) : '') },
  webDir: x.webDir,
  acceptNooksPrefix: env.COOKS_ACCEPT_NOOKS_PREFIX,
  publicIps: env.COOKS_PUBLIC_IPS.split(',').map((s) => s.trim()).filter(Boolean),
  };
}
