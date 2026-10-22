import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@cooks/db/test';
import { callTranscripts, calls, coachingScores, prospects, telephonyConnections, users, workspaceAiSettings, workspaceMembers, workspaces, type Db } from '@cooks/db';
import { activityRatio, mergeSegments, parseWav, splitChannels, talkStats, transcriptText, type TranscriptSegment } from './transcribe.js';
import { coachCall, processCallRecording } from './jobs/coach-call.js';
import type { LlmProvider, StructuredRequest, StructuredResult } from './providers/types.js';

/** 16-bit stereo WAV: left carries a tone for the first half, right for the second half. */
function stereoWav(seconds = 2, rate = 8000): Buffer {
  const frames = seconds * rate;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const l = t < seconds / 2 ? Math.round(Math.sin(2 * Math.PI * 440 * t) * 8000) : 0;
    const r = t >= seconds / 2 ? Math.round(Math.sin(2 * Math.PI * 300 * t) * 8000) : 0;
    data.writeInt16LE(l, i * 4);
    data.writeInt16LE(r, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe('transcribe utilities', () => {
  it('splits a stereo WAV into mono channels that keep their own activity', () => {
    const wav = stereoWav(2);
    const { left, right, durationSeconds, info } = splitChannels(wav);
    expect(info.channels).toBe(2);
    expect(durationSeconds).toBe(2);
    expect(parseWav(left).channels).toBe(1);
    expect(parseWav(right).channels).toBe(1);
    expect(activityRatio(left)).toBeGreaterThan(0.4);
    expect(activityRatio(left)).toBeLessThan(0.6);
    expect(activityRatio(right)).toBeGreaterThan(0.4);
    expect(() => parseWav(Buffer.from('nope'))).toThrow();
  });
  it('merges channels by time and computes talk stats', () => {
    const rep = [
      { start: 0, end: 10, text: 'Hi Ada, this is Ray from Cooks. Do you have a minute?' },
      { start: 14, end: 40, text: 'We help teams run sequences. Most reps save three hours a week. What does your stack look like today?' },
      { start: 55, end: 60, text: 'Makes sense. Thursday at ten?' },
    ];
    const pro = [
      { start: 10.5, end: 13, text: 'Sure, go ahead.' },
      { start: 39, end: 54, text: 'We use spreadsheets mostly. Honestly it is a mess. Could you show me?' },
      { start: 60.5, end: 62, text: 'Thursday works.' },
    ];
    const segs = mergeSegments(rep, pro);
    expect(segs.map((s) => s.speaker)).toEqual(['rep', 'prospect', 'rep', 'prospect', 'rep', 'prospect']);
    const st = talkStats(segs, 62);
    expect(st.repTalkSeconds).toBe(41);
    expect(st.prospectTalkSeconds).toBe(19);
    expect(st.talkRatio).toBe(0.68);
    expect(st.repQuestions).toBe(3);
    expect(st.prospectQuestions).toBe(1);
    expect(st.longestRepMonologueSeconds).toBe(26);
    expect(st.interruptionsByProspect).toBe(1); // prospect started at 39 while rep talked until 40
    expect(st.switches).toBe(5);
    expect(transcriptText(segs).split('\n')[1]).toBe('[0:10] Prospect: Sure, go ahead.');
  });
});

class FakeCoach implements LlmProvider {
  readonly id = 'openrouter' as const;
  readonly model = 'fake-coach';
  public last: StructuredRequest<unknown> | null = null;
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.last = req;
    const value = {
      summary: 'Ray called Ada, learned they run outreach from spreadsheets, and booked a demo for Thursday.',
      outcome: 'meeting_booked',
      objections: [{ objection: 'Honestly it is a mess', handled: true, note: 'Ray offered a demo instead of pitching' }],
      nextSteps: ['Send a calendar invite for Thursday 10:00'],
      scores: { opener: 4, discovery: 3, listening: 4, valueArticulation: 3, objectionHandling: 4, nextStepClarity: 5 },
      strengths: ['Asked for time up front'],
      improvements: ['Ask one discovery question before the pitch'],
      coachingTip: 'Lead with a question about their current process.',
      highlights: [{ at: '0:14', speaker: 'rep', quote: 'What does your stack look like today?', why: 'Good open question' }],
      confidence: 0.82,
    } as unknown as T;
    return { kind: 'ok', value, usage: { input: 900, output: 300, cacheRead: 0, cacheWrite: 0, costUsd: 0.004 }, model: this.model, latencyMs: 12 };
  }
}

describe('processCallRecording', () => {
  let db: Db;
  let close: () => Promise<void>;
  let ws: string;
  let callId: string;
  const sttCalls: string[] = [];
  const coach = new FakeCoach();
  const twilioFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/Recordings/RE1.wav')) return new Response(new Uint8Array(stereoWav(2)), { headers: { 'content-type': 'audio/wav' } });
    return Response.json({ message: 'unhandled' }, { status: 404 });
  };
  const sttFetch: typeof fetch = async (input, init) => {
    const form = init?.body as FormData;
    const name = (form.get('file') as File).name;
    sttCalls.push(name);
    expect(String(input)).toBe('http://stt.local/v1/audio/transcriptions');
    expect(form.get('model')).toBe('whisper-1');
    if (name === 'rep.wav') return Response.json({ segments: [{ start: 0, end: 1, text: 'Hi Ada, do you have a minute?' }] });
    return Response.json({ segments: [{ start: 1, end: 2, text: 'Sure.' }] });
  };
  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    const [w] = await db.insert(workspaces).values({ name: 'Acme', slug: 'acme' }).returning();
    ws = w!.id;
    const [u] = await db.insert(users).values({ email: 'ray@acme.test', name: 'Ray Rep' }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws, userId: u!.id, role: 'admin' });
    await db.insert(workspaceAiSettings).values({ workspaceId: ws, provider: 'openrouter', confidenceThreshold: '0.6' } as never);
    await db.insert(telephonyConnections).values({ workspaceId: ws, accountSid: 'ACtest', authTokenEncrypted: 'plain:tok', fromNumbers: ['+15550001111'] });
    const [p] = await db.insert(prospects).values({ workspaceId: ws, name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', title: 'VP Eng', primaryEmail: 'ada@globex.test' } as never).returning();
    const [c] = await db.insert(calls).values({ workspaceId: ws, prospectId: p!.id, ownerId: u!.id, source: 'dialer', direction: 'outbound', status: 'completed', durationSeconds: 62, recordingSid: 'RE1', recordingDurationSeconds: 2, provider: 'twilio' }).returning();
    callId = c!.id;
  });
  afterAll(() => close());

  it('skips cleanly without a transcription provider', async () => {
    const r = await processCallRecording({ db, env: {}, now: () => new Date(), publicUrl: 'http://localhost', telephony: { fetchImpl: twilioFetch } }, callId);
    expect(r).toMatchObject({ status: 'skipped', reason: expect.stringContaining('TRANSCRIBE_API_BASE') });
    expect((await db.select().from(calls).where(eq(calls.id, callId)))[0]!.transcriptStatus).toBe('skipped');
  });
  it('downloads, splits, transcribes both channels, stores stats, then coaches', async () => {
    const deps = { db, env: { TRANSCRIBE_API_BASE: 'http://stt.local/v1', TRANSCRIBE_API_KEY: 'k', OPENROUTER_API_KEY: 'or' }, now: () => new Date(), publicUrl: 'http://localhost', telephony: { fetchImpl: twilioFetch }, transcribeFetch: sttFetch, providerOverride: coach };
    const r = await processCallRecording(deps, callId);
    expect(r).toMatchObject({ status: 'ok', transcript: 'ready', coaching: 'ready' });
    expect(sttCalls.sort()).toEqual(['prospect.wav', 'rep.wav']);
    const [tr] = await db.select().from(callTranscripts).where(eq(callTranscripts.callId, callId));
    expect(tr!.text).toBe('[0:00] Rep: Hi Ada, do you have a minute?\n[0:01] Prospect: Sure.');
    expect(tr!.stats).toMatchObject({ stereo: true, repQuestions: 1, talkRatio: 0.5 });
    expect(tr!.summary).toContain('booked a demo');
    const [sc] = await db.select().from(coachingScores).where(eq(coachingScores.callId, callId));
    expect(sc!.rubric).toBe('cooks.coach.v1');
    expect(Number(sc!.score)).toBe(3.83);
    expect((sc!.feedback as any).scores.nextStepClarity).toBe(5);
    expect(coach.last!.user).toContain('rep 50% of speech');
    expect(coach.last!.user).toContain('Prospect: Ada Lovelace, VP Eng');
    const [c] = await db.select().from(calls).where(eq(calls.id, callId));
    expect(c).toMatchObject({ transcriptStatus: 'ready', coachingStatus: 'ready' });
    // second run: transcript kept, coaching already present
    const again = await processCallRecording(deps, callId);
    expect(again).toMatchObject({ status: 'ok', transcript: 'kept', coaching: 'skipped', reason: 'already coached' });
    const forced = await coachCall(deps, callId, { force: true });
    expect(forced.status).toBe('ok');
    expect(await db.select().from(coachingScores).where(eq(coachingScores.callId, callId))).toHaveLength(1);
  });
});
