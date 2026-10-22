import { badRequest } from './errors.js';

/**
 * Turn `filter[updatedAt][gte]=x&filter[sequence][id]=y&include=a,b` into
 * `{ filter: { updatedAt: { gte: 'x' }, sequence: { id: 'y' } }, include: 'a,b' }`.
 */
export function nestBracketQuery(raw: Record<string, string | string[] | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const parts = key.split(/\[|\]\[|\]/).filter((p) => p !== '');
    let node = out;
    parts.forEach((part, idx) => {
      if (idx === parts.length - 1) {
        node[part] = Array.isArray(value) ? value[value.length - 1] : value;
      } else {
        const next = node[part];
        if (typeof next !== 'object' || next === null || Array.isArray(next)) node[part] = {};
        node = node[part] as Record<string, unknown>;
      }
    });
  }
  return out;
}

export function parseBool(v: unknown, name: string): boolean | undefined {
  if (v === undefined || v === '') return undefined;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  throw badRequest(`${name} must be true or false`);
}

export function parseDate(v: unknown, name: string): Date | undefined {
  if (v === undefined || v === '') return undefined;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw badRequest(`${name} must be an ISO 8601 date-time`);
  return d;
}

export function parseCsv(v: unknown): string[] | undefined {
  if (v === undefined || v === '') return undefined;
  return String(v)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseEnum<T extends string>(v: unknown, allowed: readonly T[], name: string): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (!allowed.includes(v as T)) throw badRequest(`${name} must be one of: ${allowed.join(', ')}`);
  return v as T;
}
