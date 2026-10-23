/**
 * The speech gate listens to one prospect leg from the moment it answers and calls "person" or
 * "machine" as early as the evidence allows. It runs beside carrier AMD; whichever verdict lands
 * first settles the line (the engine makes that atomic). The gate holds no audio: frames are
 * decoded, measured, handed to the recognizer, and dropped.
 */
import { mulawToPcm16 } from './audio.js';
import { judgeAnswer, type Evidence, type JudgeOptions, type Judgement } from './judge.js';
import { JevJudge } from './jev.js';
import type { SpeechProvider, SpeechStream } from './providers/types.js';
import { EnergyVad } from './vad.js';

export interface GateVerdict extends Judgement {
  /** Audio heard before the verdict (ms since the stream started). */
  latencyMs: number;
  /** Words heard, truncated; kept on the line as evidence. */
  text: string;
  /** Which recognizer and judge produced it. */
  provider: string;
  judge: 'rules' | 'jev';
  costUsd?: number | null;
}

export interface GateOptions {
  provider: SpeechProvider;
  /** Tie-breaker; when set, ambiguous or low-confidence pickups are put to Jev. */
  jev?: JevJudge | null;
  judge?: JudgeOptions;
  /** Rule verdicts below this confidence are checked with Jev first (when available). */
  confirmBelow?: number;
  /** Ask Jev when words exist but no rule has fired after this much speech (ms). */
  askAfterMs?: number;
  hints?: Record<string, string>;
  sampleRate?: number;
  onVerdict: (v: GateVerdict) => void | Promise<void>;
  /** Called once when the gate gives up (max audio reached, recognizer error) without a verdict. */
  onGiveUp?: (reason: string) => void;
}

const MAX_TEXT = 160;

export class SpeechGate {
  private readonly vad: EnergyVad;
  private readonly stream: SpeechStream;
  private text = '';
  private final = false;
  private done = false;
  private asking: string | null = null;
  private asked = new Set<string>();
  private readonly rate: number;
  constructor(private readonly o: GateOptions) {
    this.rate = o.sampleRate ?? 8000;
    this.vad = new EnergyVad({ sampleRate: this.rate });
    this.stream = o.provider.open({ hints: o.hints });
    this.stream.onText((t) => {
      if (this.done) return;
      this.text = t.text.slice(0, MAX_TEXT);
      this.final = t.final;
      this.evaluate();
    });
    this.stream.onError(() => {
      // Keep the timing rules running without words; they still beat AMD on a plain "Hello?".
    });
  }

  get evidence(): Evidence {
    return { ...this.vad.t, text: this.text, final: this.final };
  }

  /** One Media Streams frame (base64 μ-law) or raw μ-law bytes. */
  media(payload: string | Uint8Array) {
    if (this.done) return;
    const bytes = typeof payload === 'string' ? new Uint8Array(Buffer.from(payload, 'base64')) : payload;
    const pcm = mulawToPcm16(bytes);
    this.vad.push(pcm);
    this.stream.push(pcm, this.rate);
    this.evaluate();
  }

  /** Stop listening without a verdict (call ended, socket closed). */
  stop() {
    if (this.done) return;
    this.done = true;
    this.stream.close();
  }

  private evaluate() {
    if (this.done) return;
    const e = this.evidence;
    const j = judgeAnswer(e, this.o.judge);
    if (j?.verdict === 'unknown') return this.giveUp(j.reason);
    if (j && j.confidence >= (this.o.confirmBelow ?? 0.75)) return this.settle(j, 'rules');
    // Rules are unsure. With words on the table and Jev configured, ask once per distinct transcript;
    // after Jev has had its say (or failed) on these words, the rules decide.
    const key = e.text.trim().toLowerCase();
    if (this.o.jev && key && e.firstSpeechMs !== null && !this.asked.has(key)) {
      const spokenMs = e.elapsedMs - e.firstSpeechMs;
      if (j || spokenMs >= (this.o.askAfterMs ?? 900)) void this.ask(e, j);
      return;
    }
    if (this.asking) return;
    if (j) this.settle(j, 'rules');
  }

  private async ask(e: Evidence, fallback: Judgement | null) {
    const key = e.text.trim().toLowerCase();
    if (this.asking || this.asked.has(key)) return;
    this.asking = key;
    const r = await this.o.jev!.judge(e);
    this.asking = null;
    this.asked.add(key);
    if (this.done) return;
    if (r && r.verdict !== 'unknown' && r.confidence >= 0.6) return this.settle({ verdict: r.verdict, reason: r.reason, confidence: r.confidence }, 'jev', r.costUsd);
    // Jev was unsure or unreachable: take the rule's answer if it had one, otherwise re-read the
    // evidence now (frames kept arriving while we waited) and let the rules decide from here on.
    if (fallback && fallback.verdict !== 'unknown') this.settle(fallback, 'rules');
    else this.evaluate();
  }

  private settle(j: Judgement, judge: 'rules' | 'jev', costUsd?: number | null) {
    if (this.done) return;
    this.done = true;
    this.stream.close();
    void this.o.onVerdict({ ...j, latencyMs: Math.round(this.vad.t.elapsedMs), text: this.text, provider: this.o.provider.kind, judge, costUsd: costUsd ?? null });
  }

  private giveUp(reason: string) {
    if (this.done) return;
    this.done = true;
    this.stream.close();
    this.o.onGiveUp?.(reason);
  }
}
