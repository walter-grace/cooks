/**
 * Scripted partner for tests and demos: answers the phone, then replies with the next line each
 * time the rep stops talking (energy-based turn detection), with a short tone as "speech".
 */
import { rms } from '../speech/audio.js';
import { BasePartnerSession, type PartnerOpenOptions, type VoicePartner } from './types.js';

const OUT_RATE = 24_000;
const DEFAULT_LINES = [
  "Sorry, who is this? I'm in the middle of something.",
  "We already have something for that. What makes you different?",
  "Send me an email and I'll take a look.",
  "Fine. Twenty minutes on Thursday, and bring numbers.",
];

function tone(ms: number, hz = 440): Int16Array {
  const n = Math.round((OUT_RATE * ms) / 1000);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.round(6000 * Math.sin((2 * Math.PI * hz * i) / OUT_RATE));
  return out;
}

class MockSession extends BasePartnerSession {
  private speechMs = 0;
  private silenceMs = 0;
  private turn = 0;
  private talking = false;
  constructor(private lines: string[], o: PartnerOpenOptions) {
    super();
    queueMicrotask(() => {
      this.emit({ type: 'ready' });
      this.say(o.opening ?? 'Hello, this is Dana.');
    });
  }
  /** Audio first, transcript when the turn is done: the order real providers use. */
  private say(text: string) {
    this.emit({ type: 'audio', pcm: tone(300), sampleRate: OUT_RATE });
    this.emit({ type: 'transcript', role: 'partner', text, final: true });
    this.talking = true;
  }
  push(frame: Int16Array, sampleRate: number) {
    if (this.closed) return;
    const ms = (frame.length / sampleRate) * 1000;
    const loud = rms(frame) > 0.02; // about -34 dBFS; room noise sits well under this
    if (loud) {
      if (this.speechMs === 0) this.emit({ type: 'turn', role: 'rep', state: 'start' });
      if (this.talking && this.speechMs === 0) {
        this.talking = false;
        this.emit({ type: 'interrupt' });
      }
      this.speechMs += ms;
      this.silenceMs = 0;
      return;
    }
    if (this.speechMs === 0) return;
    this.silenceMs += ms;
    if (this.speechMs >= 400 && this.silenceMs >= 300) {
      const sec = Math.round(this.speechMs / 100) / 10;
      this.turn += 1;
      this.emit({ type: 'turn', role: 'rep', state: 'stop' });
      this.emit({ type: 'transcript', role: 'rep', text: `(rep spoke for ${sec} s)`, final: true });
      this.say(this.lines[Math.min(this.turn - 1, this.lines.length - 1)] ?? '…');
      this.speechMs = 0;
      this.silenceMs = 0;
    }
  }
}

export class MockVoicePartner implements VoicePartner {
  readonly kind = 'mock' as const;
  constructor(private lines: string[] = DEFAULT_LINES) {}
  open(o: PartnerOpenOptions) {
    return new MockSession(this.lines, o);
  }
}
