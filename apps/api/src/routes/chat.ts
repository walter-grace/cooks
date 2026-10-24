/**
 * POST /v1/chat: the in-app assistant. Streams server-sent events while a small agent loop runs
 * on the workspace's model provider and the MCP tool catalog. Tools execute as the caller, through
 * the API itself, so scopes, roles and rate limits apply exactly as they would for the person.
 */
import { createRoute, z } from '@hono/zod-openapi';
import { streamSSE } from 'hono/streaming';
import { providerFor, resolveAiConfig, runChat, type ChatTool, type EnvKeys, type LlmProvider, type ResolvedAiConfig } from '@cooks/agent';
import { badRequest, errorResponses, jsonBody, unprocessable } from '@cooks/core';
import { users, workspaces } from '@cooks/db';
import { eq } from 'drizzle-orm';
import { TOOLS } from 'cooks-mcp/tools';
import type { ApiClient } from 'cooks-mcp/client';
import { register, type Registrar } from '../register.js';

export interface ChatDeps {
  env: EnvKeys;
  /** Tests swap the provider; production uses the registry. */
  providerFor?: (cfg: ResolvedAiConfig) => LlmProvider;
}

const Body = z.object({
  data: z.object({
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) })).min(1).max(40),
    page: z.string().max(300).optional(),
  }),
});

/** The MCP catalog as chat tools, executed against this very app with the caller's token. */
export function chatToolsFor(reg: Registrar, token: string): ChatTool[] {
  const api: ApiClient = {
    baseUrl: '',
    call: async <T = unknown>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}) => {
      const url = new URL(`http://cooks.internal/v1${path}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
      const res = await reg.app.request(url.toString(), {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), 'user-agent': 'cooks-assistant' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let out: unknown;
      try {
        out = text ? JSON.parse(text) : undefined;
      } catch {
        out = text;
      }
      if (!res.ok) {
        const err = (out as { error?: { code?: string; message?: string } })?.error;
        throw new Error(`${err?.code ?? res.status}: ${err?.message ?? 'request failed'}`);
      }
      return out as T;
    },
  };
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    schema: z.toJSONSchema(z.object(t.input)) as Record<string, unknown>,
    readOnly: t.readOnly,
    destructive: t.destructive || (!t.readOnly && /send|dial|call|delete|enroll|finish|revoke|disconnect|start/i.test(t.name)),
    run: async (args) => {
      const parsed = z.object(t.input).safeParse(args);
      if (!parsed.success) throw new Error(`invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      return t.run(api, parsed.data as never);
    },
  }));
}

export function mountChat(reg: Registrar, d: ChatDeps) {
  register(
    reg,
    createRoute({
      method: 'post',
      path: '/v1/chat',
      operationId: 'chat',
      tags: ['AI'],
      summary: 'Ask the in-app assistant',
      description: 'Streams server-sent events: thinking, tool_call, tool_result, reply (with an optional page to open), error, done. Runs on the workspace AI provider; 422 when none is configured.',
      request: { body: jsonBody(Body) },
      responses: { 200: { description: 'text/event-stream' }, ...errorResponses },
    }),
    { scope: 'agents:run', rateClass: 'default', extension: true },
    async (c) => {
      const ctx = c.get('ctx');
      const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
      if (!token) throw badRequest('A bearer token is required');
      const cfg = await resolveAiConfig(ctx.db, ctx.principal.workspaceId, d.env);
      if (!cfg) throw unprocessable('No model provider is configured. Add one under Settings → Hosted AI.');
      const provider = (d.providerFor ?? ((x) => providerFor(x, 'general')))(cfg);
      const { messages, page } = c.req.valid('json').data;
      const [ws] = await ctx.db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ctx.principal.workspaceId)).limit(1);
      const [u] = ctx.principal.userId ? await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, ctx.principal.userId)).limit(1) : [];
      const tools = chatToolsFor(reg, token);
      return streamSSE(c, async (stream) => {
        let id = 0;
        const send = (event: string, data: unknown) => stream.writeSSE({ id: String(++id), event, data: JSON.stringify(data) });
        try {
          const out = await runChat({
            provider,
            tools,
            messages,
            context: { workspaceName: ws?.name ?? 'your workspace', userName: u?.name ?? 'the user', userRole: ctx.principal.role ?? 'member', page, now: ctx.clock.now().toISOString().slice(0, 10) },
            onEvent: (e) => send(e.type, e),
          });
          await send('done', { steps: out.steps, toolCalls: out.toolCalls, usage: out.usage, model: provider.model });
        } catch (e) {
          await send('error', { type: 'error', message: (e as Error).message });
        }
      });
    },
  );
}
