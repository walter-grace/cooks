import { describe, expect, it } from 'vitest';
import { buildOurDoc, compare, loadUpstream } from './conformance.js';

describe('conformance against the vendored upstream spec', () => {
  it('implements every upstream operation and tags every extension', async () => {
    const up = loadUpstream();
    const report = compare(up.doc, await buildOurDoc());
    expect(report.missingOperations).toEqual([]);
    expect(report.untaggedExtensions).toEqual([]);
    expect(report.missingParams).toEqual([]);
    // Response fields: every upstream property exists on our component of the same name.
    expect(report.missingFields).toEqual([]);
  });
});
