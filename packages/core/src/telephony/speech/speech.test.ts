import { describe, expect, it } from 'vitest';
import { EnergyVad, JEV_DEFAULT_MODEL, JevJudge, MockSpeechProvider, SpeechGate, judgeAnswer, judgeText, mintStreamToken, mulawToPcm16, pcm16ToMulaw, resampleToFloat32, tonePower, verifyStreamToken, type Evidence, type GateVerdict } from './index.js';

/* ------------------------------------------------------------- synthetic line audio */
const RATE = 8000;
const FRAME = 160; // 20 ms
type Kind = 'silence' | 'speech' | 'beep';
function frame(kind: Kind, i: number): Int16Array {
  const f = new Int16Array(FRAME);
  for (let n = 0; n < FRAME; n++) {
    const t = (i * FRAME + n) / RATE;
    if (kind === 'speech') f[n] = Math.round(6000 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) + (Math.sin(t * 7919) * 2500));
    else if (kind === 'beep') f[n] = Math.round(9000 * Math.sin(2 * Math.PI * 1000 * t));
    else f[n] = Math.round(Math.sin(t * 104729) * 30);
  }
  return f;
}
/** Build frames from [ms, kind] segments. */
function* frames(segs: Array<[number, Kind]>) {
  let i = 0;
  for (const [ms, kind] of segs) for (let k = 0; k < ms / 20; k++) yield frame(kind, i++);
}
const mulawFrames = (segs: Array<[number, Kind]>) => [...frames(segs)].map((f) => Uint8Array.from(f, (v) => pcm16ToMulaw(v)));

const ev = (o: Partial<Evidence>): Evidence => ({ elapsedMs: 1000, speechMs: 500, runMs: 0, longestRunMs: 500, silenceAfterSpeechMs: 400, firstSpeechMs: 300, runs: 1, beepMs: 0, beep: false, text: '', final: false, ...o });

describe('audio', () => {
  it('μ-law round-trips silence and speech-level samples', () => {
    expect(mulawToPcm16(new Uint8Array([0xff]))[0]).toBe(0);
    for (const v of [0, 100, -100, 3000, -3000, 20000, -20000]) {
      const back = mulawToPcm16(new Uint8Array([pcm16ToMulaw(v)]))[0]!;
      expect(Math.abs(back - v)).toBeLessThanOrEqual(Math.max(8, Math.abs(v) * 0.07));
    }
  });
  it('resamples 8 kHz to 16 kHz and finds a 1 kHz tone', () => {
    const f = frame('beep', 0);
    expect(resampleToFloat32(f, 8000, 16000).length).toBe(320);
    expect(tonePower(f, RATE, 1000)).toBeGreaterThan(0.8);
    expect(tonePower(frame('speech', 0), RATE, 1000)).toBeLessThan(0.5);
  });
});

describe('energy VAD', () => {
  it('times a greeting: first speech, run length, silence after, no beep', () => {
    const vad = new EnergyVad();
    for (const f of frames([[300, 'silence'], [600, 'speech'], [400, 'silence']])) vad.push(f);
    const t = vad.t;
    expect(t.elapsedMs).toBe(1300);
    expect(t.firstSpeechMs).toBe(300);
    expect(t.longestRunMs).toBeGreaterThanOrEqual(580);
    expect(t.longestRunMs).toBeLessThanOrEqual(740); // hangover may stretch the run a little
    expect(t.runMs).toBe(0);
    expect(t.silenceAfterSpeechMs).toBeGreaterThanOrEqual(260);
    expect(t.runs).toBe(1);
    expect(t.beep).toBe(false);
  });
  it('hears an answering-machine beep', () => {
    const vad = new EnergyVad();
    for (const f of frames([[200, 'silence'], [3000, 'speech'], [300, 'beep']])) vad.push(f);
    expect(vad.t.beep).toBe(true);
    expect(vad.t.longestRunMs).toBeGreaterThanOrEqual(3000);
  });
});

describe('judge', () => {
  it('reads voicemail phrases and greetings from text alone', () => {
    expect(judgeText("Hi, you've reached Dana's phone")).toMatchObject({ verdict: 'machine', reason: "phrase:you've reached" });
    expect(judgeText('please leave a message after the tone')).toMatchObject({ verdict: 'machine' });
    expect(judgeText('Thank you for calling Acme, press one for sales')).toMatchObject({ verdict: 'machine' });
    expect(judgeText('Hello?')).toMatchObject({ verdict: 'human', reason: 'greeting', confidence: 0.9 });
    expect(judgeText('Yeah, this is Sam')).toMatchObject({ verdict: 'human', reason: 'greeting' });
    expect(judgeText('Dana Lee')).toMatchObject({ verdict: 'human', reason: 'short_pickup', confidence: 0.6 });
    expect(judgeText('')).toBeNull();
    expect(judgeText('the quick brown fox jumped over the lazy dog twice today')).toBeNull();
  });
  it('a short greeting followed by silence is a person, before any AMD could decide', () => {
    expect(judgeAnswer(ev({ text: 'Hello?', elapsedMs: 1100 }))).toMatchObject({ verdict: 'human', confidence: 0.9 });
    expect(judgeAnswer(ev({ text: '', speechMs: 450, longestRunMs: 450 }))).toMatchObject({ verdict: 'human', reason: 'brief_then_quiet', confidence: 0.7 });
  });
  it('keeps listening while speech continues, calls a monologue or beep a machine', () => {
    expect(judgeAnswer(ev({ text: 'hi this', runMs: 700, longestRunMs: 700, silenceAfterSpeechMs: 0 }))).toBeNull();
    expect(judgeAnswer(ev({ text: 'hi there how is', runMs: 2700, longestRunMs: 2700, silenceAfterSpeechMs: 0, elapsedMs: 3000 }))).toMatchObject({ verdict: 'machine', reason: 'monologue' });
    expect(judgeAnswer(ev({ beep: true }))).toMatchObject({ verdict: 'machine', reason: 'beep' });
    expect(judgeAnswer(ev({ text: "you've reached", runMs: 500, longestRunMs: 500, silenceAfterSpeechMs: 0 }))).toMatchObject({ verdict: 'machine' });
  });
  it('gives up after maxMs with nothing usable', () => {
    expect(judgeAnswer(ev({ text: '', firstSpeechMs: null, speechMs: 0, longestRunMs: 0, silenceAfterSpeechMs: null, elapsedMs: 6000 }))).toMatchObject({ verdict: 'unknown', reason: 'timeout' });
  });
});

describe('speech gate', () => {
  const run = async (segs: Array<[number, Kind]>, script: Array<{ atMs: number; text: string; final?: boolean }>, extra: Partial<ConstructorParameters<typeof SpeechGate>[0]> = {}) => {
    let verdict: GateVerdict | null = null;
    let gaveUp: string | null = null;
    const gate = new SpeechGate({ provider: new MockSpeechProvider(), hints: { qaScript: JSON.stringify(script) }, onVerdict: (v) => void (verdict = v), onGiveUp: (r) => void (gaveUp = r), ...extra });
    for (const f of mulawFrames(segs)) {
      gate.media(f);
      if (verdict || gaveUp) break;
      // frames arrive 20 ms apart on a real stream; yield so an in-flight Jev answer can land between them
      await new Promise((r) => setImmediate(r));
    }
    for (let n = 0; n < 40 && !verdict && !gaveUp; n++) await new Promise((r) => setTimeout(r, 5));
    return { verdict: verdict as GateVerdict | null, gaveUp: gaveUp as string | null, gate };
  };
  it('"Hello?" then silence → human in about a second, well inside AMD\'s 2.4 s speech threshold', async () => {
    const { verdict } = await run([[300, 'silence'], [600, 'speech'], [2000, 'silence']], [{ atMs: 520, text: 'Hello' }, { atMs: 820, text: 'Hello?', final: true }]);
    expect(verdict).toMatchObject({ verdict: 'human', text: 'Hello?', provider: 'mock', judge: 'rules' });
    expect(verdict!.latencyMs).toBeLessThan(1400);
  });
  it('a voicemail greeting is called on its first phrase, while it is still talking', async () => {
    const { verdict } = await run([[300, 'silence'], [6000, 'speech']], [{ atMs: 700, text: 'Hi you' }, { atMs: 1000, text: "Hi, you've reached Dana" }]);
    expect(verdict).toMatchObject({ verdict: 'machine', reason: "phrase:you've reached" });
    expect(verdict!.latencyMs).toBeLessThanOrEqual(1020);
  });
  it('a recording with no recognizable words is still a machine once it talks for 2.6 s straight', async () => {
    const { verdict } = await run([[300, 'silence'], [4000, 'speech']], []);
    expect(verdict).toMatchObject({ verdict: 'machine', reason: 'monologue' });
  });
  it('dead air gives up (AMD decides) instead of guessing', async () => {
    const { verdict, gaveUp } = await run([[6500, 'silence']], []);
    expect(verdict).toBeNull();
    expect(gaveUp).toBe('timeout');
  });
  it('asks Jev about an ambiguous pickup and takes its answer', async () => {
    const calls: unknown[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ model: 'typesafe/jev-1.14', answers: { answered_by: { type: 'choice', choice: 'human', confidence: 0.91, probabilities: { human: 0.91, voicemail: 0.05, ivr: 0.01, unclear: 0.03 } } }, usage: { input_tokens: 400, output_tokens: 10, cost: 0.00002 } }), { status: 200 });
    };
    const jev = new JevJudge({ apiKey: 'or-test', fetchImpl });
    const { verdict } = await run([[300, 'silence'], [500, 'speech'], [1500, 'silence']], [{ atMs: 700, text: 'Dana Lee', final: true }], { jev });
    expect(verdict).toMatchObject({ verdict: 'human', judge: 'jev', reason: 'jev:human', costUsd: 0.00002 });
    expect(calls).toHaveLength(1);
    const c = calls[0] as { url: string; body: { model: string; questions: Record<string, { type: string }> } };
    expect(c.url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(c.body.model).toBe(JEV_DEFAULT_MODEL);
    expect(c.body.questions.answered_by!.type).toBe('choice');
  });
  it('falls back to the rule when Jev times out or errors', async () => {
    const jev = new JevJudge({ apiKey: 'or-test', timeoutMs: 20, fetchImpl: () => new Promise((_, rej) => setTimeout(() => rej(new Error('down')), 5)) });
    const { verdict } = await run([[300, 'silence'], [500, 'speech'], [1500, 'silence']], [{ atMs: 700, text: 'Dana Lee', final: true }], { jev });
    expect(verdict).toMatchObject({ verdict: 'human', judge: 'rules', reason: 'short_pickup' });
  });
});

describe('stream token', () => {
  const claims = { ws: 'w', session: 's', line: 'l' };
  it('verifies only an untampered, unexpired token for the same ids', () => {
    const tok = mintStreamToken('secret', { ...claims, exp: 2000 });
    expect(verifyStreamToken('secret', tok, claims, 1999)).toMatchObject({ ...claims, exp: 2000 });
    expect(verifyStreamToken('secret', tok, claims, 2001)).toBeNull();
    expect(verifyStreamToken('other', tok, claims, 1999)).toBeNull();
    expect(verifyStreamToken('secret', tok, { ...claims, line: 'x' }, 1999)).toBeNull();
    expect(verifyStreamToken('secret', `${tok}a`, claims, 1999)).toBeNull();
    expect(verifyStreamToken('secret', undefined, claims, 1999)).toBeNull();
  });
});
