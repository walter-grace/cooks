import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/** Fill process.env from the nearest .env (cwd, then up to three parents). Existing variables win. */
function loadDotenv(): void {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    const file = join(dir, '.env');
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (line.trim().startsWith('#')) continue;
        const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (!m) continue;
        const v = m[2]!.replace(/^["']|["']$/g, '');
        if (process.env[m[1]!] === undefined && v !== '') process.env[m[1]!] = v;
      }
      return;
    }
    const parent = join(dir, '..');
    if (parent === dir) return;
    dir = parent;
  }
}

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().default('postgres://localhost:5432/cooks'),
  PORT: z.coerce.number().int().positive().default(8080),
  MCP_PORT: z.coerce.number().int().positive().default(8081),
  COOKS_PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  COOKS_MCP_PUBLIC_URL: z.string().url().default('http://localhost:8081'),
  COOKS_KEK: z.string().optional(),
  COOKS_AUTO_MIGRATE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  COOKS_API_KEY_PREFIX: z.enum(['cooks', 'nooks']).default('cooks'),
  COOKS_OAUTH_DCR: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  COOKS_ACCEPT_NOOKS_PREFIX: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  SMTP_URL: z.string().default('smtp://127.0.0.1:1025'),
  ANTHROPIC_API_KEY: z.string().optional(),
  XAI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OLLAMA_BASE_URL: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  MS_TENANT: z.string().default('common'),
  /** Self-serve accounts: open (anyone can sign up), invite (only by invite link), off (bootstrap and admins create users). */
  COOKS_SIGNUP: z.enum(['open', 'invite', 'off']).default('off'),
  /** From address for verification, reset and invite mail. Defaults to no-reply at the public host. */
  COOKS_MAIL_FROM: z.string().optional(),
  /** Send account mail through Resend instead of SMTP_URL. */
  RESEND_API_KEY: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().optional(),
  CLERK_JWT_KEY: z.string().optional(),
  /** Workspace slug that Clerk users without an organization join. */
  COOKS_CLERK_DEFAULT_WORKSPACE: z.string().optional(),
  /** Twilio REST base (override for scripts/qa/mock-twilio.mjs). */
  TWILIO_API_BASE: z.string().optional(),
  /** Optional server-wide Twilio credentials; workspaces without their own connection use them. */
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  TWILIO_TWIML_APP_SID: z.string().optional(),
  /** Speech gate (fast pickup) for the parallel dialer: off | mock | openai | sherpa. */
  SPEECH_PROVIDER: z.enum(['off', 'mock', 'openai', 'sherpa']).default('off'),
  SPEECH_API_KEY: z.string().optional(),
  SPEECH_API_BASE: z.string().optional(),
  SPEECH_MODEL: z.string().optional(),
  SPEECH_MODEL_DIR: z.string().optional(),
  /** Jev decision model id on OpenRouter for the tie-breaker (OPENROUTER_API_KEY). */
  SPEECH_JEV_MODEL: z.string().default('typesafe/jev-1.14'),
  /** Practice calls (rep rehearses against an AI prospect): off | mock | openai | local. */
  PRACTICE_PROVIDER: z.enum(['off', 'mock', 'openai', 'local']).default('off'),
  PRACTICE_API_KEY: z.string().optional(),
  PRACTICE_API_BASE: z.string().optional(),
  PRACTICE_MODEL: z.string().optional(),
  PRACTICE_VOICE: z.string().optional(),
  /** `local`: WebSocket URL of a full-duplex runner speaking the Cooks duplex protocol (docs/practice.md). */
  PRACTICE_LOCAL_URL: z.string().optional(),
  PRACTICE_MAX_SECONDS: z.coerce.number().int().min(30).max(3600).default(600),
  /** Server-wide Speko key (workspaces can store their own instead). */
  SPEKO_API_KEY: z.string().optional(),
  SPEKO_API_BASE: z.string().optional(),
  /** Server-wide Dial (getdial.ai) key (workspaces can store their own instead). */
  DIAL_API_KEY: z.string().optional(),
  DIAL_API_BASE: z.string().optional(),
  /** Inkbox base override (mocks); keys are per workspace. */
  INKBOX_API_BASE: z.string().optional(),
  /** OpenAI-compatible speech-to-text for call transcripts (any whisper server). */
  TRANSCRIBE_API_BASE: z.string().optional(),
  TRANSCRIBE_API_KEY: z.string().optional(),
  TRANSCRIBE_MODEL: z.string().default('whisper-1'),
  HUBSPOT_CLIENT_ID: z.string().optional(),
  HUBSPOT_CLIENT_SECRET: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Outbound IPs reported by GET /public-ip-list (comma separated). */
  COOKS_PUBLIC_IPS: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse and cache process.env. Throws a readable error listing every bad variable. */
export function loadEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  if (cached && Object.keys(overrides).length === 0) return cached;
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) loadDotenv();
  const parsed = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment:\n${lines.join('\n')}`);
  }
  if (Object.keys(overrides).length === 0) cached = parsed.data;
  return parsed.data;
}

export function resetEnvCache(): void {
  cached = undefined;
}

import { userInfo } from 'node:os';

/** node-postgres (used by pg-boss) does not default the user to the OS account like psql does. */
export function withDefaultUser(databaseUrl: string): string {
  try {
    const u = new URL(databaseUrl);
    if (!u.username) u.username = process.env.PGUSER ?? userInfo().username;
    return u.toString();
  } catch {
    return databaseUrl;
  }
}
