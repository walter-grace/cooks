import { z } from 'zod';

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
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Outbound IPs reported by GET /public-ip-list (comma separated). */
  COOKS_PUBLIC_IPS: z.string().default(''),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** Parse and cache process.env. Throws a readable error listing every bad variable. */
export function loadEnv(overrides: Partial<Record<keyof Env, string>> = {}): Env {
  if (cached && Object.keys(overrides).length === 0) return cached;
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
