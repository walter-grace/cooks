/**
 * OpenAI Realtime speech-to-speech as the practice partner. Rep audio is resampled to 24 kHz PCM16
 * and appended to the input buffer; server VAD turns it into turns, interrupts the partner when the
 * rep talks over it, and transcribes both sides. Written against the published Realtime guide and
 * not yet exercised against a live account from this repo; set PRACTICE_MODEL to the current
 * speech-to-speech model id if the default has moved on.
 * Docs: https://developers.openai.com/api/docs/guides/realtime-conversations
 */
import { float32ToPcm16Bytes, resampleToFloat32 } from '../speech/audio.js';
import { BasePartnerSession, type PartnerOpenOptions, type VoicePartner } from './types.js';

export interface OpenAiPartnerOptions {
  apiKey: string;
  /** Default wss://api.openai.com/v1 */
  apiBase?: string;
  /** Default gpt-realtime */
  model?: string;
  /** Default marin */
  voice?: string;
  /** Input transcription model (default gpt-live-transcribe). */
  transcribeModel?: string;
  /** Tests inject a fake socket. */
  wsFactory?: (url: string, headers: Record<string, string>) => WebSocket;
}

const RATE = 24_000;
const DEFAULT_MODEL = 'gpt-realtime';

class OpenAiPartnerSession extends BasePartnerSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private backlog: Uint8Array[] = [];
  private partnerText = '';
  constructor(o: OpenAiPartnerOptions, open: PartnerOpenOptions) {
    super();
    const model = o.model ?? DEFAULT_MODEL;
    const url = `${(o.apiBase ?? 'wss://api.openai.com/v1').replace(/^http/, 'ws').replace(/\/+$/, '')}/realtime?model=${encodeURIComponent(model)}`;
    const headers = { authorization: `Bearer ${o.apiKey}` };
    let ws: WebSocket;
    try {
      // Node's global WebSocket accepts headers through the (non-standard) second argument object.
      ws = o.wsFactory ? o.wsFactory(url, headers) : new (WebSocket as unknown as new (u: string, init: unknown) => WebSocket)(url, { headers });
    } catch (e) {
      queueMicrotask(() => this.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      ws.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: open.instructions,
            output_modalities: ['audio'],
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: RATE },
                transcription: { model: o.transcribeModel ?? 'gpt-live-transcribe' },
                turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 600, create_response: true, interrupt_response: true },
              },
              output: { format: { type: 'audio/pcm', rate: RATE }, voice: open.voice ?? o.voice ?? 'marin' },
            },
          },
        }),
      );
    });
    ws.addEventListener('message', (ev) => {
      let m: { type: string; delta?: string; transcript?: string; error?: { message?: string } };
      try {
        m = JSON.parse(String(ev.data)) as typeof m;
      } catch {
        return;
      }
      switch (m.type) {
        case 'session.updated':
          if (this.ready) return;
          this.ready = true;
          for (const b of this.backlog) this.append(b);
          this.backlog = [];
          this.emit({ type: 'ready' });
          ws.send(JSON.stringify({ type: 'response.create', response: { instructions: open.opening ? `The phone just rang and you picked up. Say only: "${open.opening}"` : 'The phone just rang and you picked up. Answer the way this person would, in a few words.' } }));
          return;
        case 'response.output_audio.delta':
          if (m.delta) {
            const bytes = Buffer.from(m.delta, 'base64');
            this.emit({ type: 'audio', pcm: new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2)), sampleRate: RATE });
          }
          return;
        case 'response.output_audio_transcript.delta':
          if (m.delta) {
            this.partnerText += m.delta;
            this.emit({ type: 'transcript', role: 'partner', text: this.partnerText, final: false });
          }
          return;
        case 'response.output_audio_transcript.done':
          this.emit({ type: 'transcript', role: 'partner', text: m.transcript ?? this.partnerText, final: true });
          this.partnerText = '';
          return;
        case 'conversation.item.input_audio_transcription.completed':
          if (m.transcript?.trim()) this.emit({ type: 'transcript', role: 'rep', text: m.transcript.trim(), final: true });
          return;
        case 'input_audio_buffer.speech_started':
          this.emit({ type: 'turn', role: 'rep', state: 'start' });
          this.emit({ type: 'interrupt' });
          return;
        case 'input_audio_buffer.speech_stopped':
          this.emit({ type: 'turn', role: 'rep', state: 'stop' });
          return;
        case 'error':
          this.emit({ type: 'error', message: m.error?.message ?? 'realtime error' });
          return;
        default:
          return;
      }
    });
    ws.addEventListener('error', () => this.emit({ type: 'error', message: 'realtime socket error' }));
    ws.addEventListener('close', () => {
      if (!this.closed) this.emit({ type: 'error', message: 'realtime socket closed' });
    });
  }
  private append(pcm: Uint8Array) {
    this.ws?.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: Buffer.from(pcm).toString('base64') }));
  }
  push(frame: Int16Array, sampleRate: number) {
    if (this.closed) return;
    const bytes = float32ToPcm16Bytes(resampleToFloat32(frame, sampleRate, RATE));
    if (this.ready) this.append(bytes);
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

export class OpenAiVoicePartner implements VoicePartner {
  readonly kind = 'openai' as const;
  constructor(private o: OpenAiPartnerOptions) {}
  open(open: PartnerOpenOptions) {
    return new OpenAiPartnerSession(this.o, open);
  }
}
