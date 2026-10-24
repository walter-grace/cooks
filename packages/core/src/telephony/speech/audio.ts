/**
 * Small, dependency-free audio helpers for the speech gate. Twilio Media Streams deliver 8 kHz
 * G.711 μ-law mono in 20 ms frames (160 bytes). Everything here works on one frame at a time.
 */

const MULAW_BIAS = 0x84;
const MULAW_TABLE: Int16Array = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    const u = ~i & 0xff;
    const sign = u & 0x80;
    const exponent = (u >> 4) & 0x07;
    const mantissa = u & 0x0f;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    t[i] = sign ? -sample : sample;
  }
  return t;
})();

/** G.711 μ-law bytes → 16-bit PCM. */
export function mulawToPcm16(bytes: Uint8Array): Int16Array {
  const out = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = MULAW_TABLE[bytes[i]!]!;
  return out;
}

/** 16-bit PCM → μ-law byte (used by the mock carrier and tests). */
export function pcm16ToMulaw(sample: number): number {
  const CLIP = 32635;
  let s = Math.max(-CLIP, Math.min(CLIP, Math.round(sample)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; exponent--, mask >>= 1);
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** Root-mean-square level of a frame on a 0..1 scale. */
export function rms(frame: Int16Array): number {
  if (!frame.length) return 0;
  let acc = 0;
  for (let i = 0; i < frame.length; i++) {
    const v = frame[i]! / 32768;
    acc += v * v;
  }
  return Math.sqrt(acc / frame.length);
}

/** Linear-interpolation resample to Float32 in -1..1 (good enough for 8 kHz → 16/24 kHz speech). */
export function resampleToFloat32(frame: Int16Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) {
    const out = new Float32Array(frame.length);
    for (let i = 0; i < frame.length; i++) out[i] = frame[i]! / 32768;
    return out;
  }
  const ratio = fromRate / toRate;
  const n = Math.floor(frame.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(frame.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = ((frame[i0]! * (1 - frac) + frame[i1]! * frac) / 32768);
  }
  return out;
}

/** Float32 -1..1 → little-endian 16-bit PCM bytes (what remote recognizers want on the wire). */
export function float32ToPcm16Bytes(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(samples[i]! * 32767))), true);
  return out;
}

/** Goertzel power at one frequency, normalised by frame energy (0..1). */
export function tonePower(frame: Int16Array, sampleRate: number, freq: number): number {
  const n = frame.length;
  if (!n) return 0;
  const k = Math.round((n * freq) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let energy = 0;
  for (let i = 0; i < n; i++) {
    const x = frame[i]! / 32768;
    energy += x * x;
    s0 = x + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  if (energy <= 0) return 0;
  // Goertzel power of a bin-aligned sinusoid is N²A²/4 and its energy NA²/2, so 2·power/(N·energy) → 1.
  const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / n;
  return Math.min(1, (2 * power) / energy);
}

/** Frequencies answering machines commonly beep at. A pure tone shows up as one dominant bin. */
export const BEEP_FREQS = [800, 900, 1000, 1200, 1400, 1600, 2000];

/** True when a single tone dominates the frame (a beep, not speech). */
export function isTonal(frame: Int16Array, sampleRate: number, threshold = 0.7): boolean {
  let best = 0;
  for (const f of BEEP_FREQS) best = Math.max(best, tonePower(frame, sampleRate, f));
  return best >= threshold;
}
