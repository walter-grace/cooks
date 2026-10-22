import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LlmProvider, StructuredRequest, StructuredResult, TokenUsage } from './types.js';
import { estimateCostUsd } from './pricing.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Claude via the official SDK. Structured JSON through `output_config.format`; adaptive thinking is
 * the model default (omitted), depth controlled with `output_config.effort`; server-side refusal
 * fallbacks enabled so a policy decline on one model is retried on the default chain.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  private client: Anthropic;
  constructor(
    public readonly model: string = ANTHROPIC_DEFAULT_MODEL,
    opts: { apiKey?: string; baseUrl?: string } = {},
  ) {
    this.client = new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}), maxRetries: 2, timeout: 120_000 });
  }

  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const message = await this.client.beta.messages.parse(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: req.user }],
        output_config: { format: zodOutputFormat(req.schema), effort: req.effort ?? 'medium' },
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      },
      { signal: req.signal },
    );
    const usage: TokenUsage = {
      input: message.usage.input_tokens,
      output: message.usage.output_tokens,
      cacheRead: message.usage.cache_read_input_tokens ?? 0,
      cacheWrite: message.usage.cache_creation_input_tokens ?? 0,
      costUsd: null,
    };
    usage.costUsd = estimateCostUsd(message.model, usage);
    const latencyMs = Date.now() - started;
    if (message.stop_reason === 'refusal') {
      const details = (message as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
      return { kind: 'refusal', reason: details?.explanation ?? details?.category ?? 'refused', usage, model: message.model, latencyMs };
    }
    const parsed = (message as { parsed_output?: T | null }).parsed_output;
    if (parsed === null || parsed === undefined) {
      const text = message.content
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const r = req.schema.safeParse(tryJson(text));
      if (r.success) return { kind: 'ok', value: r.data, usage, model: message.model, latencyMs };
      return { kind: 'invalid', error: r.error.message, text, usage, model: message.model, latencyMs };
    }
    return { kind: 'ok', value: parsed, usage, model: message.model, latencyMs, raw: message };
  }
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    const m = /\{[\s\S]*\}/.exec(s);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
