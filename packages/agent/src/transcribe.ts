/**
 * Call transcription without a vendor SDK:
 *  - split a dual-channel WAV (rep = left, prospect = right) into two mono files in pure Node
 *  - send each to an OpenAI-compatible `/audio/transcriptions` endpoint (OpenAI Whisper, or any
 *    self-hosted whisper server with the same API)
 *  - merge the segments into a speaker-labelled transcript and compute talk statistics
 */

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
}

export function parseWav(buf: Buffer): WavInfo {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let off = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body);
      if (format !== 1) throw new Error(`unsupported WAV format ${format} (need PCM)`);
      fmt = { channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data chunk before fmt chunk');
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, dataOffset: body, dataLength: Math.min(size, buf.length - body) };
    }
    off = body + size + (size % 2);
  }
  throw new Error('WAV data chunk not found');
}

function wavHeader(dataLength: number, sampleRate: number, channels: number, bits: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + dataLength, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataLength, 40);
  return h;
}

/** Deinterleave a stereo 16-bit PCM WAV into two mono WAVs. Mono input returns the same audio for both. */
export function splitChannels(buf: Buffer): { left: Buffer; right: Buffer; durationSeconds: number; info: WavInfo } {
  const info = parseWav(buf);
  if (info.bitsPerSample !== 16) throw new Error(`unsupported bit depth ${info.bitsPerSample}`);
  const frameBytes = (info.channels * info.bitsPerSample) / 8;
  const frames = Math.floor(info.dataLength / frameBytes);
  const durationSeconds = frames / info.sampleRate;
  if (info.channels === 1) {
    const mono = Buffer.concat([wavHeader(info.dataLength, info.sampleRate, 1, 16), buf.subarray(info.dataOffset, info.dataOffset + info.dataLength)]);
    return { left: mono, right: mono, durationSeconds, info };
  }
  const l = Buffer.alloc(frames * 2);
  const r = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const src = info.dataOffset + i * frameBytes;
    l.writeInt16LE(buf.readInt16LE(src), i * 2);
    r.writeInt16LE(buf.readInt16LE(src + 2), i * 2);
  }
  return { left: Buffer.concat([wavHeader(l.length, info.sampleRate, 1, 16), l]), right: Buffer.concat([wavHeader(r.length, info.sampleRate, 1, 16), r]), durationSeconds, info };
}

/** Fraction of 20 ms frames above a small RMS threshold: tells us whether a channel carries speech. */
export function activityRatio(monoWav: Buffer, threshold = 300): number {
  const info = parseWav(monoWav);
  const frame = Math.max(1, Math.floor(info.sampleRate * 0.02));
  const samples = Math.floor(info.dataLength / 2);
  if (!samples) return 0;
  let active = 0;
  let total = 0;
  for (let s = 0; s + frame <= samples; s += frame) {
    let acc = 0;
    for (let i = 0; i < frame; i++) {
      const v = monoWav.readInt16LE(info.dataOffset + (s + i) * 2);
      acc += v * v;
    }
    if (Math.sqrt(acc / frame) > threshold) active++;
    total++;
  }
  return total ? active / total : 0;
}

export interface TranscriptSegment {
  speaker: 'rep' | 'prospect';
  start: number;
  end: number;
  text: string;
}

export interface TranscribeConfig {
  apiBase: string;
  apiKey?: string;
  model: string;
  fetchImpl?: typeof fetch;
  language?: string;
}

/** OpenAI-compatible speech to text. Returns timed segments (verbose_json) or one segment for plain text servers. */
export async function transcribeWav(cfg: TranscribeConfig, wav: Buffer, opts: { filename?: string; prompt?: string } = {}): Promise<Array<{ start: number; end: number; text: string }>> {
  const form = new FormData();
  form.set('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), opts.filename ?? 'audio.wav');
  form.set('model', cfg.model);
  form.set('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (cfg.language) form.set('language', cfg.language);
  if (opts.prompt) form.set('prompt', opts.prompt);
  const res = await (cfg.fetchImpl ?? fetch)(`${cfg.apiBase.replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', headers: cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}, body: form });
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { text?: string; segments?: Array<{ start: number; end: number; text: string }>; duration?: number };
  if (json.segments?.length) return json.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? '').trim() })).filter((s) => s.text);
  return json.text?.trim() ? [{ start: 0, end: Number(json.duration) || 0, text: json.text.trim() }] : [];
}

/** Interleave two channels' segments by start time. */
export function mergeSegments(rep: Array<{ start: number; end: number; text: string }>, prospect: Array<{ start: number; end: number; text: string }>): TranscriptSegment[] {
  return [...rep.map((s) => ({ ...s, speaker: 'rep' as const })), ...prospect.map((s) => ({ ...s, speaker: 'prospect' as const }))].sort((a, b) => a.start - b.start || (a.speaker === 'rep' ? -1 : 1));
}

export const transcriptText = (segs: TranscriptSegment[]) => segs.map((s) => `[${fmtTime(s.start)}] ${s.speaker === 'rep' ? 'Rep' : 'Prospect'}: ${s.text}`).join('\n');
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

export interface TalkStats {
  durationSeconds: number;
  repTalkSeconds: number;
  prospectTalkSeconds: number;
  /** Rep share of all speech time, 0..1. */
  talkRatio: number;
  longestRepMonologueSeconds: number;
  longestProspectMonologueSeconds: number;
  repQuestions: number;
  prospectQuestions: number;
  repWordsPerMinute: number;
  /** Times a speaker started while the other was still talking. */
  interruptionsByRep: number;
  interruptionsByProspect: number;
  switches: number;
}

/** Talk-time analytics from the merged transcript. Monologues merge adjacent same-speaker segments with < 1.5 s gaps. */
export function talkStats(segs: TranscriptSegment[], durationSeconds: number): TalkStats {
  const dur = (s: TranscriptSegment) => Math.max(0, s.end - s.start);
  const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const questions = (t: string) => (t.match(/\?/g) ?? []).length;
  let rep = 0;
  let pro = 0;
  let repWords = 0;
  let rq = 0;
  let pq = 0;
  for (const s of segs) {
    if (s.speaker === 'rep') {
      rep += dur(s);
      repWords += words(s.text);
      rq += questions(s.text);
    } else {
      pro += dur(s);
      pq += questions(s.text);
    }
  }
  const monologues = { rep: 0, prospect: 0 };
  let cur = null as TranscriptSegment | null;
  let switches = 0;
  let intRep = 0;
  let intPro = 0;
  const lastEndBySpeaker: Record<'rep' | 'prospect', number> = { rep: -1, prospect: -1 };
  for (const s of segs) {
    const prev = cur as TranscriptSegment | null;
    if (prev && prev.speaker === s.speaker && s.start - prev.end < 1.5) cur = { speaker: prev.speaker, start: prev.start, text: prev.text, end: Math.max(prev.end, s.end) };
    else {
      if (cur) monologues[cur.speaker] = Math.max(monologues[cur.speaker], dur(cur));
      if (cur && cur.speaker !== s.speaker) {
        switches++;
        const other = s.speaker === 'rep' ? 'prospect' : 'rep';
        if (lastEndBySpeaker[other] > s.start + 0.3) s.speaker === 'rep' ? intRep++ : intPro++;
      }
      cur = { ...s };
    }
    lastEndBySpeaker[s.speaker] = Math.max(lastEndBySpeaker[s.speaker], s.end);
  }
  if (cur) monologues[cur.speaker] = Math.max(monologues[cur.speaker], dur(cur));
  const total = rep + pro;
  return {
    durationSeconds: Math.round(durationSeconds),
    repTalkSeconds: Math.round(rep),
    prospectTalkSeconds: Math.round(pro),
    talkRatio: total ? Math.round((rep / total) * 100) / 100 : 0,
    longestRepMonologueSeconds: Math.round(monologues.rep),
    longestProspectMonologueSeconds: Math.round(monologues.prospect),
    repQuestions: rq,
    prospectQuestions: pq,
    repWordsPerMinute: rep > 0 ? Math.round(repWords / (rep / 60)) : 0,
    interruptionsByRep: intRep,
    interruptionsByProspect: intPro,
    switches,
  };
}
