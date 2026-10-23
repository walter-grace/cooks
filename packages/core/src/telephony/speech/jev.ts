/**
 * Tie-breaker for the speech gate: TypeSafe's Jev on OpenRouter. Jev is a decision model, not a
 * chat model: it takes state plus typed questions and returns a choice with probabilities in a
 * few hundred milliseconds, and output tokens are free. We ask one Choice question over the
 * transcript and timing. The key is read in-process and never logged.
 * Docs: https://openrouter.ai/docs/guides/community/jev
 */
import type { Evidence, Judgement } from './judge.js';

export interface JevOptions {
  apiKey: string;
  /** Default `typesafe/jev-1.14`; `~typesafe/jev-latest` tracks the newest release. */
  model?: string;
  baseUrl?: string;
  /** Hard cap on the round trip; the gate must never wait on the network (ms). */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export const JEV_DEFAULT_MODEL = 'typesafe/jev-1.14';

interface DecisionsResponse {
  answers?: Record<string, { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number> }>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}

export class JevJudge {
  readonly kind = 'jev' as const;
  private readonly model: string;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly o: JevOptions) {
    this.model = o.model ?? JEV_DEFAULT_MODEL;
    this.url = `${(o.baseUrl ?? 'https://openrouter.ai/api').replace(/\/+$/, '')}/alpha/decisions`;
    this.timeoutMs = o.timeoutMs ?? 700;
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  /** Resolves null on timeout, network error or an unexpected body; the gate then falls back to AMD. */
  async judge(e: Evidence): Promise<(Judgement & { probabilities: Record<string, number>; costUsd: number | null }) | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json', 'HTTP-Referer': 'https://github.com/walter-grace/cooks', 'X-Title': 'Cooks' },
        body: JSON.stringify({
          model: this.model,
          state: {
            context: 'An outbound sales call was just answered. This is what the called party said in the first moments, with timing from a voice-activity detector.',
            transcript: e.text,
            timing: { msSinceAnswer: Math.round(e.elapsedMs), speechMs: Math.round(e.speechMs), longestContinuousSpeechMs: Math.round(e.longestRunMs), silenceAfterSpeechMs: e.silenceAfterSpeechMs === null ? null : Math.round(e.silenceAfterSpeechMs), separateUtterances: e.runs, beepHeard: e.beep },
          },
          questions: {
            answered_by: {
              type: 'choice',
              instructions: 'Who or what answered this phone call?',
              criteria: {
                human: 'A live person picked up: a short greeting such as "Hello?", a name, a company name, or a question, then they wait for the caller.',
                voicemail: 'A voicemail or answering-machine greeting: a recorded message, usually longer, asking the caller to leave a message, mentioning being unavailable, or ending in a tone.',
                ivr: 'An automated phone system or menu: options to press, a directory, hold music, business hours.',
                unclear: 'Not enough was said or heard to tell.',
              },
            },
          },
        }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as DecisionsResponse;
      const a = body.answers?.answered_by;
      if (!a || a.type !== 'choice' || !a.choice) return null;
      const probabilities = a.probabilities ?? {};
      const verdict: Judgement['verdict'] = a.choice === 'human' ? 'human' : a.choice === 'voicemail' || a.choice === 'ivr' ? 'machine' : 'unknown';
      return { verdict, reason: `jev:${a.choice}`, confidence: a.confidence ?? probabilities[a.choice] ?? 0.5, probabilities, costUsd: body.usage?.cost ?? null };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
