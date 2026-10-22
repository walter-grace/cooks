import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuns } from '@cooks/db';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('AI settings + runs', () => {
  it('stores a provider key encrypted and never returns it', async () => {
    const r = await t.request('/v1/workspace/ai', { method: 'PATCH', json: { data: { provider: 'xai', model: 'grok-4.7', apiKey: 'xai-secret-ABCD', monthlyBudgetUsd: 25, confidenceThreshold: 0.8 } } });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ provider: 'xai', model: 'grok-4.7', hasKey: true, keyLast4: 'ABCD', monthlyBudgetUsd: 25, confidenceThreshold: 0.8, autoSendAiEmail: false });
    expect(JSON.stringify(r.json)).not.toContain('xai-secret');
    const cleared = await t.request('/v1/workspace/ai', { method: 'PATCH', json: { data: { apiKey: null } } });
    expect(cleared.json.data.hasKey).toBe(false);
    const g = await t.request('/v1/workspace/ai');
    expect(g.json.data.provider).toBe('xai');
  });
  it('lists runs and aggregates stats', async () => {
    await t.db.insert(agentRuns).values([
      { workspaceId: t.workspaceId, kind: 'draft_email', status: 'succeeded', provider: 'anthropic', model: 'claude-opus-5-5', tokensIn: 1000, tokensOut: 200, costUsd: '0.008', parentType: 'task', parentId: 'x' },
      { workspaceId: t.workspaceId, kind: 'classify_reply', status: 'needs_review', provider: 'anthropic', model: 'claude-haiku-5-5', tokensIn: 300, tokensOut: 50, costUsd: '0.0001' },
    ]);
    const l = await t.request('/v1/agentRuns?filter[kind]=draft_email');
    expect(l.json.data).toHaveLength(1);
    expect(l.json.data[0]).toMatchObject({ kind: 'draft_email', costUsd: 0.008 });
    const one = await t.request(`/v1/agentRuns/${l.json.data[0].id}`);
    expect(one.json.data.logs).toEqual([]);
    const s = await t.request('/v1/agentRuns/stats?days=7');
    expect(s.json.data.totalCostUsd).toBeCloseTo(0.0081, 6);
    expect(s.json.data.rows.map((r: any) => r.kind).sort()).toEqual(['classify_reply', 'draft_email']);
    const rep = await t.request('/v1/agentRuns', { token: null });
    expect(rep.status).toBe(401);
  });
});
