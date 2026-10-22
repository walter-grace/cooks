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
    name: 'cooks_list_emails',
    title: 'List emails',
    description: 'List emails (drafts, queued, sent, received) for the workspace or one prospect. Each item carries direction, status, Message-ID, thread id and open/click/reply timestamps.',
    readOnly: true,
    input: {
      prospectId: uuid.optional(),
      status: z.enum(['draft', 'queued', 'sending', 'sent', 'failed', 'rejected', 'received']).optional(),
      include: z.string().optional().describe('Comma list of prospect, task, sequence, sequenceStep (max 3)'),
      ...page,
      ...updatedAt,
    },
    run: (api, a) => api.call('GET', '/emails', { query: { 'filter[prospect][id]': a.prospectId, 'filter[status]': a.status, include: a.include, ...pq(a) } }),
  }),
  def({
    name: 'cooks_create_email',
    title: 'Create email',
    description: 'Create a one-off email to a prospect. By default this is a draft plus a manual_email task for the owner to review; set send=true to queue it through the owner mailbox right away. Subject and body accept Liquid merge fields like {{ prospect.firstName }}.',
    input: {
      prospectId: uuid,
      ownerId: z.string().describe('User id of the sender; see cooks_me / cooks_list_users'),
      subject: z.string().min(1).max(998),
      bodyHtml: z.string().min(1),
      recipients: z.array(z.string().email()).max(10).optional().describe('Defaults to the prospect email'),
      cc: z.array(z.string().email()).max(10).optional(),
      bcc: z.array(z.string().email()).max(10).optional(),
      send: z.boolean().optional().describe('true queues the email for sending; default false leaves a draft'),
    },
    run: (api, a) => api.call('POST', '/emails', { body: { data: a } }),
  }),
  def({
    name: 'cooks_import_email',
    title: 'Import outside email',
    description:
      'Record an email that was sent or received outside Cooks (the rep\'s own mail client, a CRM activity, another tool). direction=outbound stores it as sent and links it to the prospect\'s active enrollment; pass messageId so a later reply can be matched by thread. direction=inbound runs the normal reply pipeline: reply vs out-of-office, finish or pause the enrollment per workspace policy, create a reply task, count in reply stats. Idempotent on messageId / externalId.',
    idempotent: true,
    input: {
      prospectId: uuid,
      direction: z.enum(['inbound', 'outbound']),
      subject: z.string().max(998).optional(),
      bodyText: z.string().optional(),
      bodyHtml: z.string().optional(),
      messageId: z.string().optional().describe('RFC 5322 Message-ID from the provider; with or without angle brackets'),
      threadId: z.string().optional().describe('Gmail threadId or Graph conversationId'),
      inReplyTo: z.string().optional().describe('Message-ID this message answers (inbound replies)'),
      externalId: z.string().optional().describe('Provider-side id to dedupe repeated imports'),
      sentAt: z.string().optional().describe('ISO 8601; defaults to now'),
      provider: z.enum(['gmail', 'outlook', 'smtp', 'other']).optional(),
      from: z.string().email().optional(),
      to: z.string().email().optional(),
      ownerId: z.string().optional(),
      mailboxId: z.string().optional(),
      autoSubmitted: z.boolean().optional().describe('Force out-of-office handling for an inbound message'),
    },
    run: (api, a) => api.call('POST', '/emails/import', { body: { data: a } }),
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
    name: 'cooks_crm_status',
    title: 'CRM connection status',
    description: 'Whether a CRM (HubSpot) is connected, how owners map, and which auto-enroll rules exist.',
    input: {},
    readOnly: true,
    run: (api) => api.call('GET', '/workspace/crm'),
  }),
  def({
    name: 'cooks_sync_hubspot_contacts',
    title: 'Sync HubSpot contacts',
    description: 'Pull contacts (and their companies) from the connected HubSpot into Cooks by HubSpot contact id or by email. Returns created/updated prospect ids and per-record errors.',
    input: { ids: z.array(z.string()).optional().describe('HubSpot contact ids'), emails: z.array(z.string().email()).optional() },
    run: async (api, a) => {
      if (a.emails?.length) return api.call('POST', '/integrations/hubspot/import', { body: { data: { emails: a.emails } } });
      if (a.ids?.length) return api.call('POST', '/integrations/prospects/sync', { body: { data: { type: 'hubspot', records: a.ids } } });
      return { error: { code: 'BAD_REQUEST', message: 'Provide ids or emails' } };
    },
  }),
  def({
    name: 'cooks_add_note',
    title: 'Add CRM note',
    description: 'Write a note on a prospect or account into the connected CRM. Fails with NO_CRM_CONNECTION when no CRM is connected.',
    input: { targetType: z.enum(['prospect', 'account']), targetId: uuid, text: z.string().min(1), integrationType: z.enum(['salesforce', 'hubspot']) },
    run: (api, a) => api.call('POST', `/${a.targetType}s/${a.targetId}/notes`, { body: { data: { text: a.text, integrationType: a.integrationType } } }),
  }),
  // ---- Signals ----
  def({
    name: 'cooks_list_signals',
    title: 'List buying signals',
    description: 'Feed of buying signals (web research, email engagement, CRM stage changes, anything pushed in). Filter by kind (exact or prefix like research.*), status (new|acted|dismissed|all), prospect or account.',
    input: { kind: z.string().optional(), status: z.enum(['new', 'acted', 'dismissed', 'all']).optional(), prospectId: uuid.optional(), accountId: uuid.optional(), since: z.string().optional().describe('ISO date: only signals that occurred at or after'), ...page },
    readOnly: true,
    run: (api, a) => api.call('GET', '/signals', { query: { 'filter[kind]': a.kind, 'filter[status]': a.status, 'filter[prospect][id]': a.prospectId, 'filter[account][id]': a.accountId, 'filter[occurredAt][gte]': a.since, include: 'prospect,account', ...pq(a) } }),
  }),
  def({
    name: 'cooks_signal_summary',
    title: 'Signal summary',
    description: 'Counts of signals by kind for the last N days plus the catalog of known kinds.',
    input: { days: z.number().int().min(1).max(90).optional() },
    readOnly: true,
    run: (api, a) => api.call('GET', '/signals/summary', { query: { days: a.days } }),
  }),
  def({
    name: 'cooks_push_signal',
    title: 'Record a buying signal',
    description: 'Record something you observed (job change, funding, website visit, intent topic, news). kind is category.type, e.g. research.funding, web.visit, custom.event. Attach to a prospect (id or email) or account (id or domain). Use dedupeKey so repeated pushes are idempotent. Signal rules run immediately.',
    input: { kind: z.string(), title: z.string().optional(), url: z.string().optional(), score: z.number().min(0).max(1).optional(), occurredAt: z.string().optional(), dedupeKey: z.string().optional(), prospectId: uuid.optional(), prospectEmail: z.string().optional(), accountId: uuid.optional(), accountDomain: z.string().optional(), payload: z.record(z.string(), z.unknown()).optional() },
    idempotent: true,
    run: (api, a) => api.call('POST', '/signals', { body: { data: { kind: a.kind, title: a.title, url: a.url, score: a.score, occurredAt: a.occurredAt, dedupeKey: a.dedupeKey, payload: a.payload, source: 'mcp', prospect: a.prospectId || a.prospectEmail ? { id: a.prospectId, email: a.prospectEmail } : undefined, account: a.accountId || a.accountDomain ? { id: a.accountId, domain: a.accountDomain } : undefined } } }),
  }),
  def({
    name: 'cooks_act_on_signal',
    title: 'Act on a signal',
    description: 'Enroll the signal\'s prospect into a sequence, create a task for a rep, or dismiss the signal.',
    input: { id: uuid, action: z.enum(['enroll', 'task', 'dismiss']), sequenceId: uuid.optional(), ownerId: z.string().optional(), taskAction: z.string().optional(), note: z.string().optional() },
    run: (api, a) => (a.action === 'dismiss' ? api.call('POST', `/signals/${a.id}/actions/dismiss`) : api.call('POST', `/signals/${a.id}/actions/act`, { body: { data: a.action === 'enroll' ? { action: 'enroll', sequenceId: a.sequenceId, ownerId: a.ownerId } : { action: 'task', ownerId: a.ownerId, taskAction: a.taskAction, note: a.note } } })),
  }),
  def({
    name: 'cooks_list_signal_rules',
    title: 'List signal rules',
    description: 'Rules that turn matching signals into enrollments or tasks automatically.',
    input: {},
    readOnly: true,
    run: (api) => api.call('GET', '/workspace/signalRules'),
  }),
  def({
    name: 'cooks_create_signal_rule',
    title: 'Create a signal rule',
    description: 'When a signal matches kindPattern (exact, prefix like research.*, or *) and meets minScore, enroll the prospect in sequenceId or create a task for ownerId. Admins only.',
    input: { name: z.string().optional(), kindPattern: z.string(), minScore: z.number().min(0).max(1).optional(), action: z.enum(['enroll', 'task']), sequenceId: uuid.optional(), ownerId: z.string(), taskAction: z.string().optional(), taskNote: z.string().optional() },
    run: (api, a) => api.call('POST', '/workspace/signalRules', { body: { data: a } }),
  }),
  def({
    name: 'cooks_scan_account',
    title: 'Scan an account for signals (web)',
    description: 'Web-grounded scan of a company for funding, hiring, leadership changes, launches and expansion. New findings land in the signals feed with sources. Waits up to ~60 s.',
    input: { accountId: uuid, focus: z.string().optional(), force: z.boolean().optional() },
    run: async (api, a) => {
      const before = await api.call<{ data: unknown[] }>('GET', '/signals', { query: { 'filter[account][id]': a.accountId, 'filter[status]': 'all', 'page[size]': 100 } });
      await api.call('POST', `/accounts/${a.accountId}/actions/scan`, { body: { data: { focus: a.focus, force: a.force } } });
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const now = await api.call<{ data: unknown[] }>('GET', '/signals', { query: { 'filter[account][id]': a.accountId, 'filter[status]': 'all', 'page[size]': 100 } });
        if (now.data.length !== before.data.length) return { newSignals: now.data.length - before.data.length, signals: now.data.slice(0, 20) };
      }
      return { pending: true, hint: 'Scan still running (or found nothing new); call cooks_list_signals with the accountId in a minute.' };
    },
  }),
  // ---- Dialer ----
  def({
    name: 'cooks_dialer_status',
    title: 'Dialer status',
    description: 'Which dialers are connected (Twilio for rep calls, Speko for AI-voiced calls), which one the Call button uses, caller ids, and the AI call defaults (script, max duration, daily spend cap).',
    readOnly: true,
    input: {},
    run: (api) => api.call('GET', '/workspace/dialer'),
  }),
  def({
    name: 'cooks_place_ai_call',
    title: 'Place AI call',
    description:
      'Place an AI-voiced outbound call through Speko to a prospect (or a number). A success means the call is QUEUED, not answered: poll cooks_get_call_transcript until status is completed, no_answer or failed. The worker stores outcome, transcript, summary, cost and recording, logs the disposition (closing a linked call task) and queues coaching. Refused when the prospect is on the do-not-call list, outside 08:00–21:00 in their time zone, over the daily spend cap, or when Speko reports INSUFFICIENT_CREDITS. systemPrompt and firstMessage accept {{ prospect.firstName }}, {{ account.name }}, {{ owner.name }}, {{ workspace.name }}.',
    input: {
      prospectId: uuid.optional(),
      to: z.string().optional().describe('E.164 number when no prospect is given'),
      taskId: uuid.optional().describe('Sequence call task to complete when the call is logged'),
      systemPrompt: z.string().max(8000).optional().describe('What the agent should accomplish; defaults to the workspace script'),
      firstMessage: z.string().max(1000).optional(),
      maxDurationSeconds: z.number().int().min(30).max(600).optional().describe('Hard cap, default from settings (120)'),
      fromNumber: z.string().optional(),
      onMachine: z.enum(['hangup', 'leave_message', 'agent_decides']).optional(),
      voicemailMessage: z.string().max(1000).optional(),
    },
    run: (api, a) => api.call('POST', '/calls/actions/aiCall', { body: { data: a } }),
  }),
  def({
    name: 'cooks_get_call_transcript',
    title: 'Call transcript',
    description: 'Status, outcome (answered, voicemail, no_answer, failed), summary, cost and the speaker-labelled transcript of a call. Works for AI calls and transcribed Twilio recordings.',
    readOnly: true,
    input: { callId: uuid },
    run: (api, a) => api.call('GET', `/calls/${a.callId}/transcript`),
  }),
  def({
    name: 'cooks_hangup_call',
    title: 'Hang up AI call',
    description: 'End a running AI call now. The final outcome and transcript are written a few seconds later.',
    input: { callId: uuid },
    run: (api, a) => api.call('POST', `/calls/${a.callId}/actions/hangup`),
  }),
  def({
    name: 'cooks_dialer_balance',
    title: 'Dialer balance',
    description: 'Speko prepaid balance in USD, what AI calls have spent today, calls in flight and the daily spend cap.',
    readOnly: true,
    input: {},
    run: (api) => api.call('GET', '/workspace/telephony/speko/balance'),
  }),
  def({
    name: 'cooks_dial',
    title: 'Call a prospect (bridge)',
    description: 'Place a call: Twilio rings the rep\'s phone (repPhone or the owner\'s profile phone) and connects the prospect when they answer. Pass taskId for a sequence call step so logging the call completes the task. Returns the call id to log afterwards.',
    input: { prospectId: uuid.optional(), to: z.string().optional().describe('Phone number when calling someone who is not a prospect'), repPhone: z.string().optional(), fromNumber: z.string().optional(), ownerId: z.string().optional(), taskId: uuid.optional() },
    run: (api, a) => api.call('POST', '/calls/actions/dial', { body: { data: { ...a, mode: 'bridge' } } }),
  }),
  def({
    name: 'cooks_list_calls',
    title: 'List calls',
    description: 'Calls with status, duration, disposition and whether they are logged. Filter by prospect, owner, logged, status or time window.',
    input: { prospectId: uuid.optional(), ownerId: z.string().optional(), logged: z.boolean().optional(), status: z.string().optional(), since: z.string().optional(), ...page },
    readOnly: true,
    run: (api, a) => api.call('GET', '/calls', { query: { 'filter[prospect][id]': a.prospectId, 'filter[owner][id]': a.ownerId, 'filter[logged]': a.logged === undefined ? undefined : String(a.logged), 'filter[status]': a.status, 'filter[time][gte]': a.since, include: 'prospect,callDisposition,owner', ...pq(a) } }),
  }),
  def({
    name: 'cooks_log_call',
    title: 'Log a call',
    description: 'Attach a disposition (outcome such as connected, meeting_booked, left_voicemail, no_answer, wrong_number, do_not_call) and notes to a dialer call. Fires the call.logged webhook, closes the linked task and writes to HubSpot when connected.',
    input: { callId: uuid, outcome: z.enum(['connected', 'not_connected', 'meeting_booked', 'left_voicemail', 'no_answer', 'busy', 'wrong_number', 'do_not_call', 'other']).optional(), dispositionName: z.string().optional(), notes: z.string().optional(), durationSeconds: z.number().int().optional() },
    run: (api, a) => api.call('POST', `/calls/${a.callId}/actions/log`, { body: { data: { outcome: a.outcome, dispositionName: a.dispositionName, notes: a.notes, durationSeconds: a.durationSeconds } } }),
  }),
  def({
    name: 'cooks_record_call',
    title: 'Record a call made elsewhere',
    description: 'Log a call that did not go through the dialer (rep\'s own phone, another tool): prospect, duration, outcome, notes. Completes a linked call task when taskId is given.',
    input: { prospectId: uuid, outcome: z.enum(['connected', 'not_connected', 'meeting_booked', 'left_voicemail', 'no_answer', 'busy', 'wrong_number', 'do_not_call', 'other']), notes: z.string().optional(), durationSeconds: z.number().int().optional(), direction: z.enum(['inbound', 'outbound']).optional(), time: z.string().optional(), ownerId: z.string().optional(), taskId: uuid.optional() },
    run: (api, a) => api.call('POST', '/calls', { body: { data: a } }),
  }),
  def({
    name: 'cooks_list_call_dispositions',
    title: 'List call dispositions',
    description: 'Disposition names and outcomes available in this workspace.',
    input: {},
    readOnly: true,
    run: (api) => api.call('GET', '/callDispositions', { query: { 'page[size]': 100 } }),
  }),
  // ---- Coaching ----
  def({
    name: 'cooks_call_insights',
    title: 'Call transcript and coaching',
    description: 'Speaker-labelled transcript, talk statistics (talk ratio, questions, monologues, interruptions) and the AI scorecard for a recorded call.',
    input: { callId: uuid },
    readOnly: true,
    run: (api, a) => api.call('GET', `/calls/${a.callId}/insights`),
  }),
  def({
    name: 'cooks_coach_call',
    title: 'Run coaching on a call',
    description: 'Transcribe (if needed) and score a recorded call with the workspace AI provider. Waits up to ~90 s for the result.',
    input: { callId: uuid },
    run: async (api, a) => {
      await api.call('POST', `/calls/${a.callId}/actions/coach`);
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const now = await api.call<{ data: { coachingStatus: string; transcriptStatus: string } }>('GET', `/calls/${a.callId}/insights`);
        if (['ready', 'failed', 'skipped'].includes(now.data.coachingStatus) && now.data.transcriptStatus !== 'running' && now.data.transcriptStatus !== 'queued') return now;
      }
      return { pending: true, hint: 'Still processing; call cooks_call_insights in a minute.' };
    },
  }),
];
