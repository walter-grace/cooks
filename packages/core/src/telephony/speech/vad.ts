/**
 * Energy-based voice activity with an adaptive noise floor. It is deliberately simple: the gate
 * needs a timeline (when speech started, how long the current run is, how long the silence after
 * it has lasted, whether a beep played), not word boundaries. Words come from the recognizer.
 */
import { isTonal, rms } from './audio.js';

export interface VadTimeline {
  /** Audio received so far (ms). */
  elapsedMs: number;
  /** Total voiced audio so far (ms). */
  speechMs: number;
  /** Current voiced run (ms), 0 when silent. */
  runMs: number;
  /** Longest voiced run seen (ms). */
  longestRunMs: number;
  /** Silence since the last voiced frame (ms); 0 while speaking; null before any speech. */
  silenceAfterSpeechMs: number | null;
  /** When the first voiced frame arrived (ms since stream start), null before speech. */
  firstSpeechMs: number | null;
  /** Number of separate voiced runs (turns). */
  runs: number;
  /** Milliseconds of tonal (beep-like) audio seen. */
  beepMs: number;
  /** True once a beep of at least `beepMinMs` has been heard. */
  beep: boolean;
}

export interface VadOptions {
  sampleRate?: number;
  /** Frames below this level are never speech. */
  minLevel?: number;
  /** Speech must exceed the noise floor by this factor. */
  ratio?: number;
  /** Gaps shorter than this inside a run do not end it (ms). */
  hangoverMs?: number;
  /** A tone must last this long to count as a beep (ms). */
  beepMinMs?: number;
}

export class EnergyVad {
  private floor = 0.004;
  private hang = 0;
  private inRun = false;
  private readonly sampleRate: number;
  private readonly minLevel: number;
  private readonly ratio: number;
  private readonly hangoverMs: number;
  private readonly beepMinMs: number;
  readonly t: VadTimeline = { elapsedMs: 0, speechMs: 0, runMs: 0, longestRunMs: 0, silenceAfterSpeechMs: null, firstSpeechMs: null, runs: 0, beepMs: 0, beep: false };

  constructor(o: VadOptions = {}) {
    this.sampleRate = o.sampleRate ?? 8000;
    this.minLevel = o.minLevel ?? 0.01;
    this.ratio = o.ratio ?? 3;
    this.hangoverMs = o.hangoverMs ?? 120;
    this.beepMinMs = o.beepMinMs ?? 150;
  }

  /** Feed one frame of 16-bit PCM; returns the updated timeline. */
  push(frame: Int16Array): VadTimeline {
    const ms = (frame.length / this.sampleRate) * 1000;
    const level = rms(frame);
    const t = this.t;
    t.elapsedMs += ms;
    const voiced = level >= this.minLevel && level >= this.floor * this.ratio;
    if (voiced) {
      const tonal = isTonal(frame, this.sampleRate);
      if (tonal) {
        t.beepMs += ms;
        if (t.beepMs >= this.beepMinMs) t.beep = true;
      } else {
        // Speech pulls the floor up slowly so a noisy line is not voiced forever.
        this.floor = Math.min(this.floor * 1.01, 0.05);
      }
      if (!this.inRun) {
        this.inRun = true;
        t.runs += 1;
        t.runMs = 0;
        if (t.firstSpeechMs === null) t.firstSpeechMs = t.elapsedMs - ms;
      }
      this.hang = this.hangoverMs;
      t.runMs += ms;
      t.speechMs += ms;
      t.longestRunMs = Math.max(t.longestRunMs, t.runMs);
      t.silenceAfterSpeechMs = 0;
    } else {
      // Silence tracks the floor quickly.
      this.floor = this.floor * 0.9 + level * 0.1;
      if (this.inRun && this.hang > 0) {
        this.hang -= ms;
        t.runMs += ms;
      } else if (this.inRun) {
        this.inRun = false;
        t.runMs = 0;
      }
      if (t.firstSpeechMs !== null && !this.inRun) t.silenceAfterSpeechMs = (t.silenceAfterSpeechMs ?? 0) + ms;
      else if (t.firstSpeechMs !== null && this.inRun) t.silenceAfterSpeechMs = 0;
    }
    return t;
  }
}
