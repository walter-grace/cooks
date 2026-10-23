import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { callTranscripts, calls } from '@cooks/db';
import { MockVoicePartner, createPracticeSocket } from '@cooks/core';
import { createTestApp } from './test/harness.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp({ telephony: { practice: { provider: 'mock', maxSeconds: 120 } } });
});
afterAll(() => t.close());

const RATE = 16_000;
/** 20 ms frames of synthetic voiced audio or near-silence, as the browser would send them. */
function frames(ms: number, voiced: boolean): Uint8Array[] {
  const out: Uint8Array[] = [];
  const n = RATE / 50;
  for (let f = 0; f < ms / 20; f++) {
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const tt = (f * n + i) / RATE;
      pcm[i] = voiced ? Math.round(6000 * Math.sin(2 * Math.PI * 180 * tt) + 2000 * Math.sin(tt * 7919)) : Math.round(Math.sin(tt * 104729) * 20);
    }
    out.push(new Uint8Array(pcm.buffer));
  }
  return out;
}

function socket() {
  const out: Array<string | Uint8Array> = [];
  let closed = false;
  const sock = createPracticeSocket({ db: t.db, jobs: t.jobs, clock: t.clock, publicUrl: 'http://localhost', kek: t.kek, partner: new MockVoicePartner(), maxSeconds: 120, send: (d) => out.push(d), close: () => void (closed = true) });
  const texts = () => out.filter((o): o is string => typeof o === 'string').map((s) => JSON.parse(s) as Record<string, unknown>);
  return { sock, out, texts, closed: () => closed };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('practice calls', () => {
  it('reports the partner and lists scenarios', async () => {
    const st = await t.request('/v1/practice/status');
    expect(st.status).toBe(200);
    expect(st.json.data).toMatchObject({ configured: true, provider: 'mock', maxSeconds: 120, scenarios: 6 });
    const sc = await t.request('/v1/practice/scenarios');
    expect(sc.json.data.map((s: any) => s.id)).toContain('gatekeeper');
    expect(sc.json.data[0]).toMatchObject({ id: 'cold-vp-sales', persona: { name: 'Dana Park' }, difficulty: 'medium' });
    expect(JSON.stringify(sc.json.data)).not.toContain('instructions');
  });

  it('starts a session as a practice call with a socket token', async () => {
    const r = await t.request('/v1/practice/sessions', { method: 'POST', json: { data: { scenarioId: 'skeptic' } } });
    expect(r.status).toBe(201);
    expect(r.json.data.token).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);
    expect(r.json.data).toMatchObject({ streamPath: '/practice/stream', sampleRate: 16000, maxSeconds: 120, scenario: { id: 'skeptic' }, opening: 'Hello, this is Elena.' });
    const [row] = await t.db.select().from(calls).where(eq(calls.id, r.json.data.callId));
    expect(row).toMatchObject({ source: 'practice', mode: 'practice', status: 'in_progress', provider: 'mock' });
    const cfg = (row!.aiConfig as any).practice;
    expect(cfg.instructions).toContain('Elena Fischer');
    expect(cfg.instructions).toContain('Everyone says AI');
    expect(cfg.instructions).toContain('Acme');
    const bad = await t.request('/v1/practice/sessions', { method: 'POST', json: { data: { scenarioId: 'nope' } } });
    expect(bad.status).toBe(422);
  });

  it('refuses a socket with a bad token or a session that is not in progress', async () => {
    const r = await t.request('/v1/practice/sessions', { method: 'POST', json: { data: {} } });
    const { sock, texts } = socket();
    await sock.message(JSON.stringify({ type: 'start', ws: t.workspaceId, callId: r.json.data.callId, token: '9999999999.forged', sampleRate: 16000 }));
    expect(await sock.done).toBe('bad_token');
    expect(texts()).toEqual([{ type: 'error', message: 'bad_token' }]);
    const [row] = await t.db.select({ status: calls.status }).from(calls).where(eq(calls.id, r.json.data.callId));
    expect(row!.status).toBe('in_progress');
  });

  it('runs a call through the partner, then finalises transcript, stats and coaching', async () => {
    const r = await t.request('/v1/practice/sessions', { method: 'POST', json: { data: { scenarioId: 'cold-vp-sales' } } });
    const s = r.json.data;
    const { sock, out, texts, closed } = socket();
    await sock.message(JSON.stringify({ type: 'start', ws: t.workspaceId, callId: s.callId, token: s.token, sampleRate: RATE }));
    await tick();
    expect(sock.authenticated).toBe(true);
    expect(texts()[0]).toMatchObject({ type: 'ready', sampleRate: 24000, callId: s.callId });
    expect(texts()[1]).toMatchObject({ type: 'transcript', role: 'partner', text: 'Hello, this is Dana.', final: true });
    expect(out.some((o) => o instanceof Uint8Array)).toBe(true);
    // The rep talks over the greeting, then stops.
    for (const f of frames(1000, true)) await sock.message(f);
    for (const f of frames(500, false)) await sock.message(f);
    const kinds = texts().map((m) => m.type);
    expect(kinds).toContain('interrupt');
    const partnerLines = texts().filter((m) => m.type === 'transcript' && m.role === 'partner');
    expect(partnerLines).toHaveLength(2);
    expect(partnerLines[1]!.text).toContain('who is this');
    expect(texts().find((m) => m.type === 'transcript' && m.role === 'rep')!.text).toMatch(/rep spoke for 1 s/);
    await sock.message(JSON.stringify({ type: 'stop' }));
    expect(await sock.done).toBe('stop');
    expect(closed()).toBe(true);
    expect(texts().at(-1)).toMatchObject({ type: 'ended', callId: s.callId, reason: 'stop' });

    const [row] = await t.db.select().from(calls).where(eq(calls.id, s.callId));
    expect(row).toMatchObject({ status: 'completed', outcome: 'answered', transcriptStatus: 'ready', coachingStatus: 'queued', endReason: 'stop' });
    const [tr] = await t.db.select().from(callTranscripts).where(eq(callTranscripts.callId, s.callId));
    expect(tr!.provider).toBe('practice:mock');
    const segs = tr!.segments as Array<{ speaker: string; text: string }>;
    expect(segs.map((x) => x.speaker)).toEqual(['prospect', 'rep', 'prospect']);
    const first = segs[0] as unknown as { start: number; end: number };
    expect(first.end - first.start).toBeCloseTo(0.3, 2);
    expect(tr!.text).toContain('Prospect: Hello, this is Dana.');
    expect(tr!.stats).toMatchObject({ source: 'practice', switches: 2 });
    expect(t.jobs.sent.some((j) => j.name === 'ai.coach_call' && j.data.callId === s.callId)).toBe(true);
    const call = await t.request(`/v1/calls/${s.callId}`);
    expect(call.status).toBe(200);
    expect(call.json.data.practice).toMatchObject({ scenarioId: 'cold-vp-sales', title: 'Cold call: VP of Sales', persona: { name: 'Dana Park' } });
    expect(JSON.stringify(call.json.data)).not.toContain('Stay in character');
    const ins = await t.request(`/v1/calls/${s.callId}/insights`);
    expect(ins.status).toBe(200);
    expect(ins.json.data.transcript.segments).toHaveLength(3);
  });

  it('ends a session through the API when the browser never connected, idempotently', async () => {
    const r = await t.request('/v1/practice/sessions', { method: 'POST', json: { data: { scenarioId: 'gatekeeper' } } });
    const first = await t.request(`/v1/practice/sessions/${r.json.data.callId}/actions/end`, { method: 'POST' });
    expect(first.status).toBe(200);
    expect(first.json.data).toMatchObject({ status: 'completed', transcriptStatus: 'none', coachingStatus: 'none' });
    const again = await t.request(`/v1/practice/sessions/${r.json.data.callId}/actions/end`, { method: 'POST' });
    expect(again.status).toBe(200);
    expect(again.json.data.status).toBe('completed');
    const other = await t.request(`/v1/practice/sessions/00000000-0000-7000-8000-000000000000`);
    expect(other.status).toBe(404);
  });
});
