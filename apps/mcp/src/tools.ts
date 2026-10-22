import { z } from 'zod';
import type { ApiClient } from './client.js';

/**
 * Tool catalog. Names are stable so prompts and skills can rely on them. Every tool maps
 * onto one API call, so a model can cross-reference /docs when it needs more detail.
 */
export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  idempotent?: boolean;
  run: (api: ApiClient, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

const uuid = z.string().uuid();
const page = {
  pageSize: z.number().int().min(1).max(100).optional().describe('Items per page (default 50)'),
  pageAfter: z.string().optional().describe('Cursor from a previous links.next'),
};
const updatedAt = {
  updatedAtGte: z.string().optional().describe('ISO 8601: only items updated at or after this time'),
};
const pq = (a: { pageSize?: number; pageAfter?: string; updatedAtGte?: string }) => ({
  'page[size]': a.pageSize,
  'page[after]': a.pageAfter,
  'filter[updatedAt][gte]': a.updatedAtGte,
});

const def = <S extends z.ZodRawShape>(d: ToolDef<S>): ToolDef => d as unknown as ToolDef;

export const TOOLS: ToolDef[] = [
  def({
    name: 'cooks_me',
    title: 'Who am I',
    description: 'Describe the authenticated workspace, user and scopes. Call this first to learn the workspace id and which user id to use as owner.',
    input: {},
    readOnly: true,
    run: (api) => api.call('GET', '/me'),
  }),
  def({
    name: 'cooks_list_users',
    title: 'List users',
    description: 'List workspace users (reps). Use a user id as `ownerId` when creating sequences, tasks or enrollments.',
    input: { email: z.string().optional(), name: z.string().optional(), ...page },
    readOnly: true,
    run: (api, a) => api.call('GET', '/users', { query: { 'filter[email]': a.email, 'filter[name]': a.name, ...pq(a) } }),
  }),
  def({
    name: 'cooks_list_prospects',
    title: 'List or search prospects',
    description: 'List prospects with exact-match filters (name, title, email, crmId, accountId, sequenceId). Pass includeSequenceStates to see enrollments.',
    input: {
      name: z.string().optional(),
      title: z.string().optional(),
      primaryEmail: z.string().optional(),
      crmId: z.string().optional(),
      accountId: uuid.optional(),
      sequenceId: uuid.optional(),
      includeSequenceStates: z.boolean().optional(),
      includeCrmCustomFields: z.boolean().optional(),
      ...page,
      ...updatedAt,
    },
    readOnly: true,
    run: (api, a) =>
      api.call('GET', '/prospects', {
        query: {
          'filter[name]': a.name,
          'filter[title]': a.title,
          'filter[primaryEmail]': a.primaryEmail,
          'filter[crmId]': a.crmId,
          'filter[account][id]': a.accountId,
          'filter[sequence][id]': a.sequenceId,
          include: a.includeSequenceStates ? 'sequenceStates' : undefined,
          includeCRMCustomFields: a.includeCrmCustomFields ? 'true' : undefined,
          ...pq(a),
        },
      }),
  }),
  def({
    name: 'cooks_get_prospect',
    title: 'Get prospect',
    description: 'Fetch one prospect by id, with its enrollments expanded.',
    input: { id: uuid },
    readOnly: true,
    run: (api, a) => api.call('GET', `/prospects/${a.id}`, { query: { include: 'sequenceStates', includeCRMCustomFields: 'true' } }),
  }),
  def({
    name: 'cooks_create_prospect',
    title: 'Create prospect',
    description: 'Create a prospect. Provide at least a name or primaryEmail. Link to an account with accountId.',
    input: {
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      title: z.string().optional(),
      primaryEmail: z.string().email().optional(),
      phone: z.string().optional(),
      linkedInUrl: z.string().url().optional(),
      timezone: z.string().optional().describe('IANA zone, e.g. America/New_York; drives send windows'),
      accountId: uuid.optional(),
      crmId: z.string().optional(),
      crmCustomFields: z.record(z.string(), z.unknown()).optional(),
    },
    run: (api, { accountId, ...rest }) => api.call('POST', '/prospects', { body: { data: { ...rest, account: accountId ? { id: accountId } : undefined } } }),
  }),
  def({
    name: 'cooks_update_prospect',
    title: 'Update prospect',
    description: 'Update prospect fields. Only provided fields change.',
    input: {
      id: uuid,
      firstName: z.string().nullable().optional(),
      lastName: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      primaryEmail: z.string().email().nullable().optional(),
      phone: z.string().nullable().optional(),
      linkedInUrl: z.string().url().nullable().optional(),
      timezone: z.string().nullable().optional(),
      accountId: uuid.nullable().optional(),
      crmCustomFields: z.record(z.string(), z.unknown()).optional(),
    },
    idempotent: true,
    run: (api, { id, accountId, ...rest }) =>
      api.call('PATCH', `/prospects/${id}`, { body: { data: { ...rest, account: accountId === undefined ? undefined : accountId ? { id: accountId } : null } } }),
  }),
  def({
    name: 'cooks_list_accounts',
    title: 'List accounts',
    description: 'List accounts (companies) with exact-match filters.',
    input: { name: z.string().optional(), domain: z.string().optional(), crmId: z.string().optional(), ...page, ...updatedAt },
    readOnly: true,
    run: (api, a) => api.call('GET', '/accounts', { query: { 'filter[name]': a.name, 'filter[domain]': a.domain, 'filter[crmId]': a.crmId, includeCRMCustomFields: 'true', ...pq(a) } }),
  }),
  def({
    name: 'cooks_get_account',
    title: 'Get account',
    description: 'Fetch one account by id.',
    input: { id: uuid },
    readOnly: true,
    run: (api, a) => api.call('GET', `/accounts/${a.id}`, { query: { includeCRMCustomFields: 'true' } }),
  }),
  def({
    name: 'cooks_create_account',
    title: 'Create account',
    description: 'Create an account (company).',
    input: { name: z.string(), domain: z.string().optional(), numEmployees: z.number().int().optional(), linkedInUrl: z.string().url().optional(), description: z.string().optional(), crmId: z.string().optional(), timezone: z.string().optional() },
    run: (api, a) => api.call('POST', '/accounts', { body: { data: a } }),
  }),
  def({
    name: 'cooks_list_sequences',
    title: 'List sequences',
    description: 'List sequences. Set includeSteps to see each step inline.',
    input: { name: z.string().optional(), includeSteps: z.boolean().optional(), ...page, ...updatedAt },
    readOnly: true,
    run: (api, a) => api.call('GET', '/sequences', { query: { 'filter[name]': a.name, include: a.includeSteps ? 'sequenceSteps,owner' : 'owner', ...pq(a) } }),
  }),
  def({
    name: 'cooks_get_sequence',
    title: 'Get sequence',
    description: 'Fetch one sequence with its steps and analytics.',
    input: { id: uuid },
    readOnly: true,
    run: (api, a) => api.call('GET', `/sequences/${a.id}`, { query: { include: 'sequenceSteps,owner' } }),
  }),
  def({
    name: 'cooks_create_sequence',
    title: 'Create sequence',
    description: 'Create an empty sequence owned by a user, then add steps with cooks_create_sequence_step.',
    input: {
      name: z.string(),
      ownerId: z.string().describe('User id from cooks_list_users or cooks_me'),
      privacy: z.enum(['private', 'team_visible', 'team_editable']).optional(),
      enabled: z.boolean().optional(),
      tagIds: z.array(uuid).optional(),
    },
    run: (api, a) => api.call('POST', '/sequences', { body: { data: { name: a.name, owner: { id: a.ownerId }, privacy: a.privacy, enabled: a.enabled, tags: a.tagIds?.map((id) => ({ id })) } } }),
  }),
  def({
    name: 'cooks_update_sequence',
    title: 'Update sequence',
    description: 'Rename, enable/disable (disabling pauses all active enrollments) or replace tags.',
    input: { id: uuid, name: z.string().optional(), enabled: z.boolean().optional(), tagIds: z.array(uuid).optional() },
    idempotent: true,
    run: (api, a) => api.call('PATCH', `/sequences/${a.id}`, { body: { data: { name: a.name, enabled: a.enabled, tags: a.tagIds?.map((id) => ({ id })) } } }),
  }),
  def({
    name: 'cooks_list_sequence_steps',
    title: 'List sequence steps',
    description: 'List the steps of a sequence in order, with templates.',
    input: { sequenceId: uuid },
    readOnly: true,
    run: (api, a) => api.call('GET', '/sequenceSteps', { query: { 'filter[sequence][id]': a.sequenceId, include: 'template', 'page[size]': 100 } }),
  }),
  def({
    name: 'cooks_create_sequence_step',
    title: 'Add sequence step',
    description:
      'Append a step. `intervalMinutes` is the delay after the previous step (0 for the first). Email steps take emailSubject/emailBody with Liquid merge fields such as {{ prospect.firstName }}, {{ account.name }}, {{ owner.name }}. auto_email sends without a human; manual_email creates a task.',
    input: {
      sequenceId: uuid,
      action: z.enum(['call', 'manual_email', 'auto_email', 'manual_email_reply', 'auto_email_reply', 'basic_task', 'linkedin_connection_request', 'manual_linkedin_message', 'manual_sms', 'auto_sms', 'manual_whatsapp']),
      intervalMinutes: z.number().int().min(0),
      order: z.number().int().min(1).optional().describe('Insert position; omit to append'),
      name: z.string().optional(),
      note: z.string().optional().describe('Instructions shown on the task'),
      emailSubject: z.string().optional(),
      emailBody: z.string().optional().describe('HTML body'),
      aiPromptOverride: z.string().optional().describe('Let a hosted agent draft this email with these instructions'),
    },
    run: (api, a) =>
      api.call('POST', '/sequenceSteps', {
        body: {
          data: {
            sequence: { id: a.sequenceId },
            action: a.action,
            interval: a.intervalMinutes,
            order: a.order,
            name: a.name,
            note: a.note,
            emailSubject: a.emailSubject,
            emailBody: a.emailBody,
            aiEmail: a.aiPromptOverride ? { promptOverride: a.aiPromptOverride } : undefined,
          },
        },
      }),
  }),
  def({
    name: 'cooks_update_sequence_step',
    title: 'Update sequence step',
    description: 'Change interval, name, note or email content. The channel of a step cannot change.',
    input: { id: uuid, intervalMinutes: z.number().int().min(0).optional(), name: z.string().optional(), note: z.string().optional(), emailSubject: z.string().optional(), emailBody: z.string().optional() },
    idempotent: true,
    run: (api, { id, intervalMinutes, ...rest }) => api.call('PATCH', `/sequenceSteps/${id}`, { body: { data: { interval: intervalMinutes, ...rest } } }),
  }),
  def({
    name: 'cooks_delete_sequence_step',
    title: 'Delete sequence step',
    description: 'Remove a step from a sequence.',
    input: { id: uuid },
    destructive: true,
    run: async (api, a) => {
      await api.call('DELETE', `/sequenceSteps/${a.id}`);
      return { deleted: a.id };
    },
  }),
  def({
    name: 'cooks_reorder_sequence_steps',
    title: 'Reorder sequence steps',
    description: 'Set the full step order. `stepIds` must contain every step of the sequence exactly once.',
    input: { sequenceId: uuid, stepIds: z.array(uuid).min(1) },
    idempotent: true,
    run: (api, a) => api.call('POST', `/sequences/${a.sequenceId}/actions/reorderSteps`, { body: { data: { stepIds: a.stepIds } } }),
  }),
  def({
    name: 'cooks_enroll_prospect',
    title: 'Enroll prospect in sequence',
    description: 'Start a prospect in a sequence. Returns 409 CONFLICT if already enrolled, 422 if an email sequence has no email for the prospect. Optional per-step emailOverrides keyed by step id.',
    input: {
      prospectId: uuid,
      sequenceId: uuid,
      ownerId: z.string(),
      startPaused: z.boolean().optional(),
      scheduledAt: z.string().datetime().optional().describe('Start later (ISO 8601)'),
      startAtStepId: uuid.optional(),
      emailOverrides: z.record(z.string().uuid(), z.object({ subject: z.string().optional(), body: z.string().optional() })).optional(),
    },
    run: (api, a) =>
      api.call('POST', '/sequenceStates', {
        body: {
          data: {
            prospect: { id: a.prospectId },
            sequence: { id: a.sequenceId },
            owner: { id: a.ownerId },
            state: a.startPaused ? 'paused' : 'active',
            scheduledAt: a.scheduledAt,
            sequenceStep: a.startAtStepId ? { id: a.startAtStepId } : undefined,
            emailOverrides: a.emailOverrides,
          },
        },
      }),
  }),
  def({
    name: 'cooks_list_enrollments',
    title: 'List enrollments',
    description: 'List sequence enrollments (sequence states) filtered by sequence, prospect, account or state.',
    input: { sequenceId: uuid.optional(), prospectId: uuid.optional(), accountId: uuid.optional(), state: z.enum(['active', 'paused', 'finished', 'pending_start']).optional(), ...page, ...updatedAt },
    readOnly: true,
    run: (api, a) =>
      api.call('GET', '/sequenceStates', {
        query: { 'filter[sequence][id]': a.sequenceId, 'filter[prospect][id]': a.prospectId, 'filter[account][id]': a.accountId, 'filter[state]': a.state, include: 'sequenceStep', ...pq(a) },
      }),
  }),
  def({
    name: 'cooks_pause_enrollment',
    title: 'Pause enrollment',
    description: 'Pause an active enrollment; pending tasks are held.',
    input: { id: uuid },
    idempotent: true,
    run: (api, a) => api.call('POST', `/sequenceStates/${a.id}/actions/pause`),
  }),
  def({
    name: 'cooks_resume_enrollment',
    title: 'Resume enrollment',
    description: 'Resume a paused enrollment.',
    input: { id: uuid },
    idempotent: true,
    run: (api, a) => api.call('POST', `/sequenceStates/${a.id}/actions/resume`),
  }),
  def({
    name: 'cooks_finish_enrollment',
    title: 'Finish enrollment',
    description: 'Finish an enrollment (idempotent). Open tasks are skipped and no further steps run.',
    input: { id: uuid },
    idempotent: true,
    run: async (api, a) => {
      await api.call('POST', `/sequenceStates/${a.id}/actions/finish`);
      return { finished: a.id };
    },
  }),
  def({
    name: 'cooks_list_tasks',
    title: 'List tasks',
    description: 'List tasks (calls, manual emails, LinkedIn touches). Defaults to open tasks. Use dueBefore to get what is due now.',
    input: {
      ownerId: z.string().optional(),
      prospectId: uuid.optional(),
      sequenceId: uuid.optional(),
      action: z.string().optional(),
      status: z.string().optional().describe('ready | pending | finished | skipped'),
      completed: z.boolean().optional(),
      dueBefore: z.string().datetime().optional(),
      dueAfter: z.string().datetime().optional(),
      includeProspect: z.boolean().optional(),
      ...page,
    },
    readOnly: true,
    run: (api, a) =>
      api.call('GET', '/tasks', {
        query: {
          'filter[owner][id]': a.ownerId,
          'filter[prospect][id]': a.prospectId,
          'filter[sequence][id]': a.sequenceId,
          'filter[action]': a.action,
          'filter[status]': a.status,
          'filter[completed]': a.completed === undefined ? 'false' : String(a.completed),
          'filter[dueAt][lte]': a.dueBefore,
          'filter[dueAt][gte]': a.dueAfter,
          include: a.includeProspect === false ? undefined : 'prospect',
          ...pq(a),
        },
      }),
  }),
  def({
    name: 'cooks_create_task',
    title: 'Create task',
    description: 'Create a one-off task for a rep on a prospect.',
    input: {
      action: z.enum(['call', 'manual_email', 'manual_email_reply', 'basic_task', 'linkedin_connection_request', 'manual_linkedin_connection_request', 'manual_linkedin_message', 'manual_sms']),
      dueAt: z.string().datetime(),
      ownerId: z.string(),
      prospectId: uuid,
      note: z.string().optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    },
    run: (api, a) => api.call('POST', '/tasks', { body: { data: a } }),
  }),
  def({
    name: 'cooks_complete_task',
    title: 'Complete task',
    description: 'Mark a task done. If it belongs to an enrollment, the sequence advances to the next step.',
    input: { id: uuid },
    idempotent: true,
    run: (api, a) => api.call('POST', `/tasks/${a.id}/complete`),
  }),
  def({
    name: 'cooks_skip_task',
    title: 'Skip task',
    description: 'Skip a task. If it belongs to an enrollment, the sequence advances to the next step.',
    input: { id: uuid },
    idempotent: true,
    run: (api, a) => api.call('POST', `/tasks/${a.id}/skip`),
  }),
  def({
    name: 'cooks_list_email_templates',
    title: 'List email templates',
    description: 'List reusable email templates and step-generated ones.',
    input: { ownerId: z.string().optional(), archived: z.boolean().optional(), ...page },
    readOnly: true,
    run: (api, a) => api.call('GET', '/emailTemplates', { query: { 'filter[owner][id]': a.ownerId, 'filter[archived]': a.archived === undefined ? undefined : String(a.archived), ...pq(a) } }),
  }),
  def({
    name: 'cooks_list_tags',
    title: 'List tags',
    description: 'List tags used to organize sequences.',
    input: { name: z.string().optional(), ...page },
    readOnly: true,
    run: (api, a) => api.call('GET', '/tags', { query: { 'filter[name]': a.name, ...pq(a) } }),
  }),
  def({
    name: 'cooks_create_tag',
    title: 'Create tag',
    description: 'Create a tag (idempotent by name).',
    input: { name: z.string().min(1) },
    idempotent: true,
    run: (api, a) => api.call('POST', '/tags', { body: { data: a } }),
  }),
  def({
    name: 'cooks_research_prospect',
    title: 'Research prospect (web)',
    description: 'Run a web-grounded research brief on a prospect and their company (recent news, funding, hiring, leadership, tech) with source links. Uses the workspace AI provider; OpenRouter adds live web search. Waits up to ~60 s for the result.',
    input: { id: uuid, focus: z.string().optional().describe('What you sell or want to learn'), force: z.boolean().optional().describe('Ignore the 7-day cache') },
    run: async (api, a) => {
      const before = await api.call<{ data: { researchedAt?: string } }>('GET', `/prospects/${a.id}/research`);
      const prev = before.data.researchedAt;
      await api.call('POST', `/prospects/${a.id}/actions/research`, { body: { data: { focus: a.focus, force: a.force } } });
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const now = await api.call<{ data: { status: string; researchedAt?: string } }>('GET', `/prospects/${a.id}/research`);
        if (now.data.status === 'ready' && now.data.researchedAt !== prev) return now;
      }
      return { pending: true, hint: 'Still running; call cooks_get_research in a minute.' };
    },
  }),
  def({
    name: 'cooks_get_research',
    title: 'Get research brief',
    description: 'Fetch the latest stored research brief for a prospect.',
    input: { id: uuid },
    readOnly: true,
    run: (api, a) => api.call('GET', `/prospects/${a.id}/research`),
  }),
  def({
    name: 'cooks_add_note',
    title: 'Add CRM note',
    description: 'Write a note on a prospect or account into the connected CRM. Fails with NO_CRM_CONNECTION when no CRM is connected.',
    input: { targetType: z.enum(['prospect', 'account']), targetId: uuid, text: z.string().min(1), integrationType: z.enum(['salesforce', 'hubspot']) },
    run: (api, a) => api.call('POST', `/${a.targetType}s/${a.targetId}/notes`, { body: { data: { text: a.text, integrationType: a.integrationType } } }),
  }),
];
