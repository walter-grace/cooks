import { describe, expect, it } from 'vitest';
import { LocalVoicePartner, OpenAiVoicePartner, type PartnerEvent, PRACTICE_SCENARIOS, partnerInstructions, practiceStatus, scenarioFromProspect } from './index.js';

class FakeWs {
  sent: Array<string | Uint8Array> = [];
  binaryType = 'arraybuffer';
  private ls: Record<string, Array<(e: any) => void>> = {};
  addEventListener(type: string, cb: (e: any) => void) {
    (this.ls[type] ??= []).push(cb);
  }
  send(d: string | Uint8Array) {
    this.sent.push(d);
  }
  close() {
    this.emit('close', {});
  }
  emit(type: string, e: unknown) {
    for (const cb of this.ls[type] ?? []) cb(e);
  }
  json = () => this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as any);
}

describe('OpenAI Realtime partner', () => {
  it('configures the session, streams audio both ways, and surfaces interrupts and transcripts', () => {
    const ws = new FakeWs();
    const partner = new OpenAiVoicePartner({ apiKey: 'k', voice: 'cedar', wsFactory: () => ws as unknown as WebSocket });
    const s = partner.open({ instructions: 'You are Dana.', opening: 'Hello, this is Dana.', sampleRate: 16_000 });
    const ev: PartnerEvent[] = [];
    s.on((e) => ev.push(e));
    s.push(new Int16Array(320), 16_000); // before the session is ready: buffered
    ws.emit('open', {});
    const upd = ws.json()[0];
    expect(upd.type).toBe('session.update');
    expect(upd.session).toMatchObject({ type: 'realtime', instructions: 'You are Dana.', output_modalities: ['audio'] });
    expect(upd.session.audio.input.turn_detection).toMatchObject({ type: 'server_vad', interrupt_response: true });
    expect(upd.session.audio.output).toMatchObject({ voice: 'cedar', format: { type: 'audio/pcm', rate: 24_000 } });
    expect(ws.json()).toHaveLength(1);
    ws.emit('message', { data: JSON.stringify({ type: 'session.updated' }) });
    const types = ws.json().map((m) => m.type);
    expect(types).toEqual(['session.update', 'input_audio_buffer.append', 'response.create']);
    expect(ws.json()[2].response.instructions).toContain('Hello, this is Dana.');
    expect(ev[0]).toEqual({ type: 'ready' });
    const pcm = new Int16Array([1000, -1000, 500]);
    ws.emit('message', { data: JSON.stringify({ type: 'response.output_audio.delta', delta: Buffer.from(pcm.buffer).toString('base64') }) });
    const audio = ev.find((e) => e.type === 'audio') as Extract<PartnerEvent, { type: 'audio' }>;
    expect(audio.sampleRate).toBe(24_000);
    expect(Array.from(audio.pcm)).toEqual([1000, -1000, 500]);
    ws.emit('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Who ' }) });
    ws.emit('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Who is this?' }) });
    ws.emit('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) });
    ws.emit('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) });
    ws.emit('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: ' Hi, this is Ray. ' }) });
    ws.emit('message', { data: 'not json' });
    expect(ev.filter((e) => e.type === 'transcript')).toEqual([
      { type: 'transcript', role: 'partner', text: 'Who ', final: false },
      { type: 'transcript', role: 'partner', text: 'Who is this?', final: true },
      { type: 'transcript', role: 'rep', text: 'Hi, this is Ray.', final: true },
    ]);
    expect(ev.some((e) => e.type === 'interrupt')).toBe(true);
    expect(ev.filter((e) => e.type === 'turn')).toEqual([{ type: 'turn', role: 'rep', state: 'start' }, { type: 'turn', role: 'rep', state: 'stop' }]);
    s.push(new Int16Array(160), 8_000);
    expect(ws.json().at(-1).type).toBe('input_audio_buffer.append');
    ws.emit('message', { data: JSON.stringify({ type: 'error', error: { message: 'nope' } }) });
    expect(ev.at(-1)).toEqual({ type: 'error', message: 'nope' });
    s.close();
    s.push(new Int16Array(160), 16_000);
    expect(ev.filter((e) => e.type === 'error')).toHaveLength(1); // closing after close() is not an error
  });
});

describe('local duplex runner partner', () => {
  it('speaks the documented protocol and resamples rep audio to 16 kHz', () => {
    const ws = new FakeWs();
    const partner = new LocalVoicePartner('ws://127.0.0.1:9/duplex', () => ws as unknown as WebSocket);
    const s = partner.open({ instructions: 'Be Dana.', opening: 'Hello.', sampleRate: 48_000 });
    const ev: PartnerEvent[] = [];
    s.on((e) => ev.push(e));
    ws.emit('open', {});
    expect(ws.json()[0]).toMatchObject({ type: 'start', sampleRate: 16_000, instructions: 'Be Dana.', opening: 'Hello.' });
    s.push(new Int16Array(960), 48_000); // 20 ms at 48 kHz → 320 samples at 16 kHz
    expect(ws.sent).toHaveLength(1); // buffered until ready
    ws.emit('message', { data: JSON.stringify({ type: 'ready', sampleRate: 22_050 }) });
    expect(ev[0]).toEqual({ type: 'ready' });
    const bin = ws.sent[1] as Uint8Array;
    expect(bin.byteLength).toBe(320 * 2);
    ws.emit('message', { data: new Int16Array([7, 8]).buffer });
    expect(ev.at(-1)).toMatchObject({ type: 'audio', sampleRate: 22_050 });
    ws.emit('message', { data: JSON.stringify({ type: 'transcript', role: 'rep', text: 'hello', final: true }) });
    ws.emit('message', { data: JSON.stringify({ type: 'interrupt' }) });
    expect(ev.slice(-2)).toEqual([{ type: 'transcript', role: 'rep', text: 'hello', final: true }, { type: 'interrupt' }]);
  });
});

describe('scenarios and status', () => {
  it('builds instructions from the persona and a real prospect', () => {
    const s = PRACTICE_SCENARIOS[1]!;
    const text = partnerInstructions(s, { name: 'Ray Rep', company: 'Acme' });
    expect(text).toContain('Marcus Lee, Executive Assistant to the CFO at Harbor Health');
    expect(text).toContain('named Ray Rep from Acme');
    expect(text).toContain('"Is she expecting your call?"');
    expect(text).toContain('never say you are an AI');
    const p = scenarioFromProspect({ name: 'Ada Lovelace', title: 'CTO' }, { name: 'Globex', industry: 'logistics' });
    expect(p).toMatchObject({ id: 'prospect', title: 'Call Ada Lovelace', persona: { name: 'Ada Lovelace', title: 'CTO', company: 'Globex' } });
    expect(p.situation).toContain('in logistics');
  });
  it('explains what is missing', () => {
    expect(practiceStatus(undefined)).toMatchObject({ configured: false, provider: 'off', maxSeconds: 600 });
    expect(practiceStatus({ provider: 'openai' }).reason).toContain('OPENAI_API_KEY');
    expect(practiceStatus({ provider: 'openai', apiKey: 'k' })).toMatchObject({ configured: true, reason: null });
    expect(practiceStatus({ provider: 'local' }).reason).toContain('PRACTICE_LOCAL_URL');
    expect(practiceStatus({ provider: 'mock', maxSeconds: 90 })).toMatchObject({ configured: true, maxSeconds: 90 });
  });
});
