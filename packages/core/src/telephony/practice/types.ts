/**
 * Practice calls: a rep rehearses against an AI prospect that listens and talks at the same time.
 * The partner sits behind this small port so the voice can be OpenAI Realtime today and a local
 * full-duplex model (Block's Dessa, NVIDIA's VoiceChat) when one is available.
 */
export type PartnerRole = 'rep' | 'partner';

export type PartnerEvent =
  | { type: 'ready' }
  /** Partner speech, PCM16 mono at `sampleRate`. */
  | { type: 'audio'; pcm: Int16Array; sampleRate: number }
  | { type: 'transcript'; role: PartnerRole; text: string; final: boolean }
  /** The rep started or stopped talking, as the partner's turn detector heard it. */
  | { type: 'turn'; role: 'rep'; state: 'start' | 'stop' }
  /** The rep started talking over the partner; anything queued for playback should be dropped. */
  | { type: 'interrupt' }
  | { type: 'error'; message: string };

export interface PartnerOpenOptions {
  /** Who the partner is and how to behave, in plain prose. */
  instructions: string;
  /** How the partner answers the phone (spoken first, before the rep says anything). */
  opening?: string;
  voice?: string;
  /** Sample rate of the frames the rep's microphone will push. */
  sampleRate: number;
}

export interface PartnerSession {
  /** Feed rep audio, PCM16 mono. */
  push(frame: Int16Array, sampleRate: number): void;
  on(cb: (e: PartnerEvent) => void): void;
  /** Release handles. Idempotent. */
  close(): void;
}

export interface VoicePartner {
  readonly kind: 'mock' | 'openai' | 'local';
  open(opts: PartnerOpenOptions): PartnerSession;
}

export interface PracticeConfig {
  provider?: 'off' | 'mock' | 'openai' | 'local';
  /** OpenAI Realtime key (defaults to OPENAI_API_KEY). */
  apiKey?: string;
  /** OpenAI Realtime base (wss://api.openai.com/v1) or a mock. */
  apiBase?: string;
  /** OpenAI speech-to-speech model id. */
  model?: string;
  /** Partner voice name (provider specific). */
  voice?: string;
  /** `local`: WebSocket URL of a runner that speaks the Cooks duplex protocol (see docs/practice.md). */
  localUrl?: string;
  /** Hard cap per practice call. */
  maxSeconds?: number;
}

export abstract class BasePartnerSession implements PartnerSession {
  private cbs: Array<(e: PartnerEvent) => void> = [];
  protected closed = false;
  on(cb: (e: PartnerEvent) => void) {
    this.cbs.push(cb);
  }
  protected emit(e: PartnerEvent) {
    if (this.closed) return;
    for (const cb of this.cbs) cb(e);
  }
  abstract push(frame: Int16Array, sampleRate: number): void;
  close() {
    this.closed = true;
  }
}
