import { describe, expect, it } from 'vitest';

async function expectViolation(p: Promise<unknown>, constraint: string) {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    expect(`${err.cause?.message ?? ''} ${err.message}`).toMatch(constraint);
    return;
  }
  throw new Error(`expected ${constraint} violation`);
}
import { uuidv7, UUID_RE } from './ids.js';
import { createTestDb } from './test.js';
import { prospects, sequenceStates, sequences, tags, workspaces } from './schema/index.js';

describe('ids', () => {
  it('uuidv7 is valid and time-ordered', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(UUID_RE);
    expect(a < b).toBe(true);
    expect(a.charAt(14)).toBe('7');
    const many = new Set(Array.from({ length: 2000 }, () => uuidv7()));
    expect(many.size).toBe(2000);
    expect([...many].sort()).toEqual([...many]);
  });
});

describe('migrations on PGlite', () => {
  it('applies and enforces the enrollment uniqueness rule', async () => {
    const t = await createTestDb();
    try {
      const [ws] = await t.db.insert(workspaces).values({ name: 'Acme', slug: 'acme' }).returning();
      const [p] = await t.db.insert(prospects).values({ workspaceId: ws!.id, name: 'Ada' }).returning();
      const [s] = await t.db.insert(sequences).values({ workspaceId: ws!.id, name: 'Intro', ownerId: uuidv7() }).returning();
      const base = { workspaceId: ws!.id, sequenceId: s!.id, prospectId: p!.id, ownerId: s!.ownerId };
      await t.db.insert(sequenceStates).values(base);
      await expectViolation(t.db.insert(sequenceStates).values(base), 'sequence_states_active_uq');
      // finished enrollments do not block re-enrollment
      await t.db.update(sequenceStates).set({ state: 'finished' });
      await expect(t.db.insert(sequenceStates).values(base)).resolves.toBeDefined();
      // tag name uniqueness is case-insensitive
      await t.db.insert(tags).values({ workspaceId: ws!.id, name: 'Hot' });
      await expectViolation(t.db.insert(tags).values({ workspaceId: ws!.id, name: 'hot' }), 'tags_ws_name_ci_uq');
    } finally {
      await t.close();
    }
  });
});
