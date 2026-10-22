import { eq } from 'drizzle-orm';
import { workspaceAiSettings, type DbOrTx } from '@cooks/db';
import { decrypt } from '@cooks/core';
import type { ProviderId, ResolvedAiConfig } from './providers/types.js';
import { COMPAT_PRESETS } from './providers/openai-compat.js';
import { defaultModelFor } from './providers/registry.js';

export interface EnvKeys {
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  XAI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OLLAMA_BASE_URL?: string;
  COOKS_KEK?: string;
}

function envKeyFor(provider: ProviderId, env: EnvKeys): string | undefined {
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY;
  if (provider === 'custom') return undefined;
  const name = COMPAT_PRESETS[provider].keyEnv as keyof EnvKeys;
  return env[name];
}

/**
 * Workspace settings override environment defaults. Returns null when no provider has a key,
 * which turns hosted AI features off for that workspace (BYO-bot via MCP keeps working).
 */
export async function resolveAiConfig(db: DbOrTx, workspaceId: string, env: EnvKeys): Promise<ResolvedAiConfig | null> {
  const [row] = await db.select().from(workspaceAiSettings).where(eq(workspaceAiSettings.workspaceId, workspaceId)).limit(1);
  const provider: ProviderId = row?.provider ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : env.XAI_API_KEY ? 'xai' : env.OPENAI_API_KEY ? 'openai' : env.OPENROUTER_API_KEY ? 'openrouter' : env.OLLAMA_BASE_URL ? 'ollama' : 'anthropic');
  let apiKey = row?.apiKeyCiphertext && env.COOKS_KEK ? decrypt(row.apiKeyCiphertext, env.COOKS_KEK) : undefined;
  apiKey ??= envKeyFor(provider, env);
  const baseUrl = row?.baseUrl ?? (provider === 'ollama' ? env.OLLAMA_BASE_URL : undefined);
  if (!apiKey && provider !== 'ollama' && provider !== 'custom') return null;
  return {
    provider,
    model: row?.model ?? defaultModelFor(provider),
    apiKey,
    baseUrl: baseUrl ?? undefined,
    classifyModel: row?.classifyModel ?? undefined,
    draftModel: row?.draftModel ?? undefined,
    autoSendAiEmail: row?.autoSendAiEmail ?? false,
    confidenceThreshold: Number(row?.confidenceThreshold ?? 0.75),
    monthlyBudgetUsd: row?.monthlyBudgetUsd ? Number(row.monthlyBudgetUsd) : null,
  };
}
