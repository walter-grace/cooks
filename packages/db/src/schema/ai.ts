import { boolean, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { id, tenant, timestamps, workspaceId } from './_base.js';

export const aiProvider = pgEnum('ai_provider', ['anthropic', 'openai', 'xai', 'openrouter', 'ollama', 'custom']);
export const agentKind = pgEnum('agent_kind', ['email_writer', 'reply_classifier', 'researcher', 'next_best_action']);
export const runKind = pgEnum('run_kind', ['draft_email', 'classify_reply', 'research', 'signals.scan', 'coach_call', 'nba', 'agent_loop', 'mcp_tool_call']);
export const runStatus = pgEnum('run_status', ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'needs_review']);

export const workspaceAiSettings = pgTable('workspace_ai_settings', {
  workspaceId: uuid('workspace_id').primaryKey(),
  provider: aiProvider('provider').notNull().default('anthropic'),
  model: text('model'),
  baseUrl: text('base_url'),
  apiKeyCiphertext: text('api_key_ciphertext'),
  apiKeyLast4: text('api_key_last4'),
  classifyModel: text('classify_model'),
  draftModel: text('draft_model'),
  autoSendAiEmail: boolean('auto_send_ai_email').notNull().default(false),
  confidenceThreshold: numeric('confidence_threshold').notNull().default('0.75'),
  monthlyBudgetUsd: numeric('monthly_budget_usd'),
  logRawPrompts: boolean('log_raw_prompts').notNull().default(false),
  updatedAt: timestamps.updatedAt,
});

export interface AgentStyle {
  tone?: string;
  lengthWords?: number;
  formality?: 'casual' | 'neutral' | 'formal';
  cta?: string;
  signoff?: string;
}

export const aiAgents = pgTable(
  'ai_agents',
  {
    ...tenant(),
    name: text('name').notNull(),
    kind: agentKind('kind').notNull().default('email_writer'),
    persona: text('persona'),
    systemPrompt: text('system_prompt'),
    style: jsonb('style').$type<AgentStyle>().notNull().default({}),
    topics: jsonb('topics').$type<string[]>().notNull().default([]),
    neverMention: jsonb('never_mention').$type<string[]>().notNull().default([]),
    examples: jsonb('examples').$type<Array<{ input: string; output: string }>>().notNull().default([]),
    providerOverride: text('provider_override'),
    modelOverride: text('model_override'),
    temperature: numeric('temperature'),
    promptVersion: integer('prompt_version').notNull().default(1),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: uuid('created_by'),
  },
  (t) => [index('ai_agents_ws_idx').on(t.workspaceId, t.kind)],
);

export const agentRuns = pgTable(
  'agent_runs',
  {
    id: id(),
    workspaceId: workspaceId(),
    agentId: uuid('agent_id'),
    kind: runKind('kind').notNull(),
    provider: text('provider'),
    model: text('model'),
    status: runStatus('status').notNull().default('queued'),
    parentType: text('parent_type'),
    parentId: text('parent_id'),
    inputHash: text('input_hash'),
    inputRedacted: jsonb('input_redacted').$type<Record<string, unknown>>(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    turns: integer('turns').notNull().default(0),
    tokensIn: integer('tokens_in').notNull().default(0),
    tokensOut: integer('tokens_out').notNull().default(0),
    tokensCacheRead: integer('tokens_cache_read').notNull().default(0),
    tokensCacheWrite: integer('tokens_cache_write').notNull().default(0),
    costUsd: numeric('cost_usd', { precision: 12, scale: 6 }),
    latencyMs: integer('latency_ms'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('agent_runs_ws_created_idx').on(t.workspaceId, t.createdAt),
    index('agent_runs_parent_idx').on(t.parentType, t.parentId),
  ],
);

export const agentRunLogs = pgTable(
  'agent_run_logs',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    level: text('level').notNull().default('info'),
    line: text('line').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

export const aiCache = pgTable(
  'ai_cache',
  {
    kind: text('kind').notNull(),
    model: text('model').notNull(),
    promptVersion: integer('prompt_version').notNull(),
    inputHash: text('input_hash').notNull(),
    output: jsonb('output').$type<Record<string, unknown>>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.kind, t.model, t.promptVersion, t.inputHash] })],
);
