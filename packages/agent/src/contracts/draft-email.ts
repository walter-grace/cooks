import { z } from 'zod';

export const DRAFT_EMAIL_VERSION = 1;

export const DraftEmailInput = z.object({
  prospect: z.object({ firstName: z.string().nullable(), lastName: z.string().nullable(), title: z.string().nullable(), email: z.string().nullable(), linkedInUrl: z.string().nullable(), custom: z.record(z.string(), z.unknown()) }),
  account: z.object({ name: z.string().nullable(), domain: z.string().nullable(), industry: z.string().nullable(), employeeCount: z.number().nullable(), description: z.string().nullable() }).nullable(),
  owner: z.object({ name: z.string().nullable(), title: z.string().nullable(), email: z.string().nullable(), calendarUrl: z.string().nullable() }),
  sequence: z.object({ name: z.string(), stepOrder: z.number(), totalSteps: z.number() }),
  thread: z.array(z.object({ direction: z.enum(['out', 'in']), at: z.string(), subject: z.string(), text: z.string() })).max(6),
  agent: z.object({ persona: z.string().nullable(), style: z.record(z.string(), z.unknown()), topics: z.array(z.string()), neverMention: z.array(z.string()) }).nullable(),
  promptOverride: z.string().nullable(),
  stepNote: z.string().nullable(),
  constraints: z.object({ maxWords: z.number(), isReply: z.boolean(), language: z.string() }),
});
export type DraftEmailInput = z.infer<typeof DraftEmailInput>;

export const DraftEmailOutput = z.object({
  subject: z.string().max(120),
  bodyText: z.string(),
  usedFacts: z.array(z.string()).describe('Every concrete claim about the prospect or company, each traceable to the input'),
  riskFlags: z.array(z.enum(['unverified_claim', 'pricing', 'legal', 'pii', 'off_topic', 'competitor'])),
  confidence: z.number().min(0).max(1),
  rationale: z.string().max(400),
});
export type DraftEmailOutput = z.infer<typeof DraftEmailOutput>;

export const DRAFT_EMAIL_SYSTEM = `You write short outbound sales emails on behalf of a sales rep. You are given facts about the prospect, their company, the rep, and the sequence step. Write one email.

Rules:
- Use only facts present in the input. Never invent names, numbers, events, or product details. List every concrete claim in usedFacts; if a claim is not in the input, do not make it.
- One clear ask, under the word limit. Plain language, no hype, no exclamation marks, no emoji, no buzzwords.
- Vary sentence length. No bullet lists in cold emails. No "I hope this finds you well".
- Reply steps continue the thread; do not restart the pitch.
- Respect the persona, style, topics and never-mention list when an agent is provided. Follow promptOverride when present.
- Do not include a signature or an unsubscribe line; the system adds them.
- Set confidence low (< 0.6) when key facts are missing or the ask is unclear, and add riskFlags for anything a manager should review before sending.
Return JSON only.`;

export function draftEmailUserPrompt(input: DraftEmailInput): string {
  return JSON.stringify(input, null, 2);
}
