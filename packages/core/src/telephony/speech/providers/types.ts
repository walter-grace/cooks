/**
 * Streaming speech recognizers behind one small interface. The gate pushes 16-bit PCM frames
 * and listens for text; providers own their own network or native handles.
 */
export interface SpeechText {
  text: string;
  /** The recognizer closed this utterance. */
  final: boolean;
}

export interface SpeechStream {
  /** Feed PCM16 at `sampleRate` (the gate sends 8 kHz frames; providers resample as needed). */
  push(frame: Int16Array, sampleRate: number): void;
  /** Release handles. Idempotent. */
  close(): void;
  onText(cb: (t: SpeechText) => void): void;
  onError(cb: (e: Error) => void): void;
}

export interface SpeechProvider {
  readonly kind: 'mock' | 'openai' | 'sherpa';
  /** `hints` are the stream's custom parameters (used by the mock to script a transcript). */
  open(opts: { hints?: Record<string, string> }): SpeechStream;
}

export interface SpeechConfig {
  provider?: 'off' | 'mock' | 'openai' | 'sherpa';
  /** OpenAI realtime key (defaults to OPENAI_API_KEY). */
  apiKey?: string;
  /** OpenAI realtime base (wss://api.openai.com/v1) or a mock. */
  apiBase?: string;
  /** OpenAI transcription model (default gpt-live-transcribe). */
  model?: string;
  /** sherpa-onnx: directory holding encoder/decoder/joiner .onnx + tokens.txt of a streaming transducer. */
  modelDir?: string;
  /** Jev tie-breaker via OpenRouter. */
  jev?: { apiKey?: string; model?: string; baseUrl?: string };
}

/** Base class with the listener plumbing every provider needs. */
export abstract class BaseSpeechStream implements SpeechStream {
  private textCbs: Array<(t: SpeechText) => void> = [];
  private errCbs: Array<(e: Error) => void> = [];
  protected closed = false;
  onText(cb: (t: SpeechText) => void) {
    this.textCbs.push(cb);
  }
  onError(cb: (e: Error) => void) {
    this.errCbs.push(cb);
  }
  protected emit(t: SpeechText) {
    if (this.closed) return;
    for (const cb of this.textCbs) cb(t);
  }
  protected fail(e: Error) {
    if (this.closed) return;
    for (const cb of this.errCbs) cb(e);
  }
  abstract push(frame: Int16Array, sampleRate: number): void;
  close() {
    this.closed = true;
  }
}
