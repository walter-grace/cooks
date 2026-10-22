import type { DbOrTx } from '@cooks/db';
import { resolveAiConfig, type EnvKeys } from '../config.js';
import { providerFor } from '../providers/registry.js';
import type { LlmProvider } from '../providers/types.js';
import { CLASSIFY_REPLY_SYSTEM, CLASSIFY_REPLY_VERSION, ClassifyReplyOutput, classifyReplyUserPrompt, type ClassifyReplyInput } from '../contracts/classify-reply.js';
import { runStructured, type StructuredOutcome } from '../run-structured.js';

/** Classify one inbound reply. Side effects (pause, suppress) are applied by the inbound pipeline, conservatively. */
export async function classifyReply(
  d: { db: DbOrTx; env: EnvKeys; now: () => Date; workspaceId: string; providerOverride?: LlmProvider },
  input: ClassifyReplyInput,
  parent: { type: string; id: string },
): Promise<StructuredOutcome<ClassifyReplyOutput> | { status: 'skipped'; reason: string }> {
  const cfg = await resolveAiConfig(d.db, d.workspaceId, d.env);
  if (!cfg) return { status: 'skipped', reason: 'no AI provider configured' };
  const provider = d.providerOverride ?? providerFor(cfg, 'classify');
  return runStructured(
    { db: d.db, workspaceId: d.workspaceId, cfg, provider, now: d.now },
    {
      kind: 'classify_reply',
      version: CLASSIFY_REPLY_VERSION,
      system: CLASSIFY_REPLY_SYSTEM,
      input,
      userPrompt: classifyReplyUserPrompt,
      schema: ClassifyReplyOutput,
      schemaName: 'classify_reply',
      effort: 'low',
      maxTokens: 1024,
      cacheTtlMs: 30 * 24 * 3600_000,
      parentType: parent.type,
      parentId: parent.id,
    },
    (o) => (o.intent === 'unsubscribe' && o.confidence < 0.9 ? 'unsubscribe below 0.9 confidence' : null),
  );
}
