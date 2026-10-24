/**
 * The in-app assistant: a small agent loop over the workspace's own model provider and the same
 * tool catalog the MCP server exposes. Each step asks the model for one structured decision
 * (call a tool, or reply and optionally navigate), runs it, and feeds the observation back.
 * Structured output keeps it provider-agnostic: anything that can return validated JSON works.
 */
import { z } from 'zod';
import type { LlmProvider, TokenUsage } from './providers/types.js';

export interface ChatTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  schema: Record<string, unknown>;
  readOnly?: boolean;
  destructive?: boolean;
  run(args: Record<string, unknown>): Promise<unknown>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatEvent =
  | { type: 'thinking'; text: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; name: string; ok: boolean; summary: string }
  | { type: 'reply'; text: string; navigate: string | null }
  | { type: 'error'; message: string };

export interface ChatContext {
  workspaceName: string;
  userName: string;
  userRole: string;
  /** Path inside the web app the person is looking at, e.g. /prospects/123. */
  page?: string | null;
  now: string;
}

const Step = z.object({
  thought: z.string().describe('One sentence on what you are doing and why. Shown to the user as progress.'),
  action: z.enum(['tool', 'reply']),
  tool: z.string().optional().describe('Tool name when action is tool'),
  argsJson: z.string().optional().describe('JSON object of arguments when action is tool, e.g. {"q":"acme"}'),
  reply: z.string().optional().describe('The answer, in plain prose, when action is reply'),
  navigate: z.string().nullable().optional().describe('A web app path to open alongside the reply, or null'),
});

export const APP_PAGES = [
  '/ tasks due now',
  '/prospects list, /prospects/{id} one prospect with calls, emails, enrollments',
  '/sequences list, /sequences/{id} steps and enrollments',
  '/emails sent and received',
  '/inbox texts and iMessage',
  '/signals buying signals and rules',
  '/calls list, /calls/{id} recording, transcript and coaching',
  '/dialer the parallel power dialer',
  '/practice practice calls against an AI prospect',
  '/settings?tab=mailboxes|crm|dialer|channels|signals|ai|workspace|api|webhooks',
];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const json = (v: unknown, n: number) => clip(typeof v === 'string' ? v : JSON.stringify(v), n);

export function chatSystemPrompt(ctx: ChatContext, tools: ChatTool[]) {
  const toolLines = tools.map((t) => `- ${t.name}${t.destructive ? ' [changes or sends something]' : t.readOnly ? '' : ' [writes]'}: ${t.description}\n  args: ${JSON.stringify(t.schema)}`).join('\n');
  return `You are the assistant inside Cooks, an open-source sales engagement app (sequences, a parallel dialer, buying signals, call coaching). You help ${ctx.userName} (${ctx.userRole}) in the workspace "${ctx.workspaceName}". Today is ${ctx.now}. They are looking at ${ctx.page ?? 'the app'}.

You work in steps. Each step is one JSON decision: call one tool, or reply. Facts come from tool results, never from memory; if you have not looked something up, look it up. Keep replies short and specific, in plain prose, no markdown headings. When the answer is a record or a page, set navigate to its path so the app opens it. Paths:
${APP_PAGES.map((p) => `- ${p}`).join('\n')}

Rules for tools that send, dial, delete, enroll or change settings (marked below): do not call them unless the person's latest message asks for exactly that; if they asked for something close but not explicit, reply with what you would do and ask them to confirm. Never invent ids: find them with a list or search tool first. Use cooks_search for anything phrased as "find", "where", "who said" or a half-remembered name. Stop after at most ten tool calls and report what you have.

Tools:
${toolLines}`;
}

export interface RunChatOptions {
  provider: LlmProvider;
  tools: ChatTool[];
  messages: ChatMessage[];
  context: ChatContext;
  onEvent?: (e: ChatEvent) => void | Promise<void>;
  maxSteps?: number;
  signal?: AbortSignal;
}

export interface ChatOutcome {
  reply: string;
  navigate: string | null;
  usage: TokenUsage;
  steps: number;
  toolCalls: number;
}

const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
});

export async function runChat(o: RunChatOptions): Promise<ChatOutcome> {
  const system = chatSystemPrompt(o.context, o.tools);
  const emit = async (e: ChatEvent) => o.onEvent?.(e);
  const history = o.messages.slice(-16).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.content, 2000)}`);
  const observations: string[] = [];
  let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: null };
  let toolCalls = 0;
  const maxSteps = o.maxSteps ?? 12;
  for (let step = 1; step <= maxSteps; step++) {
    const user = [
      'Conversation so far:',
      ...history,
      '',
      observations.length ? `Tool results this turn:\n${observations.join('\n')}` : 'No tools called yet this turn.',
      '',
      step === maxSteps ? 'This is the last step: reply now with what you have.' : 'Decide the next step.',
    ].join('\n');
    const r = await o.provider.structured({ system, user, schema: Step, schemaName: 'assistant_step', maxTokens: 1200, temperature: 0.2, signal: o.signal });
    usage = addUsage(usage, r.usage);
    if (r.kind !== 'ok') {
      const message = r.kind === 'refusal' ? `The model declined: ${r.reason}` : `The model returned something unusable: ${r.error}`;
      await emit({ type: 'error', message });
      return { reply: message, navigate: null, usage, steps: step, toolCalls };
    }
    const d = r.value;
    if (d.thought) await emit({ type: 'thinking', text: clip(d.thought, 300) });
    if (d.action === 'reply' || step === maxSteps || !d.tool) {
      const reply = d.reply?.trim() || 'Done.';
      const navigate = d.navigate && d.navigate.startsWith('/') ? d.navigate : null;
      await emit({ type: 'reply', text: reply, navigate });
      return { reply, navigate, usage, steps: step, toolCalls };
    }
    const tool = o.tools.find((t) => t.name === d.tool);
    let args: Record<string, unknown> = {};
    try {
      args = d.argsJson ? (JSON.parse(d.argsJson) as Record<string, unknown>) : {};
    } catch {
      observations.push(`${d.tool}: arguments were not valid JSON (${clip(d.argsJson ?? '', 120)})`);
      continue;
    }
    if (!tool) {
      observations.push(`${d.tool}: no such tool. Available: ${o.tools.map((t) => t.name).join(', ')}`);
      continue;
    }
    toolCalls++;
    await emit({ type: 'tool_call', name: tool.name, args });
    try {
      const out = await tool.run(args);
      const text = json(out ?? null, 6000);
      observations.push(`${tool.name}(${json(args, 300)}) → ${text}`);
      await emit({ type: 'tool_result', name: tool.name, ok: true, summary: clip(text, 160) });
    } catch (e) {
      const msg = (e as Error).message;
      observations.push(`${tool.name}(${json(args, 300)}) failed: ${clip(msg, 500)}`);
      await emit({ type: 'tool_result', name: tool.name, ok: false, summary: clip(msg, 160) });
    }
  }
  return { reply: 'Stopped after too many steps.', navigate: null, usage, steps: maxSteps, toolCalls };
}
