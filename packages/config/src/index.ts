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
  SMTP_URL: z.string().default('smtp://localhost:1025'),
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
