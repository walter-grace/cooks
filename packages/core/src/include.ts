import { badRequest } from './errors.js';

export const MAX_INCLUDES = 3;

export function parseInclude(raw: unknown, allowed: readonly string[]): string[] {
  if (raw === undefined || raw === '') return [];
  const items = String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const unique = [...new Set(items)];
  if (unique.length > MAX_INCLUDES) throw badRequest(`include accepts at most ${MAX_INCLUDES} values`);
  for (const i of unique) {
    if (!allowed.includes(i)) throw badRequest(`Unknown include "${i}". Allowed: ${allowed.join(', ') || 'none'}`);
  }
  return unique;
}

export interface ReferenceObject {
  id: string;
  _href: string;
}

export function ref(collection: string, id: string): ReferenceObject {
  return { id, _href: `/v1/${collection}/${id}` };
}

export function refOrNull(collection: string, id: string | null | undefined): ReferenceObject | null {
  return id ? ref(collection, id) : null;
}
