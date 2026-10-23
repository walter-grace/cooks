/**
 * Scripted recognizer for tests and the mock carrier. The script rides in the stream's custom
 * parameters as `qaScript`: JSON `[{ "atMs": 450, "text": "Hello?", "final": true }]`. Time is
 * measured in audio pushed, not wall clock, so tests are deterministic.
 */
import { BaseSpeechStream, type SpeechProvider, type SpeechText } from './types.js';

interface Cue extends SpeechText {
  atMs: number;
}

class MockStream extends BaseSpeechStream {
  private audioMs = 0;
  private cues: Cue[];
  constructor(script: Cue[]) {
    super();
    this.cues = [...script].sort((a, b) => a.atMs - b.atMs);
  }
  push(frame: Int16Array, sampleRate: number) {
    this.audioMs += (frame.length / sampleRate) * 1000;
    while (this.cues.length && this.cues[0]!.atMs <= this.audioMs) {
      const c = this.cues.shift()!;
      this.emit({ text: c.text, final: !!c.final });
    }
  }
}

export class MockSpeechProvider implements SpeechProvider {
  readonly kind = 'mock' as const;
  open(opts: { hints?: Record<string, string> }) {
    let script: Cue[] = [];
    try {
      const raw = opts.hints?.qaScript;
      if (raw) script = (JSON.parse(raw) as Cue[]).filter((c) => typeof c.atMs === 'number' && typeof c.text === 'string');
    } catch {
      script = [];
    }
    return new MockStream(script);
  }
}
