import { and, asc, desc, gt, lt, or, eq, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { badRequest } from './errors.js';

export interface PageArgs {
  size: number;
  after?: string;
  before?: string;
}

export interface Cursor {
  t: string; // ISO created_at
  i: string; // id
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

export function decodeCursor(raw: string, param: string): Cursor {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof parsed.t !== 'string' || typeof parsed.i !== 'string' || Number.isNaN(Date.parse(parsed.t))) throw new Error();
    return { t: parsed.t, i: parsed.i };
  } catch {
    throw badRequest(`Invalid ${param} cursor`);
  }
}

export function pageArgs(q: Record<string, unknown>): PageArgs {
  const sizeRaw = q['page[size]'];
  let size = DEFAULT_PAGE_SIZE;
  if (sizeRaw !== undefined && sizeRaw !== '') {
    const n = Number(sizeRaw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) throw badRequest(`page[size] must be an integer between 1 and ${MAX_PAGE_SIZE}`);
    size = n;
  }
  const after = typeof q['page[after]'] === 'string' && q['page[after]'] ? (q['page[after]'] as string) : undefined;
  const before = typeof q['page[before]'] === 'string' && q['page[before]'] ? (q['page[before]'] as string) : undefined;
  if (after && before) throw badRequest('page[after] and page[before] cannot be combined');
  return { size, after, before };
}

/**
 * Keyset condition + ordering for (created_at DESC, id DESC). Pass the result into
 * `.where(and(base, keyset.where))`, `.orderBy(...keyset.orderBy)`, `.limit(size + 1)`.
 */
export function keyset(createdAt: PgColumn, id: PgColumn, page: PageArgs): { where: SQL | undefined; orderBy: SQL[]; reversed: boolean } {
  if (page.after) {
    const c = decodeCursor(page.after, 'page[after]');
    const t = new Date(c.t);
    return {
      where: or(lt(createdAt, t), and(eq(createdAt, t), lt(id, c.i))),
      orderBy: [desc(createdAt), desc(id)],
      reversed: false,
    };
  }
  if (page.before) {
    const c = decodeCursor(page.before, 'page[before]');
    const t = new Date(c.t);
    return {
      where: or(gt(createdAt, t), and(eq(createdAt, t), gt(id, c.i))),
      orderBy: [asc(createdAt), asc(id)],
      reversed: true,
    };
  }
  return { where: undefined, orderBy: [desc(createdAt), desc(id)], reversed: false };
}

export interface PaginationLinks {
  first: string;
  prev: string | null;
  next: string | null;
}

/** Trim `size + 1` rows into a page and compute links from the request URL. */
export function buildPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  page: PageArgs,
  reversed: boolean,
  requestUrl: string,
): { data: T[]; links: PaginationLinks } {
  const hasMore = rows.length > page.size;
  let data = hasMore ? rows.slice(0, page.size) : rows;
  if (reversed) data = [...data].reverse();

  const url = new URL(requestUrl);
  const strip = (u: URL) => {
    u.searchParams.delete('page[after]');
    u.searchParams.delete('page[before]');
    return u;
  };
  const first = strip(new URL(url)).pathname + (strip(new URL(url)).search || '');
  const withParam = (k: string, v: string) => {
    const u = strip(new URL(url));
    u.searchParams.set(k, v);
    return u.pathname + u.search;
  };
  const firstRow = data[0];
  const lastRow = data[data.length - 1];
  let next: string | null = null;
  let prev: string | null = null;
  if (reversed) {
    // paging backwards: there is always a "next" (the page we came from); prev exists if hasMore
    if (lastRow) next = withParam('page[after]', encodeCursor({ t: lastRow.createdAt.toISOString(), i: lastRow.id }));
    if (hasMore && firstRow) prev = withParam('page[before]', encodeCursor({ t: firstRow.createdAt.toISOString(), i: firstRow.id }));
  } else {
    if (hasMore && lastRow) next = withParam('page[after]', encodeCursor({ t: lastRow.createdAt.toISOString(), i: lastRow.id }));
    if (page.after && firstRow) prev = withParam('page[before]', encodeCursor({ t: firstRow.createdAt.toISOString(), i: firstRow.id }));
  }
  return { data, links: { first, prev, next } };
}
