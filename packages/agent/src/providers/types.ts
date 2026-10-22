import type { z } from 'zod';

export type ProviderId = 'anthropic' | 'openai' | 'xai' | 'openrouter' | 'ollama' | 'custom';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number | null;
}

export interface StructuredRequest<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  /** Name for the output schema (letters, digits, underscores). */
  schemaName: string;
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  temperature?: number;
  signal?: AbortSignal;
  /** Ground the answer in live web search (OpenRouter `web` plugin). Ignored by providers without it. */
  web?: { maxResults?: number } | boolean;
}

export interface Citation {
  url: string;
  title?: string;
}

export type StructuredResult<T> =
  | { kind: 'ok'; value: T; usage: TokenUsage; model: string; latencyMs: number; raw?: unknown; citations?: Citation[] }
  | { kind: 'refusal'; reason: string; usage: TokenUsage; model: string; latencyMs: number }
  | { kind: 'invalid'; error: string; text: string; usage: TokenUsage; model: string; latencyMs: number };

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** One structured-output call: prompt in, schema-validated JSON out. */
  structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export interface ResolvedAiConfig {
  provider: ProviderId;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  classifyModel?: string;
  draftModel?: string;
  autoSendAiEmail: boolean;
  confidenceThreshold: number;
  monthlyBudgetUsd: number | null;
}
