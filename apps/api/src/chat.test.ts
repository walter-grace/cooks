import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LlmProvider, StructuredRequest, StructuredResult } from '@cooks/agent';
import { workspaceAiSettings } from '@cooks/db';
import { createTestApp, type TestApp } from './test/harness.js';

/** A scripted provider: inspects the prompt it gets and answers with the next step in the script. */
function scripted(steps: Array<(req: StructuredRequest<unknown>) => unknown>): LlmProvider & { prompts: string[] } {
  let i = 0;
  const prompts: string[] = [];
  return {
    id: 'anthropic',
    model: 'fake-1',
    prompts,
    async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
      prompts.push(req.user);
      const fn = steps[Math.min(i++, steps.length - 1)]!;
      const value = fn(req as StructuredRequest<unknown>);
      const parsed = req.schema.safeParse(value);
      if (!parsed.success) return { kind: 'invalid', error: parsed.error.message, text: JSON.stringify(value), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 }, model: 'fake-1', latencyMs: 1 };
      return { kind: 'ok', value: parsed.data, usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 }, model: 'fake-1', latencyMs: 1 };
    },
  };
}

const events = (text: string) =>
  text
    .split('\n\n')
    .filter((b) => b.includes('event:'))
    .map((b) => {
      const event = b.match(/event: (\w+)/)![1]!;
      const data = JSON.parse(b.split('\n').find((l) => l.startsWith('data:'))!.slice(5).trim()) as Record<string, unknown>;
      return { event, data };
    });

describe('in-app assistant', () => {
  let t: TestApp;
  let adaId = '';
  const provider = scripted([
    () => ({ thought: 'Looking for the prospect by name.', action: 'tool', tool: 'cooks_search', argsJson: JSON.stringify({ q: 'Ada', types: ['prospect'] }) }),
    (req) => {
      const m = req.user.match(/"entityId":"([0-9a-f-]{36})"/);
      return { thought: 'Found her. Opening the record.', action: 'reply', reply: `Ada Lovelace is a prospect at Globex. Opening her page.`, navigate: m ? `/prospects/${m[1]}` : null };
    },
  ]);

  beforeAll(async () => {
    t = await createTestApp({ chat: { env: { ANTHROPIC_API_KEY: 'test-key' }, providerFor: () => provider } });
    await t.db.insert(workspaceAiSettings).values({ workspaceId: t.workspaceId, provider: 'anthropic' });
    const acct = await t.request('/v1/accounts', { method: 'POST', json: { data: { name: 'Globex', domain: 'globex.test' } } });
    const ada = await t.request('/v1/prospects', { method: 'POST', json: { data: { firstName: 'Ada', lastName: 'Lovelace', primaryEmail: 'ada@globex.test', account: { id: acct.json.data.id } } } });
    adaId = ada.json.data.id;
  });
  afterAll(() => t.close());

  it('runs a tool as the caller, then replies with a page to open', async () => {
    const r = await t.request('/v1/chat', { method: 'POST', json: { data: { messages: [{ role: 'user', content: 'Find Ada and open her' }], page: '/' } } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    const evs = events(r.text);
    const names = evs.map((e) => e.event);
    expect(names).toEqual(['thinking', 'tool_call', 'tool_result', 'thinking', 'reply', 'done']);
    expect(evs[1]!.data).toMatchObject({ name: 'cooks_search', args: { q: 'Ada' } });
    expect(evs[2]!.data.ok).toBe(true);
    expect(evs[4]!.data).toMatchObject({ navigate: `/prospects/${adaId}` });
    expect((evs[5]!.data as { toolCalls: number }).toolCalls).toBe(1);
    // the system prompt lists the tools and the pages, and the second step saw the search result
    expect(provider.prompts[1]).toContain('cooks_search(');
    expect(provider.prompts[1]).toContain(adaId);
  });

  it('rejects bad tool arguments without calling the API, and recovers', async () => {
    const p2 = scripted([
      () => ({ thought: 'Trying a bad call.', action: 'tool', tool: 'cooks_get_prospect', argsJson: '{"id":"not-a-uuid"}' }),
      (req) => ({ thought: 'That failed; replying.', action: 'reply', reply: req.user.includes('invalid arguments') ? 'Could not fetch that.' : 'unexpected', navigate: null }),
    ]);
    const t2 = await createTestApp({ chat: { env: { ANTHROPIC_API_KEY: 'test-key' }, providerFor: () => p2 } });
    await t2.db.insert(workspaceAiSettings).values({ workspaceId: t2.workspaceId, provider: 'anthropic' });
    const r = await t2.request('/v1/chat', { method: 'POST', json: { data: { messages: [{ role: 'user', content: 'open prospect not-a-uuid' }] } } });
    const evs = events(r.text);
    expect(evs.find((e) => e.event === 'tool_result')!.data.ok).toBe(false);
    expect(evs.find((e) => e.event === 'reply')!.data.text).toBe('Could not fetch that.');
    await t2.close();
  });

  it('answers 422 when the workspace has no model provider', async () => {
    const bare = await createTestApp({ chat: { env: {} } });
    const r = await bare.request('/v1/chat', { method: 'POST', json: { data: { messages: [{ role: 'user', content: 'hi' }] } } });
    expect(r.status).toBe(422);
    await bare.close();
  });
});
