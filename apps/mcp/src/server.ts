import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ApiError, createApiClient, type ApiClient } from './client.js';
import { TOOLS } from './tools.js';

export const SERVER_VERSION = '0.1.0';

const PROMPTS = [
  {
    name: 'enroll-prospect-in-sequence',
    title: 'Enroll a prospect in a sequence',
    description: 'Find or create the prospect, pick the right sequence, enroll with the correct owner.',
    args: { prospect: z.string().describe('Name, email or company of the person'), sequence: z.string().describe('Sequence name or goal') },
    text: (a: { prospect: string; sequence: string }) =>
      `Enroll "${a.prospect}" in the sequence "${a.sequence}".\n1. Call cooks_me to learn the workspace and default owner.\n2. Use cooks_list_prospects (by email or name) to find the prospect; if missing, create it with cooks_create_prospect and link an account.\n3. Use cooks_list_sequences to find the sequence by name; show me its steps with cooks_list_sequence_steps so I can confirm.\n4. Enroll with cooks_enroll_prospect. If you get CONFLICT the prospect is already enrolled: report the existing enrollment instead.\n5. Reply with the enrollment id, the first step and when it is due.`,
  },
  {
    name: 'work-the-task-queue',
    title: 'Work today\'s task queue',
    description: 'Pull due tasks for a rep, do the manual steps, mark them complete or skipped.',
    args: { owner: z.string().optional().describe('Rep email or user id; defaults to the authenticated user') },
    text: (a: { owner?: string }) =>
      `Work the open task queue${a.owner ? ` for ${a.owner}` : ''}.\n1. cooks_list_tasks with dueBefore = now, includeProspect = true, ordered by priority.\n2. For each task, summarize the prospect and the step note. For manual_email tasks draft the email for me to approve; for call tasks give me a 3-line opener; for LinkedIn tasks draft the message.\n3. After I confirm an action, call cooks_complete_task (or cooks_skip_task if I say skip) so the enrollment advances.\n4. Finish with a short recap: done, skipped, still open.`,
  },
  {
    name: 'draft-sequence',
    title: 'Draft a new sequence',
    description: 'Design a multi-step outbound sequence and create it.',
    args: { audience: z.string().describe('Who this targets and the offer'), steps: z.string().optional().describe('Desired number of steps / channels') },
    text: (a: { audience: string; steps?: string }) =>
      `Design an outbound sequence for: ${a.audience}.${a.steps ? ` Constraints: ${a.steps}.` : ''}\nPropose the steps first (channel, delay in days, subject, body with Liquid merge fields like {{ prospect.firstName }} and {{ account.name }}; keep emails under 120 words, one clear ask, no hype). After I approve, create it with cooks_create_sequence then cooks_create_sequence_step for each step in order, intervals in minutes. Return the sequence id and a step table.`,
  },
];

export interface ServerOptions {
  apiUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

/** One McpServer per connection. Tools proxy to the REST API with the caller's token. */
export function createServer(opts: ServerOptions): McpServer {
  const api: ApiClient = createApiClient(opts.apiUrl, opts.token, opts.fetchImpl);
  const server = new McpServer(
    { name: 'cooks', version: SERVER_VERSION },
    {
      instructions:
        'Cooks is an open-source sales engagement platform (sequences, tasks, prospects, accounts, email). ' +
        'Start with cooks_me to learn the workspace and the owner user id. Ids are UUIDs. Lists are paginated: follow links.next via pageAfter. ' +
        'Errors return {error:{code,message}}: CONFLICT means already enrolled, UNPROCESSABLE_ENTITY explains a rule violation, NO_CRM_CONNECTION means no CRM is linked yet. ' +
        'Never send email on a prospect\'s behalf without the user confirming the draft.',
    },
  );

  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.input,
        annotations: { readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, idempotentHint: !!t.idempotent, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await t.run(api, args as never);
          const text = JSON.stringify(result ?? { ok: true }, null, 2);
          return { content: [{ type: 'text', text }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? (result as Record<string, unknown>) : { result } };
        } catch (e) {
          if (e instanceof ApiError) {
            return { isError: true, content: [{ type: 'text', text: JSON.stringify({ status: e.status, ...(typeof e.body === 'object' && e.body ? e.body : { error: { code: e.code, message: e.message } }) }, null, 2) }] };
          }
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { code: 'MCP_ERROR', message: (e as Error).message } }) }] };
        }
      },
    );
  }

  server.registerResource('openapi', 'cooks://openapi', { title: 'Cooks OpenAPI document', description: 'Full REST API contract (YAML)', mimeType: 'application/yaml' }, async (uri) => {
    const res = await (opts.fetchImpl ?? fetch)(`${api.baseUrl}/openapi.yml`);
    return { contents: [{ uri: uri.href, mimeType: 'application/yaml', text: await res.text() }] };
  });
  server.registerResource(
    'merge-fields',
    'cooks://docs/merge-fields',
    { title: 'Email merge fields', description: 'Liquid variables available in email subjects and bodies', mimeType: 'text/markdown' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: [
            '# Merge fields (LiquidJS, strict variables)',
            '',
            '- prospect: firstName, lastName, name, title, email, phone, linkedInUrl, city, state, country, timezone, custom.<key>',
            '- account: name, domain, website, industry, employeeCount, city, custom.<key>',
            '- owner: firstName, lastName, name, email, title, phone, calendarUrl, signature',
            '- sequence.name, step.order, step.name',
            '- now.date, now.dayOfWeek, now.month, now.year',
            '- unsubscribeUrl (a footer is appended automatically when missing)',
            '',
            'Filters: default, first_name_or, titlecase, date_fmt. Unknown variables block the send and create a task for the owner.',
          ].join('\n'),
        },
      ],
    }),
  );

  const registerPrompt = server.registerPrompt.bind(server) as unknown as (name: string, cfg: unknown, cb: (args: Record<string, string>) => unknown) => void;
  for (const p of PROMPTS) {
    registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.args }, (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: p.text(args as never) } }],
    }));
  }
  return server;
}
