import { and, desc, eq } from 'drizzle-orm';
import { accounts, aiAgents, emails, prospects, sequenceSteps, sequences, tasks, users, type DbOrTx } from '@cooks/db';
import { resolveAiConfig, type EnvKeys } from '../config.js';
import { providerFor } from '../providers/registry.js';
import type { LlmProvider } from '../providers/types.js';
import { DRAFT_EMAIL_SYSTEM, DRAFT_EMAIL_VERSION, DraftEmailOutput, draftEmailUserPrompt, type DraftEmailInput } from '../contracts/draft-email.js';
import { runStructured } from '../run-structured.js';
import { latestResearch } from './research.js';

export type DraftOutcome = { status: 'drafted' | 'needs_review'; emailId: string; runId: string } | { status: 'skipped'; reason: string } | { status: 'failed'; reason: string };

/**
 * Draft the email for a manual_email task that came from a step with `aiEmail`. The draft is
 * attached to the task (task.draftEmailId) as a `draft` email row for the rep to review and send.
 */
export async function draftEmailForTask(
  d: { db: DbOrTx; env: EnvKeys; now: () => Date; providerOverride?: LlmProvider },
  taskId: string,
): Promise<DraftOutcome> {
  const [task] = await d.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!task || task.completed || task.status === 'skipped') return { status: 'skipped', reason: 'task closed' };
  if (task.draftEmailId) return { status: 'skipped', reason: 'already drafted' };
  const [step] = task.sequenceStepId ? await d.db.select().from(sequenceSteps).where(eq(sequenceSteps.id, task.sequenceStepId)).limit(1) : [];
  const ai = step?.aiEmail;
  if (!step || !ai) return { status: 'skipped', reason: 'step has no aiEmail' };

  const cfg = await resolveAiConfig(d.db, task.workspaceId, d.env);
  if (!cfg) return { status: 'skipped', reason: 'no AI provider configured' };
  const provider = d.providerOverride ?? providerFor(cfg, 'draft');

  const [prospect] = await d.db.select().from(prospects).where(eq(prospects.id, task.prospectId)).limit(1);
  const [account] = prospect?.accountId ? await d.db.select().from(accounts).where(eq(accounts.id, prospect.accountId)).limit(1) : [];
  const [owner] = await d.db.select().from(users).where(eq(users.id, task.ownerId)).limit(1);
  const [seq] = await d.db.select().from(sequences).where(eq(sequences.id, step.sequenceId)).limit(1);
  const steps = await d.db.select({ id: sequenceSteps.id }).from(sequenceSteps).where(and(eq(sequenceSteps.sequenceId, step.sequenceId)));
  const [agent] = ai.agent?.id ? await d.db.select().from(aiAgents).where(eq(aiAgents.id, ai.agent.id)).limit(1) : [];
  const thread = task.sequenceStateId
    ? await d.db
        .select()
        .from(emails)
        .where(and(eq(emails.sequenceStateId, task.sequenceStateId), eq(emails.status, 'sent')))
        .orderBy(desc(emails.date))
        .limit(3)
    : [];
  const isReply = step.action.includes('reply');
  const research = await latestResearch(d.db, task.prospectId).catch(() => null);

  const input: DraftEmailInput = {
    prospect: { firstName: prospect?.firstName ?? null, lastName: prospect?.lastName ?? null, title: prospect?.title ?? null, email: prospect?.primaryEmail ?? null, linkedInUrl: prospect?.linkedInUrl ?? null, custom: prospect?.crmCustomFields ?? {} },
    account: account ? { name: account.name, domain: account.domain, industry: account.industry, employeeCount: account.numEmployees, description: account.description } : null,
    owner: { name: owner?.name ?? null, title: owner?.title ?? null, email: owner?.email ?? null, calendarUrl: owner?.calendarUrl ?? null },
    sequence: { name: seq?.name ?? '', stepOrder: step.order, totalSteps: steps.length },
    thread: thread.reverse().map((e) => ({ direction: 'out' as const, at: e.date?.toISOString() ?? '', subject: e.subject ?? '', text: (e.bodyText ?? '').slice(0, 2000) })),
    agent: agent ? { persona: agent.persona ?? agent.systemPrompt ?? null, style: { ...agent.style } as Record<string, unknown>, topics: agent.topics, neverMention: agent.neverMention } : null,
    promptOverride: ai.promptOverride ?? null,
    stepNote: step.note ?? null,
    research: research ? { summary: research.summary, talkingPoints: research.talkingPoints, signals: research.signals.map((x) => ({ kind: x.kind, text: x.text, sourceUrl: x.sourceUrl })) } : null,
    constraints: { maxWords: Number(agent?.style.lengthWords ?? 120), isReply, language: 'en' },
  };

  const out = await runStructured(
    { db: d.db, workspaceId: task.workspaceId, cfg, provider, now: d.now },
    {
      kind: 'draft_email',
      version: DRAFT_EMAIL_VERSION,
      system: DRAFT_EMAIL_SYSTEM,
      input,
      userPrompt: draftEmailUserPrompt,
      schema: DraftEmailOutput,
      schemaName: 'draft_email',
      effort: 'medium',
      cacheTtlMs: null,
      parentType: 'task',
      parentId: taskId,
      agentId: agent?.id ?? null,
    },
    (o) => (o.confidence < cfg.confidenceThreshold ? `confidence ${o.confidence} below ${cfg.confidenceThreshold}` : o.riskFlags.length ? `risk flags: ${o.riskFlags.join(', ')}` : null),
  );
  if (out.status === 'budget_exceeded') return { status: 'skipped', reason: 'monthly AI budget reached' };
  if (out.status === 'refused' || out.status === 'failed') return { status: 'failed', reason: out.status === 'refused' ? out.reason : out.error };

  const draft = out.value;
  const html = `<p>${draft.bodyText.split(/\n{2,}/).map((p) => p.replace(/\n/g, '<br>')).join('</p><p>')}</p>`;
  const lastSubject = input.thread.at(-1)?.subject;
  const [email] = await d.db
    .insert(emails)
    .values({
      workspaceId: task.workspaceId,
      prospectId: task.prospectId,
      accountId: task.accountId,
      taskId: task.id,
      sequenceId: task.sequenceId,
      sequenceStateId: task.sequenceStateId,
      sequenceStepId: task.sequenceStepId,
      ownerId: task.ownerId,
      direction: 'outbound',
      status: 'draft',
      toAddr: prospect?.primaryEmail ?? null,
      recipients: prospect?.primaryEmail ? [prospect.primaryEmail] : [],
      subject: isReply && lastSubject ? `Re: ${lastSubject.replace(/^Re:\s*/i, '')}` : draft.subject,
      bodyText: draft.bodyText,
      bodyHtml: html,
    })
    .returning({ id: emails.id });
  await d.db
    .update(tasks)
    .set({ draftEmailId: email!.id, note: [task.note, out.status === 'needs_review' ? `AI draft needs review (${out.reason}).` : 'AI draft attached.'].filter(Boolean).join(' ') })
    .where(eq(tasks.id, task.id));
  return { status: out.status === 'needs_review' ? 'needs_review' : 'drafted', emailId: email!.id, runId: out.runId };
}
