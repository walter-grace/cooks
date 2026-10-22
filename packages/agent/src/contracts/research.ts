import { z } from 'zod';

export const RESEARCH_VERSION = 1;

export const ResearchInput = z.object({
  prospect: z.object({ name: z.string().nullable(), title: z.string().nullable(), linkedInUrl: z.string().nullable() }),
  account: z.object({ name: z.string().nullable(), domain: z.string().nullable(), industry: z.string().nullable(), description: z.string().nullable() }).nullable(),
  focus: z.string().nullable().describe('What the rep sells or wants to find out'),
  today: z.string(),
});
export type ResearchInput = z.infer<typeof ResearchInput>;

export const SIGNAL_KINDS = ['funding', 'hiring', 'news', 'tech', 'leadership', 'expansion', 'product', 'event', 'other'] as const;

export const ResearchOutput = z.object({
  summary: z.string().describe('Three to five sentences on the company and the person, grounded in the search results'),
  talkingPoints: z.array(z.string()),
  signals: z.array(
    z.object({
      kind: z.enum(SIGNAL_KINDS),
      text: z.string(),
      sourceUrl: z.string().nullable(),
      date: z.string().nullable().describe('ISO date if the source states one'),
    }),
  ),
  confidence: z.number().min(0).max(1),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export const RESEARCH_SYSTEM = `You are a sales research assistant. Using the web search results provided to you, build a short, factual brief on a company and (when given) a person at it, for a rep preparing outreach.

Rules:
- Only state facts that appear in the search results or the input. If results are thin, say so in the summary and lower confidence; never fill gaps with plausible-sounding claims.
- Every signal needs a sourceUrl from the results when one exists. Prefer recent items (last 12 months) and tag each with the best kind.
- Talking points are concrete openers a rep could use, each tied to a fact above.
- Keep it compact. Return JSON only.`;

export function researchUserPrompt(input: ResearchInput): string {
  const who = input.prospect.name ? `${input.prospect.name}${input.prospect.title ? `, ${input.prospect.title}` : ''}` : 'the company only';
  const co = input.account ? `${input.account.name ?? ''} ${input.account.domain ? `(${input.account.domain})` : ''}`.trim() : 'unknown company';
  return [
    `Today is ${input.today}.`,
    `Company: ${co}${input.account?.industry ? `, industry: ${input.account.industry}` : ''}${input.account?.description ? `. Known: ${input.account.description}` : ''}`,
    `Person: ${who}${input.prospect.linkedInUrl ? ` (${input.prospect.linkedInUrl})` : ''}`,
    input.focus ? `What the rep sells / wants to know: ${input.focus}` : '',
    'Search the web for recent news, funding, hiring, leadership changes, product launches and technology choices, then produce the brief.',
  ]
    .filter(Boolean)
    .join('\n');
}
