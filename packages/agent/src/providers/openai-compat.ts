import OpenAI from 'openai';
import { z } from 'zod';
import type { Citation, LlmProvider, ProviderId, StructuredRequest, StructuredResult, TokenUsage } from './types.js';
import { estimateCostUsd } from './pricing.js';
import { extractJson } from './json.js';

/** Presets for OpenAI-compatible chat.completions endpoints. xAI is how Grok users bring their own key. */
export const COMPAT_PRESETS: Record<Exclude<ProviderId, 'anthropic' | 'custom'>, { baseUrl: string; defaultModel: string; keyEnv: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-5', keyEnv: 'OPENAI_API_KEY' },
  xai: { baseUrl: 'https://api.x.ai/v1', defaultModel: 'grok-4.7', keyEnv: 'XAI_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', defaultModel: '~anthropic/claude-sonnet-latest', keyEnv: 'OPENROUTER_API_KEY' },
  ollama: { baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.3', keyEnv: 'OLLAMA_API_KEY' },
};

export class OpenAICompatProvider implements LlmProvider {
  private client: OpenAI;
  constructor(
    public readonly id: ProviderId,
    public readonly model: string,
    opts: { apiKey?: string; baseUrl?: string },
  ) {
    const preset = id !== 'anthropic' && id !== 'custom' ? COMPAT_PRESETS[id] : undefined;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? (id === 'ollama' ? 'ollama' : undefined),
      baseURL: opts.baseUrl ?? preset?.baseUrl,
      maxRetries: 2,
      timeout: 120_000,
      ...(id === 'openrouter' ? { defaultHeaders: { 'HTTP-Referer': 'https://github.com/walter-grace/cooks', 'X-Title': 'Cooks' } } : {}),
    });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const jsonSchema = z.toJSONSchema(req.schema, { target: 'draft-7' }) as Record<string, unknown>;
    const res = await this.client.chat.completions.create(
      {
        model: this.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        max_completion_tokens: req.maxTokens ?? 4096,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        response_format: { type: 'json_schema', json_schema: { name: req.schemaName, schema: jsonSchema, strict: true } },
        ...(this.id === 'openrouter' ? { usage: { include: true } } : {}),
        ...(this.id === 'openrouter' && req.web
          ? { plugins: [{ id: 'web', max_results: typeof req.web === 'object' && req.web.maxResults ? req.web.maxResults : 5, search_prompt: 'Relevant web results. Use them as facts. Put source URLs only in the JSON fields meant for them; do not add markdown links or citations inside other text:' }] }
          : {}),
      } as Parameters<typeof this.client.chat.completions.create>[0] & { stream?: false },
      { signal: req.signal },
    );
    const choice = (res as OpenAI.Chat.Completions.ChatCompletion).choices[0];
    const u = (res as OpenAI.Chat.Completions.ChatCompletion).usage;
    const usage: TokenUsage = {
      input: u?.prompt_tokens ?? 0,
      output: u?.completion_tokens ?? 0,
      cacheRead: u?.prompt_tokens_details?.cached_tokens ?? 0,
      cacheWrite: 0,
      costUsd: null,
    };
    const reported = (u as { cost?: number } | undefined)?.cost;
    usage.costUsd = typeof reported === 'number' ? reported : estimateCostUsd(this.model, usage);
    const latencyMs = Date.now() - started;
    const model = (res as { model?: string }).model ?? this.model;
    if (choice?.finish_reason === 'content_filter') return { kind: 'refusal', reason: 'content_filter', usage, model, latencyMs };
    const text = choice?.message?.content ?? '';
    const parsed = extractJson(text);
    if (parsed === undefined) return { kind: 'invalid', error: `Response was not JSON (finish_reason=${choice?.finish_reason ?? 'unknown'})`, text, usage, model, latencyMs };
    const r = req.schema.safeParse(parsed);
    if (!r.success) return { kind: 'invalid', error: r.error.message, text, usage, model, latencyMs };
    const annotations = (choice?.message as { annotations?: Array<{ type: string; url_citation?: { url: string; title?: string } }> } | undefined)?.annotations ?? [];
    const citations: Citation[] = annotations.filter((a) => a.type === 'url_citation' && a.url_citation?.url).map((a) => ({ url: a.url_citation!.url, title: a.url_citation!.title }));
    return { kind: 'ok', value: r.data, usage, model, latencyMs, ...(citations.length ? { citations } : {}) };
  }
}
