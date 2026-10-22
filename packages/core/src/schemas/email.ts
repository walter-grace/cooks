import { z } from '@hono/zod-openapi';
import { NullableRef, ReferenceObjectSchema, Timestamps } from './common.js';

export const Email = z
  .object({
    id: z.string().uuid(),
    type: z.string().nullable(),
    status: z.string().nullable(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    recipients: z.array(z.string()),
    subject: z.string().nullable(),
    bodyText: z.string().nullable(),
    bodyHtml: z.string().nullable(),
    prospect: z.unknown(),
    task: z.unknown(),
    sequence: z.unknown(),
    sequenceStep: z.unknown(),
    date: z.string().datetime().nullable(),
    deliveredAt: z.string().datetime().nullable(),
    openedAt: z.string().datetime().nullable(),
    clickedAt: z.string().datetime().nullable(),
    bouncedAt: z.string().datetime().nullable(),
    repliedAt: z.string().datetime().nullable(),
    openCount: z.number().int().nullable(),
    clickCount: z.number().int().nullable(),
    ...Timestamps,
  })
  .openapi('Email');

export const CreateEmailBody = z.object({
  data: z.object({
    prospectId: z.string().uuid(),
    ownerId: z.string(),
    subject: z.string().min(1).max(998),
    bodyHtml: z.string().min(1).max(500_000),
    from: z.string().email().optional(),
    recipients: z.array(z.string().email()).max(10).optional(),
    cc: z.array(z.string().email()).max(10).optional(),
    bcc: z.array(z.string().email()).max(10).optional(),
    send: z.boolean().default(false),
  }),
});

export const Mailbox = z
  .object({ id: z.string().uuid(), email: z.string(), isDefault: z.boolean(), user: z.unknown(), ...Timestamps })
  .openapi('Mailbox');

export const CreateMailboxBody = z.object({
  data: z.object({
    email: z.string().email(),
    userId: z.string().optional().describe('Defaults to the caller for OAuth principals'),
    isDefault: z.boolean().optional(),
    dailySendLimit: z.number().int().min(1).max(2000).optional(),
    minGapSeconds: z.number().int().min(0).max(3600).optional(),
    smtpUrl: z.string().optional().describe('smtp://user:pass@host:port; omit to use the server default relay'),
    imapUrl: z.string().optional().describe('imaps://user:pass@host:993 to read replies and bounces'),
    signatureHtml: z.string().max(20_000).optional(),
  }),
});

export const Call = z
  .object({
    id: z.string().uuid(),
    source: z.string(),
    duration: z.number(),
    from: z.string().nullable(),
    to: z.string().nullable(),
    direction: z.string().nullable(),
    recordingUrl: z.string().nullable(),
    time: z.string().datetime(),
    prospect: z.unknown(),
    sequence: z.unknown(),
    sequenceStep: z.unknown(),
    callDisposition: z.unknown(),
    owner: z.unknown(),
    ...Timestamps,
    status: z.string().optional().describe('Cooks: initiated, ringing_rep, ringing, in_progress, completed, busy, no_answer, failed, canceled, rep_*'),
    notes: z.string().nullable().optional(),
    loggedAt: z.string().nullable().optional(),
    endedAt: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    account: z.unknown().optional(),
    taskId: z.string().nullable().optional(),
    recordingDurationSeconds: z.number().nullable().optional(),
    transcriptStatus: z.string().optional(),
    coachingStatus: z.string().optional(),
    amdResult: z.string().nullable().optional(),
  })
  .openapi('Call');

export const CallDisposition = z
  .object({ id: z.string().uuid(), name: z.string(), callOutcome: z.string(), order: z.number().int().nullable(), ...Timestamps })
  .openapi('CallDisposition');

export { NullableRef, ReferenceObjectSchema };
