import { z } from '@hono/zod-openapi';

export const ReferenceObjectSchema = z
  .object({ id: z.string(), _href: z.string() })
  .openapi('ReferenceObject', { description: 'Unexpanded reference to a related resource.' });

export const NullableRef = ReferenceObjectSchema.nullable();

export const PaginationLinksSchema = z
  .object({
    first: z.string(),
    prev: z.string().nullable(),
    next: z.string().nullable(),
  })
  .openapi('PaginationLinks');

export const ErrorBody = z
  .object({
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
    traceId: z.string(),
  })
  .openapi('Error');

export const IdParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });

export const PageParams = {
  'page[size]': z.string().optional().openapi({ description: 'Items per page (1-100, default 50).', example: '50' }),
  'page[after]': z.string().optional().openapi({ description: 'Cursor from links.next.' }),
  'page[before]': z.string().optional().openapi({ description: 'Cursor from links.prev.' }),
};

export const UpdatedAtLt = {
  'filter[updatedAt][gte]': z.string().optional().openapi({ description: 'ISO 8601 lower bound (inclusive).' }),
  'filter[updatedAt][lt]': z.string().optional().openapi({ description: 'ISO 8601 upper bound (exclusive).' }),
};
export const UpdatedAtLte = {
  'filter[updatedAt][gte]': z.string().optional(),
  'filter[updatedAt][lte]': z.string().optional(),
};

export const Timestamps = {
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
};

export const dataOf = <T extends z.ZodTypeAny>(s: T) => z.object({ data: s });
export const listOf = <T extends z.ZodTypeAny>(s: T) => z.object({ data: z.array(s), links: PaginationLinksSchema });

export const Analytics = z
  .object({
    email: z.object({
      delivered: z.number().int(),
      opened: z.number().int(),
      clicked: z.number().int(),
      replied: z.number().int(),
      bounced: z.number().int(),
      unsubscribed: z.number().int(),
    }),
    calls: z.object({ dialed: z.number().int(), connected: z.number().int(), meetings: z.number().int() }),
    linkedIn: z.object({
      connectionRequestsSent: z.number().int(),
      connectionRequestsAccepted: z.number().int(),
      messagesSent: z.number().int(),
      repliesReceived: z.number().int().nullable(),
    }),
  })
  .openapi('Analytics');
export type Analytics = z.infer<typeof Analytics>;

export const jsonBody = <T extends z.ZodTypeAny>(schema: T, description = 'Request body') => ({
  content: { 'application/json': { schema } },
  description,
  required: true,
});
export const jsonResponse = <T extends z.ZodTypeAny>(schema: T, description: string) => ({
  content: { 'application/json': { schema } },
  description,
});
export const errorResponses = {
  400: jsonResponse(ErrorBody, 'Bad request'),
  401: jsonResponse(ErrorBody, 'Unauthorized'),
  403: jsonResponse(ErrorBody, 'Forbidden'),
  404: jsonResponse(ErrorBody, 'Not found'),
  429: jsonResponse(ErrorBody, 'Rate limited'),
};
