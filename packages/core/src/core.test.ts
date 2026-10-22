import { describe, expect, it } from 'vitest';
import { buildPage, decodeCursor, encodeCursor, pageArgs } from './pagination.js';
import { nestBracketQuery, parseBool } from './query.js';
import { parseInclude, ref } from './include.js';
import { decrypt, encrypt } from './crypto.js';
import { CooksError } from './errors.js';

describe('pagination', () => {
  it('round-trips cursors and rejects garbage', () => {
    const c = { t: '2026-01-01T00:00:00.000Z', i: 'abc' };
    expect(decodeCursor(encodeCursor(c), 'page[after]')).toEqual(c);
    expect(() => decodeCursor('nope', 'page[after]')).toThrow(CooksError);
  });
  it('validates page[size]', () => {
    expect(pageArgs({}).size).toBe(50);
    expect(pageArgs({ 'page[size]': '100' }).size).toBe(100);
    expect(() => pageArgs({ 'page[size]': '101' })).toThrow(/between 1 and 100/);
    expect(() => pageArgs({ 'page[after]': 'a', 'page[before]': 'b' })).toThrow(/cannot be combined/);
  });
  it('builds links from size+1 rows', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `id${3 - i}`, createdAt: new Date(2026, 0, 3 - i) }));
    const page = buildPage(rows, { size: 2 }, false, 'http://x/v1/tags?page[size]=2&filter[name]=a');
    expect(page.data).toHaveLength(2);
    expect(page.links.first).toBe('/v1/tags?page%5Bsize%5D=2&filter%5Bname%5D=a');
    expect(page.links.next).toContain('page%5Bafter%5D=');
    expect(page.links.prev).toBeNull();
    const last = buildPage(rows.slice(0, 2), { size: 2 }, false, 'http://x/v1/tags');
    expect(last.links.next).toBeNull();
  });
});

describe('query', () => {
  it('nests bracket keys', () => {
    expect(nestBracketQuery({ 'filter[updatedAt][gte]': '1', 'filter[sequence][id]': 's', include: 'a,b', 'page[size]': '5' })).toEqual({
      filter: { updatedAt: { gte: '1' }, sequence: { id: 's' } },
      include: 'a,b',
      page: { size: '5' },
    });
  });
  it('parses booleans strictly', () => {
    expect(parseBool('true', 'x')).toBe(true);
    expect(() => parseBool('yes', 'x')).toThrow(/true or false/);
  });
});

describe('include', () => {
  it('caps at 3 and rejects unknown', () => {
    expect(parseInclude('a,b,a', ['a', 'b'])).toEqual(['a', 'b']);
    expect(() => parseInclude('a,b,c,d', ['a', 'b', 'c', 'd'])).toThrow(/at most 3/);
    expect(() => parseInclude('z', ['a'])).toThrow(/Unknown include/);
    expect(ref('prospects', 'p1')).toEqual({ id: 'p1', _href: '/v1/prospects/p1' });
  });
});

describe('crypto', () => {
  it('encrypts and decrypts with the KEK', () => {
    const kek = Buffer.alloc(32, 7).toString('base64');
    const blob = encrypt('secret', kek);
    expect(blob).not.toContain('secret');
    expect(decrypt(blob, kek)).toBe('secret');
  });
});
