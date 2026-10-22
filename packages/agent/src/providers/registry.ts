import type { LlmProvider, ProviderId, ResolvedAiConfig } from './types.js';
import { AnthropicProvider, ANTHROPIC_DEFAULT_MODEL } from './anthropic.js';
import { COMPAT_PRESETS, OpenAICompatProvider } from './openai-compat.js';

export type ProviderFactory = (cfg: ResolvedAiConfig, model: string) => LlmProvider;

const factories = new Map<ProviderId, ProviderFactory>([
  ['anthropic', (cfg, model) => new AnthropicProvider(model, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })],
  ['openai', (cfg, model) => new OpenAICompatProvider('openai', model, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })],
  ['xai', (cfg, model) => new OpenAICompatProvider('xai', model, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })],
  ['openrouter', (cfg, model) => new OpenAICompatProvider('openrouter', model, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })],
  ['ollama', (cfg, model) => new OpenAICompatProvider('ollama', model, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })],
  ['custom', (cfg, model) => new OpenAICompatProvider('custom', model, { apiKey: cfg.apiKey, baseUrl: cfg.baseUrl })],
]);

/** Plug in another provider (e.g. a local test double) without touching the registry. */
export function registerProvider(id: ProviderId, factory: ProviderFactory) {
  factories.set(id, factory);
}

export function defaultModelFor(provider: ProviderId): string {
  if (provider === 'anthropic') return ANTHROPIC_DEFAULT_MODEL;
  if (provider === 'custom') return 'default';
  return COMPAT_PRESETS[provider].defaultModel;
}

export function providerFor(cfg: ResolvedAiConfig, purpose: 'draft' | 'classify' | 'general' = 'general'): LlmProvider {
  const f = factories.get(cfg.provider);
  if (!f) throw new Error(`Unknown AI provider ${cfg.provider}`);
  const model = (purpose === 'draft' ? cfg.draftModel : purpose === 'classify' ? cfg.classifyModel : undefined) ?? cfg.model;
  return f(cfg, model);
}
