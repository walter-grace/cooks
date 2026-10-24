import { z } from '@hono/zod-openapi';
import { NullableRef, ReferenceObjectSchema, Timestamps } from './common.js';

export const User = z
  .object({ id: z.string(), name: z.string(), email: z.string(), crmId: z.string().nullable(), ...Timestamps })
  .openapi('User');

export const Account = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    domain: z.string().nullable(),
    numEmployees: z.number().int().nullable(),
    linkedInUrl: z.string().nullable(),
    description: z.string().nullable(),
    crmCustomFields: z.record(z.string(), z.unknown()),
    ...Timestamps,
  })
  .openapi('Account');

export const Prospect = z
  .object({
    id: z.string().uuid(),
    name: z.string().nullable(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    title: z.string().nullable(),
    primaryEmail: z.string().nullable(),
    linkedInUrl: z.string().nullable(),
    phone: z.string().nullable().optional().describe('Cooks extension: dial target'),
    timezone: z.string().nullable().optional().describe('Cooks extension: IANA zone used for send windows and quiet hours'),
    city: z.string().nullable().optional().describe('Cooks extension'),
    state: z.string().nullable().optional().describe('Cooks extension'),
    country: z.string().nullable().optional().describe('Cooks extension'),
    crmId: z.string().nullable(),
    account: NullableRef,
    sequenceStates: z.array(z.unknown()),
    crmCustomFields: z.record(z.string(), z.unknown()),
    ...Timestamps,
  })
  .openapi('Prospect');

/** Cooks extension: prospects are writable through the API. */
export const CreateProspectBody = z.object({
  data: z.object({
    firstName: z.string().max(200).nullable().optional(),
    lastName: z.string().max(200).nullable().optional(),
    name: z.string().max(400).nullable().optional(),
    title: z.string().max(200).nullable().optional(),
    primaryEmail: z.string().email().nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    linkedInUrl: z.string().url().nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    crmId: z.string().max(200).nullable().optional(),
    account: z.object({ id: z.string().uuid() }).nullable().optional(),
    crmCustomFields: z.record(z.string(), z.unknown()).optional(),
    ownerId: z.string().nullable().optional(),
  }),
});
export const UpdateProspectBody = CreateProspectBody;

export const CreateAccountBody = z.object({
  data: z.object({
    name: z.string().max(400).nullable().optional(),
    domain: z.string().max(255).nullable().optional(),
    numEmployees: z.number().int().nullable().optional(),
    linkedInUrl: z.string().url().nullable().optional(),
    description: z.string().max(5000).nullable().optional(),
    crmId: z.string().max(200).nullable().optional(),
    timezone: z.string().max(64).nullable().optional(),
    crmCustomFields: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const Tag = z.object({ id: z.string().uuid(), name: z.string(), ...Timestamps }).openapi('Tag');
export const CreateTagBody = z.object({ data: z.object({ name: z.string().min(1).max(100) }) });

export const CrmIntegrationType = z.enum(['salesforce', 'hubspot']).openapi('CrmNoteIntegrationType');
export const CreateNoteBody = z
  .object({ data: z.object({ text: z.string().min(1).max(65535), integrationType: CrmIntegrationType }) })
  .openapi('CreateNoteRequest');
export const Note = z
  .object({
    id: z.string().uuid(),
    externalId: z.string(),
    text: z.string(),
    associatedType: z.enum(['prospect', 'account']),
    associated: ReferenceObjectSchema,
    integrationType: z.string(),
    userExternalId: z.string().nullable(),
    userName: z.string().nullable(),
    externalCreatedAt: z.string().datetime(),
    externalUpdatedAt: z.string().datetime(),
    ...Timestamps,
  })
  .openapi('Note');

export const SyncProspectsBody = z
  .object({ data: z.object({ type: z.enum(['salesforce', 'hubspot']), records: z.array(z.string()).min(1).max(100) }) })
  .openapi('SyncProspectsRequest');
export const SyncProspectsResponse = z
  .object({
    results: z.array(z.object({ externalId: z.string(), prospectId: z.string().uuid(), created: z.boolean() })),
    errors: z.array(z.object({ externalId: z.string(), code: z.enum(['NOT_FOUND_IN_CRM', 'MAPPING_FAILED']), message: z.string() })),
  })
  .openapi('SyncProspectsResponse');

export const Me = z
  .object({
    workspaceId: z.string(),
    userId: z.string().nullable(),
    email: z.string().nullable(),
    name: z.string().nullable(),
    authType: z.enum(['oauth', 'apiKey']),
    clientId: z.string().nullable(),
    scopes: z.array(z.string()),
  })
  .openapi('Me');
