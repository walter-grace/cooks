import { z } from '@hono/zod-openapi';
import { Analytics, NullableRef, ReferenceObjectSchema, Timestamps } from './common.js';
import { Tag } from './crm.js';

export const STEP_ACTION_VALUES = [
  'call',
  'manual_email',
  'auto_email',
  'manual_email_reply',
  'auto_email_reply',
  'basic_task',
  'linkedin_connection_request',
  'manual_linkedin_connection_request',
  'manual_linkedin_message',
  'automatic_linkedin_message',
  'manual_sms',
  'auto_sms',
  'manual_whatsapp',
] as const;
export const StepActionEnum = z.enum(STEP_ACTION_VALUES);

/** Actions accepted on POST /sequenceSteps (upstream rejects the two automatic LinkedIn variants). */
export const CREATE_STEP_ACTIONS = [
  'call',
  'manual_email',
  'auto_email',
  'manual_email_reply',
  'auto_email_reply',
  'basic_task',
  'linkedin_connection_request',
  'manual_linkedin_message',
  'manual_sms',
  'auto_sms',
  'manual_whatsapp',
] as const;
export const UPDATE_STEP_ACTIONS = [...CREATE_STEP_ACTIONS, 'manual_linkedin_connection_request'] as const;
export const TASK_CREATE_ACTIONS = [
  'call',
  'manual_email',
  'manual_email_reply',
  'basic_task',
  'linkedin_connection_request',
  'manual_linkedin_connection_request',
  'manual_linkedin_message',
  'manual_sms',
] as const;

export const PrivacyEnum = z.enum(['private', 'team_visible', 'team_editable']);
export const PriorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
export const SequenceStateEnum = z.enum(['active', 'paused', 'finished', 'pending_start']);

export const Sequence = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    type: z.enum(['date', 'interval']),
    enabled: z.boolean(),
    owner: z.unknown(),
    sequenceSteps: z.array(z.unknown()),
    parentSequence: NullableRef,
    parentSequenceStep: NullableRef,
    privacy: PrivacyEnum,
    analytics: Analytics,
    tags: z.array(Tag),
    ...Timestamps,
  })
  .openapi('Sequence');

export const CreateSequenceBody = z.object({
  data: z.object({
    name: z.string().min(1).max(200),
    type: z.enum(['interval', 'date']).default('interval'),
    owner: z.object({ id: z.string() }),
    enabled: z.boolean().default(true),
    privacy: PrivacyEnum.default('team_editable'),
    tags: z.array(z.object({ id: z.string().uuid() })).max(200).optional(),
  }),
});
export const UpdateSequenceBody = z.object({
  data: z
    .object({
      name: z.string().min(1).max(200).optional(),
      enabled: z.boolean().optional(),
      tags: z.array(z.object({ id: z.string().uuid() })).max(200).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});
export const ReorderStepsBody = z.object({ data: z.object({ stepIds: z.array(z.string().uuid()).min(1) }) });

export const SequenceStep = z
  .object({
    id: z.string().uuid(),
    order: z.number().int(),
    name: z.string().nullable(),
    interval: z.number().int().nullable(),
    action: StepActionEnum,
    note: z.string().nullable(),
    sequence: ReferenceObjectSchema,
    template: z.unknown(),
    hasAbVariants: z.boolean(),
    analytics: Analytics,
    ...Timestamps,
  })
  .openapi('SequenceStep');

const AiEmail = z
  .object({ agent: z.object({ id: z.string().uuid() }).optional(), promptOverride: z.string().max(4000).optional() })
  .refine((v) => !!v.agent || !!v.promptOverride, { message: 'aiEmail needs agent.id or promptOverride' });

export const CreateStepBody = z.object({
  data: z.object({
    sequence: z.object({ id: z.string().uuid() }),
    action: z.enum(CREATE_STEP_ACTIONS),
    interval: z.number().int().min(0).max(60 * 24 * 365),
    order: z.number().int().min(1).optional(),
    name: z.string().max(100).nullable().optional(),
    note: z.string().max(5000).nullable().optional(),
    emailSubject: z.string().max(998).optional(),
    emailBody: z.string().max(200_000).optional(),
    aiEmail: AiEmail.optional(),
  }),
});
export const UpdateStepBody = z.object({
  data: z
    .object({
      action: z.enum(UPDATE_STEP_ACTIONS).optional(),
      interval: z.number().int().min(0).max(60 * 24 * 365).optional(),
      name: z.string().max(100).nullable().optional(),
      note: z.string().max(5000).nullable().optional(),
      emailSubject: z.string().max(998).optional(),
      emailBody: z.string().max(200_000).optional(),
      aiEmail: AiEmail.nullable().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});

export const EmailTemplate = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    subject: z.string().nullable(),
    htmlBody: z.string().nullable(),
    source: z.string(),
    archived: z.boolean(),
    order: z.number().int(),
    owner: NullableRef,
    privacy: PrivacyEnum,
    ...Timestamps,
  })
  .openapi('EmailTemplate');

export const SequenceState = z
  .object({
    id: z.string().uuid(),
    state: SequenceStateEnum,
    sequence: z.unknown(),
    prospect: z.unknown(),
    account: NullableRef,
    creator: z.unknown(),
    owner: ReferenceObjectSchema,
    sequenceStep: z.unknown(),
    ...Timestamps,
  })
  .openapi('SequenceState');

export const EmailOverridesSchema = z.record(
  z.string().uuid(),
  z.object({ subject: z.string().max(998).optional(), body: z.string().max(200_000).optional() }),
);

export const CreateSequenceStateBody = z.object({
  data: z.object({
    prospect: z.object({ id: z.string().uuid() }),
    sequence: z.object({ id: z.string().uuid() }),
    owner: z.object({ id: z.string() }),
    state: z.enum(['active', 'paused']).default('active'),
    mailbox: z.object({ id: z.string().uuid() }).optional(),
    scheduledAt: z.string().datetime().optional(),
    sequenceStep: z.object({ id: z.string().uuid() }).optional(),
    emailOverrides: EmailOverridesSchema.optional(),
    enrich: z.object({ phoneNumbers: z.boolean().optional(), emails: z.boolean().optional() }).optional(),
  }),
});
export const UpdateSequenceStateBody = z.object({ data: z.object({ emailOverrides: EmailOverridesSchema }) });

export const Task = z
  .object({
    id: z.string().uuid(),
    action: StepActionEnum,
    completed: z.boolean(),
    dueAt: z.string().datetime(),
    note: z.string().nullable(),
    status: z.string().nullable(),
    priority: PriorityEnum,
    owner: ReferenceObjectSchema,
    prospect: z.unknown(),
    sequence: NullableRef,
    sequenceState: NullableRef,
    sequenceStep: NullableRef,
    ...Timestamps,
  })
  .openapi('Task');

export const CreateTaskBody = z.object({
  data: z.object({
    action: z.enum(TASK_CREATE_ACTIONS),
    dueAt: z.string().datetime(),
    ownerId: z.string(),
    prospectId: z.string().uuid(),
    note: z.string().max(5000).optional(),
    priority: PriorityEnum.default('normal'),
  }),
});
export const UpdateTaskBody = z.object({
  data: z
    .object({
      dueAt: z.string().datetime().optional(),
      ownerId: z.string().optional(),
      priority: PriorityEnum.optional(),
      note: z.string().max(5000).nullable().optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'Provide at least one field to update' }),
});
