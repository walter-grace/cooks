/**
 * A local full-duplex runner over WebSocket, in the smallest protocol that fits a model like
 * Block's Dessa or NVIDIA's VoiceChat once a runner exists for it:
 *
 *   client → server  text   {"type":"start","sampleRate":16000,"instructions":"…","opening":"…","voice":"…"}
 *   client → server  binary PCM16 mono rep audio at that sample rate
 *   server → client  text   {"type":"ready","sampleRate":24000}
 *   server → client  binary PCM16 mono partner audio at the ready sample rate
 *   server → client  text   {"type":"transcript","role":"rep"|"partner","text":"…","final":true}
 *   server → client  text   {"type":"turn","role":"rep","state":"start"|"stop"}   (optional; makes talk stats accurate)
 *   server → client  text   {"type":"interrupt"} | {"type":"error","message":"…"}
 *
 * Cooks resamples rep audio to 16 kHz before sending.
 */
import { float32ToPcm16Bytes, resampleToFloat32 } from '../speech/audio.js';
import { BasePartnerSession, type PartnerOpenOptions, type VoicePartner } from './types.js';

const IN_RATE = 16_000;

class LocalSession extends BasePartnerSession {
  private ws: WebSocket | null = null;
  private ready = false;
  private outRate = 24_000;
  private backlog: Uint8Array[] = [];
  constructor(url: string, o: PartnerOpenOptions, wsFactory?: (url: string) => WebSocket) {
    super();
    let ws: WebSocket;
    try {
      ws = wsFactory ? wsFactory(url) : new WebSocket(url);
    } catch (e) {
      queueMicrotask(() => this.emit({ type: 'error', message: e instanceof Error ? e.message : String(e) }));
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'start', sampleRate: IN_RATE, instructions: o.instructions, opening: o.opening, voice: o.voice })));
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') {
        const buf = ev.data instanceof ArrayBuffer ? ev.data : (ev.data as Uint8Array).buffer;
        this.emit({ type: 'audio', pcm: new Int16Array(buf, 0, Math.floor(buf.byteLength / 2)), sampleRate: this.outRate });
        return;
      }
      let m: { type?: string; sampleRate?: number; role?: 'rep' | 'partner'; text?: string; final?: boolean; message?: string; state?: 'start' | 'stop' };
      try {
        m = JSON.parse(ev.data) as typeof m;
      } catch {
        return;
      }
      if (m.type === 'ready') {
        this.outRate = m.sampleRate ?? this.outRate;
        this.ready = true;
        for (const b of this.backlog) ws.send(b);
        this.backlog = [];
        this.emit({ type: 'ready' });
      } else if (m.type === 'transcript' && m.text) this.emit({ type: 'transcript', role: m.role === 'rep' ? 'rep' : 'partner', text: m.text, final: m.final !== false });
      else if (m.type === 'interrupt') this.emit({ type: 'interrupt' });
      else if (m.type === 'turn' && m.role === 'rep' && (m.state === 'start' || m.state === 'stop')) this.emit({ type: 'turn', role: 'rep', state: m.state });
      else if (m.type === 'error') this.emit({ type: 'error', message: m.message ?? 'runner error' });
    });
    ws.addEventListener('error', () => this.emit({ type: 'error', message: 'runner socket error' }));
    ws.addEventListener('close', () => {
      if (!this.closed) this.emit({ type: 'error', message: 'runner socket closed' });
    });
  }
  push(frame: Int16Array, sampleRate: number) {
    if (this.closed) return;
    const bytes = sampleRate === IN_RATE ? new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength) : float32ToPcm16Bytes(resampleToFloat32(frame, sampleRate, IN_RATE));
    if (this.ready) this.ws?.send(bytes);
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

export class LocalVoicePartner implements VoicePartner {
  readonly kind = 'local' as const;
  constructor(private url: string, private wsFactory?: (url: string) => WebSocket) {}
  open(o: PartnerOpenOptions) {
    return new LocalSession(this.url, o, this.wsFactory);
  }
}
