import { describe, expect, it } from 'vitest';
import { extractJson } from './json.js';

describe('extractJson', () => {
  it('handles fences, prose, and plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n{"a":{"b":[1,2]}}\nThanks!')).toEqual({ a: { b: [1, 2] } });
    expect(extractJson('{"a":1')).toBeUndefined();
  });
});
