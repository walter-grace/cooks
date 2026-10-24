/**
 * OpenAI Realtime transcription over WebSocket (`?intent=transcription`). We resample the 8 kHz
 * line audio to 24 kHz PCM16, append it to the input buffer, and read transcript deltas.
 * Written against the published guide; not yet exercised against a live account from this repo.
 * Docs: https://developers.openai.com/api/docs/guides/realtime-transcription
 */
import { float32ToPcm16Bytes, resampleToFloat32 } from '../audio.js';
import { BaseSpeechStream, type SpeechProvider } from './types.js';

export interface OpenAiRealtimeOptions {
  apiKey: string;
  /** Default wss://api.openai.com/v1 */
  apiBase?: string;
  /** Default gpt-live-transcribe */
  model?: string;
  /** Hint words (names, company) that help the recognizer on the first syllables. */
  keywords?: string[];
}

const RATE = 24_000;

class OpenAiStream extends BaseSpeechStream {
  private ws: WebSocket | null = null;
  private ready = false;
  private backlog: Uint8Array[] = [];
  private current = '';
  constructor(o: OpenAiRealtimeOptions) {
    super();
    const url = `${(o.apiBase ?? 'wss://api.openai.com/v1').replace(/^http/, 'ws').replace(/\/+$/, '')}/realtime?intent=transcription`;
    let ws: WebSocket;
    try {
      // Node's global WebSocket accepts headers through the (non-standard) second argument object.
      ws = new (WebSocket as unknown as new (u: string, init: unknown) => WebSocket)(url, { headers: { authorization: `Bearer ${o.apiKey}`, 'OpenAI-Beta': 'realtime=v1' } });
    } catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'session.update', session: { type: 'transcription', audio: { input: { format: { type: 'audio/pcm', rate: RATE }, transcription: { model: o.model ?? 'gpt-live-transcribe', ...(o.keywords?.length ? { keywords: o.keywords.slice(0, 20) } : {}), delay: 'minimal' }, turn_detection: null } } } }));
      this.ready = true;
      for (const b of this.backlog) this.send(b);
      this.backlog = [];
    });
    ws.addEventListener('message', (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type: string; delta?: string; transcript?: string; error?: { message?: string } };
        if (m.type === 'conversation.item.input_audio_transcription.delta' && m.delta) {
          this.current += m.delta;
          this.emit({ text: this.current, final: false });
        } else if (m.type === 'conversation.item.input_audio_transcription.completed') {
          this.current = m.transcript ?? this.current;
          this.emit({ text: this.current, final: true });
          this.current = '';
        } else if (m.type === 'error') this.fail(new Error(m.error?.message ?? 'realtime error'));
      } catch {
        /* ignore non-JSON frames */
      }
    });
    ws.addEventListener('error', () => this.fail(new Error('realtime socket error')));
  }
  private send(pcm: Uint8Array) {
    this.ws?.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') }));
  }
  push(frame: Int16Array, sampleRate: number) {
    if (this.closed) return;
    const bytes = float32ToPcm16Bytes(resampleToFloat32(frame, sampleRate, RATE));
    if (this.ready) this.send(bytes);
    else if (this.backlog.length < 400) this.backlog.push(bytes);
  }
  override close() {
    super.close();
    try {
      this.ws?.close();
    } catch {
      /* already closed */
    }
    this.ws = null;
  }
}

export class OpenAiRealtimeProvider implements SpeechProvider {
  readonly kind = 'openai' as const;
  constructor(private readonly o: OpenAiRealtimeOptions) {}
  open(opts: { hints?: Record<string, string> }) {
    const kw = opts.hints?.keywords?.split('|').filter(Boolean);
    return new OpenAiStream({ ...this.o, keywords: kw ?? this.o.keywords });
  }
}
