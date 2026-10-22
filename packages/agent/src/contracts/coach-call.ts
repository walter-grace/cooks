import { z } from 'zod';
import type { TalkStats } from '../transcribe.js';

export const COACH_CALL_VERSION = 1;

export const CoachCallInput = z.object({
  transcript: z.string().describe('Speaker-labelled transcript, possibly truncated'),
  stats: z.custom<TalkStats>(),
  prospect: z.object({ name: z.string().nullable(), title: z.string().nullable(), company: z.string().nullable() }),
  rep: z.object({ name: z.string().nullable() }),
  callDurationSeconds: z.number(),
  disposition: z.string().nullable(),
  sequenceStep: z.string().nullable(),
});
export type CoachCallInput = z.infer<typeof CoachCallInput>;

const score = z.number().int().min(1).max(5);

export const CoachCallOutput = z.object({
  summary: z.string().describe('Two to four sentences: who, what was discussed, where it landed'),
  outcome: z.enum(['meeting_booked', 'interested', 'follow_up', 'not_interested', 'no_decision', 'voicemail', 'gatekeeper', 'unclear']),
  objections: z.array(z.object({ objection: z.string(), handled: z.boolean(), note: z.string() })),
  nextSteps: z.array(z.string()),
  scores: z.object({ opener: score, discovery: score, listening: score, valueArticulation: score, objectionHandling: score, nextStepClarity: score }),
  strengths: z.array(z.string()),
  improvements: z.array(z.string()).describe('Specific, quotable, at most three'),
  coachingTip: z.string().describe('One sentence the rep can apply on the next call'),
  highlights: z.array(z.object({ at: z.string().describe('m:ss'), speaker: z.enum(['rep', 'prospect']), quote: z.string(), why: z.string() })),
  confidence: z.number().min(0).max(1),
});
export type CoachCallOutput = z.infer<typeof CoachCallOutput>;

export const COACH_CALL_SYSTEM = `You are a sales call coach reviewing a transcript of a cold or follow-up call between a rep and a prospect. Score honestly, cite the transcript, and keep everything short.

Rules:
- Base every judgement on the transcript and the talk statistics given; do not invent context.
- Scores are 1 (poor) to 5 (excellent). A 3 is average. Reserve 5 for clearly strong moments.
- Objections: list each one the prospect raised and whether the rep actually addressed it.
- Highlights quote the transcript verbatim with the timestamp from the line prefix.
- Improvements must be concrete behaviours ("ask one question before the pitch"), not platitudes.
- If the transcript is mostly a voicemail or a gatekeeper, say so in the summary, set outcome accordingly and keep scores neutral (3) except what was actually observable.
- Return JSON only.`;

export function coachCallUserPrompt(i: CoachCallInput): string {
  const s = i.stats;
  return [
    `Rep: ${i.rep.name ?? 'unknown'}. Prospect: ${i.prospect.name ?? 'unknown'}${i.prospect.title ? `, ${i.prospect.title}` : ''}${i.prospect.company ? ` at ${i.prospect.company}` : ''}.`,
    `Call length ${Math.round(i.callDurationSeconds)} s${i.disposition ? `, logged as "${i.disposition}"` : ''}${i.sequenceStep ? `, sequence step "${i.sequenceStep}"` : ''}.`,
    `Talk stats: rep ${Math.round(s.talkRatio * 100)}% of speech, longest rep monologue ${s.longestRepMonologueSeconds}s, rep asked ${s.repQuestions} questions, ${s.repWordsPerMinute} wpm, rep interrupted ${s.interruptionsByRep}x, prospect interrupted ${s.interruptionsByProspect}x.`,
    '',
    'Transcript:',
    i.transcript,
  ].join('\n');
}
