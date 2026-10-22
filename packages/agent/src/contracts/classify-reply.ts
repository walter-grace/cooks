import { z } from 'zod';

export const CLASSIFY_REPLY_VERSION = 1;

export const ClassifyReplyInput = z.object({
  outbound: z.object({ subject: z.string(), text: z.string(), sentAt: z.string() }).nullable(),
  reply: z.object({ from: z.string(), subject: z.string(), text: z.string(), receivedAt: z.string(), autoSubmitted: z.boolean() }),
  prospect: z.object({ name: z.string().nullable(), title: z.string().nullable(), company: z.string().nullable() }),
});
export type ClassifyReplyInput = z.infer<typeof ClassifyReplyInput>;

export const ClassifyReplyOutput = z.object({
  intent: z.enum(['positive', 'meeting_request', 'objection', 'not_now', 'ooo', 'auto_reply', 'unsubscribe', 'wrong_person', 'referral', 'bounce', 'other']),
  sentiment: z.enum(['positive', 'neutral', 'negative']),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(300),
  suggestedAction: z.enum(['book_meeting', 'reply', 'pause_until', 'finish', 'reassign', 'unsubscribe', 'ignore']),
  pauseUntil: z.string().nullable().describe('ISO 8601 date when the prospect asked to be contacted later or is out of office'),
  referral: z.object({ name: z.string().nullable(), email: z.string().nullable(), title: z.string().nullable() }).nullable(),
  objection: z.enum(['price', 'timing', 'competitor', 'no_need', 'authority', 'other']).nullable(),
  draftReply: z.string().nullable().describe('A short suggested reply when suggestedAction is reply or book_meeting'),
});
export type ClassifyReplyOutput = z.infer<typeof ClassifyReplyOutput>;

export const CLASSIFY_REPLY_SYSTEM = `You classify inbound email replies to sales outreach. Read the original outbound email (if any) and the reply, then return a structured verdict.

Guidance:
- ooo and auto_reply are for automatic messages; extract the return date into pauseUntil when stated.
- unsubscribe covers any request to stop emailing, including angry replies. Only use it when the request is explicit.
- wrong_person and referral: when the reply points to someone else, fill referral with whatever contact details appear verbatim in the reply.
- meeting_request when they propose or accept a time; positive when interested but no time proposed.
- Keep summary factual and under 300 characters. Never invent details.
Return JSON only.`;

export function classifyReplyUserPrompt(input: ClassifyReplyInput): string {
  return JSON.stringify(input, null, 2);
}
