/** Built-in practice scenarios, plus one built from a real prospect. */
export interface PracticePersona {
  name: string;
  title: string;
  company: string;
  /** One line on temperament: guarded, busy, friendly, skeptical… */
  mood: string;
}

export interface PracticeScenario {
  id: string;
  title: string;
  /** What the rep is told before dialing. */
  brief: string;
  persona: PracticePersona;
  /** The situation from the persona's side. */
  situation: string;
  objections: string[];
  difficulty: 'easy' | 'medium' | 'hard';
}

export const PRACTICE_SCENARIOS: PracticeScenario[] = [
  {
    id: 'cold-vp-sales',
    title: 'Cold call: VP of Sales',
    brief: 'Dana has never heard of you. Earn thirty seconds, then a meeting.',
    persona: { name: 'Dana Park', title: 'VP of Sales', company: 'Northwind Logistics', mood: 'busy and guarded, warms up to a sharp question' },
    situation: 'You are between meetings and picked up an unknown number by reflex. You get six of these calls a week.',
    objections: ['Who is this and how did you get my number?', 'We already use a tool for this.', 'Send me an email.', 'What does it cost?'],
    difficulty: 'medium',
  },
  {
    id: 'gatekeeper',
    title: 'The gatekeeper',
    brief: 'Reach the CFO through an executive assistant who screens every call.',
    persona: { name: 'Marcus Lee', title: 'Executive Assistant to the CFO', company: 'Harbor Health', mood: 'polite, firm, protective of the calendar' },
    situation: 'Your job is to keep vendors away from the CFO unless they have a real reason. You take messages and rarely transfer.',
    objections: ['Is she expecting your call?', 'What is this regarding?', 'You can send that to the general inbox.', 'She does not take vendor calls.'],
    difficulty: 'hard',
  },
  {
    id: 'incumbent',
    title: 'Happy with the incumbent',
    brief: 'They renewed with a competitor last quarter. Find the crack without trashing the competitor.',
    persona: { name: 'Priya Natarajan', title: 'Head of Revenue Operations', company: 'Larkspur Software', mood: 'friendly, confident, a little bored' },
    situation: 'You renewed with your current vendor three months ago. It mostly works. Switching sounds like a project you do not want.',
    objections: ['We just renewed, so the timing is off.', 'Honestly it works fine.', 'Migration would eat a quarter.', 'My team would revolt.'],
    difficulty: 'medium',
  },
  {
    id: 'budget-freeze',
    title: 'Budget freeze',
    brief: 'Interested buyer, no budget until next fiscal year. Keep the deal alive without discounting.',
    persona: { name: 'Tom Alvarez', title: 'Director of Demand Generation', company: 'Cobalt Analytics', mood: 'warm, candid, under pressure from finance' },
    situation: 'You like what you have heard but finance froze new spend until February. You want a reason to go fight for it.',
    objections: ['There is no budget until February.', 'Can you do a free pilot?', 'My boss will ask what we cut to pay for this.', 'Why not just wait?'],
    difficulty: 'easy',
  },
  {
    id: 'skeptic',
    title: 'The skeptic',
    brief: 'A technical buyer who has been burned by AI claims. Prove you know the product.',
    persona: { name: 'Elena Fischer', title: 'VP of Engineering', company: 'Granite Systems', mood: 'blunt, precise, allergic to buzzwords' },
    situation: 'The last two vendors oversold. You will hang up on the first vague answer and reward a specific one.',
    objections: ['Everyone says AI. What does it actually do?', 'What happens when it is wrong?', 'Where does our data go?', 'Show me a number, not an adjective.'],
    difficulty: 'hard',
  },
  {
    id: 'renewal-risk',
    title: 'Renewal at risk',
    brief: 'An existing customer thinking about churning. Discover why before you pitch.',
    persona: { name: 'Jordan Reyes', title: 'Sales Manager', company: 'Pinecrest Staffing', mood: 'frustrated but fair, wants to be heard' },
    situation: 'Adoption dropped after two reps left. Support was slow in March. You are taking calls from competitors.',
    objections: ['Half my team stopped using it.', 'Support took a week to answer.', 'A competitor offered us a better price.', 'Why should I stay?'],
    difficulty: 'medium',
  },
];

export const practiceScenario = (id: string) => PRACTICE_SCENARIOS.find((s) => s.id === id) ?? null;

/** A scenario for a real prospect: same shape, built from the CRM record. */
export function scenarioFromProspect(p: { name: string; title?: string | null }, account?: { name?: string | null; industry?: string | null } | null): PracticeScenario {
  const company = account?.name ?? 'their company';
  return {
    id: 'prospect',
    title: `Call ${p.name}`,
    brief: `Rehearse the real call to ${p.name}${p.title ? `, ${p.title}` : ''} at ${company}.`,
    persona: { name: p.name, title: p.title ?? 'decision maker', company, mood: 'busy, polite, undecided' },
    situation: `You work at ${company}${account?.industry ? ` in ${account.industry}` : ''}. You do not know the caller.`,
    objections: ['What is this about?', 'We are not looking right now.', 'Send me something I can forward.', 'Who else uses this?'],
    difficulty: 'medium',
  };
}

/** The partner's standing instructions. Plain prose; every provider gets the same text. */
export function partnerInstructions(s: PracticeScenario, rep?: { name?: string | null; company?: string | null }): string {
  return [
    `You are ${s.persona.name}, ${s.persona.title} at ${s.persona.company}, on a phone call. Temperament: ${s.persona.mood}.`,
    `Situation: ${s.situation}`,
    `The caller is a sales rep${rep?.name ? ` named ${rep.name}` : ''}${rep?.company ? ` from ${rep.company}` : ''}. You did not expect the call.`,
    'Stay in character for the whole call. Talk like a real person on the phone: short sentences, natural pauses, the occasional "mm-hm" or "right". Interrupt if the rep rambles. Never narrate, never explain what you are doing, never say you are an AI, and never coach the rep during the call.',
    `Raise these objections when they fit, one at a time, not as a list: ${s.objections.map((o) => `"${o}"`).join(', ')}.`,
    'If the rep asks a good question, answer it honestly and briefly. If the rep is vague, push back. If the rep earns it with a clear reason that matters to you, agree to a twenty-minute meeting and ask for a calendar invite. If the rep is rude or wastes a full minute, end the call.',
    'Keep every reply under three sentences.',
  ].join('\n');
}

export function partnerOpening(s: PracticeScenario): string {
  return s.id === 'gatekeeper' ? `${s.persona.company}, this is ${s.persona.name.split(' ')[0]}.` : `Hello, this is ${s.persona.name.split(' ')[0]}.`;
}
