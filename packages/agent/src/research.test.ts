import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '@cooks/db/test';
import { accounts, agentRuns, prospects, signals, users, workspaceMembers, workspaces, type Db } from '@cooks/db';
import { latestResearch, researchProspect } from './jobs/research.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import type { LlmProvider, StructuredRequest, StructuredResult } from './providers/types.js';

describe('OpenRouter web plugin', () => {
  it('adds plugins:[{id:web}] and returns url citations', async () => {
    const bodies: any[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, init?: any) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({
        model: 'anthropic/claude-sonnet-5.5',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ a: 1 }), annotations: [{ type: 'url_citation', url_citation: { url: 'https://news.test/x', title: 'News' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0003 },
      });
    }) as typeof fetch;
    try {
      const p = new OpenAICompatProvider('openrouter', '~anthropic/claude-sonnet-latest', { apiKey: 'k' });
      const { z } = await import('zod');
      const r = await p.structured({ system: 's', user: 'u', schema: z.object({ a: z.number() }), schemaName: 'x', web: { maxResults: 3 } });
      expect(bodies[0].plugins[0]).toMatchObject({ id: 'web', max_results: 3 });
      expect(bodies[0].plugins[0].search_prompt).toContain('source URLs');
      expect(bodies[0].response_format.type).toBe('json_schema');
      expect(bodies[0].usage).toEqual({ include: true });
      expect(r.kind).toBe('ok');
      if (r.kind === 'ok') {
        expect(r.citations).toEqual([{ url: 'https://news.test/x', title: 'News' }]);
        expect(r.usage.costUsd).toBe(0.0003);
      }
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

class FakeResearch implements LlmProvider {
  readonly id = 'openrouter' as const;
  readonly model = 'fake';
  public last: StructuredRequest<unknown> | null = null;
  async structured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.last = req as StructuredRequest<unknown>;
    const value = { summary: 'Globex raised money and is hiring.', talkingPoints: ['Congrats on the raise'], signals: [{ kind: 'funding', text: 'Raised $40M Series B', sourceUrl: 'https://news.test/globex-b', date: '2026-02-10' }, { kind: 'hiring', text: 'Hiring 12 SDRs', sourceUrl: null, date: null }], confidence: 0.8 };
    return { kind: 'ok', value: req.schema.parse(value), usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, costUsd: 0.002 }, model: 'fake', latencyMs: 3, citations: [{ url: 'https://news.test/globex-b' }] };
  }
}

describe('researchProspect', () => {
  let db: Db;
  let close: () => Promise<void>;
  const ids = { ws: '', prospect: '' };
  beforeAll(async () => {
    const t = await createTestDb();
    db = t.db;
    close = t.close;
    const [ws] = await db.insert(workspaces).values({ name: 'A', slug: 'a' }).returning();
    const [u] = await db.insert(users).values({ email: 'o@a.test', name: 'O' }).returning();
    await db.insert(workspaceMembers).values({ workspaceId: ws!.id, userId: u!.id, role: 'admin' });
    const [a] = await db.insert(accounts).values({ workspaceId: ws!.id, name: 'Globex', domain: 'globex.test', industry: 'Manufacturing' }).returning();
    const [p] = await db.insert(prospects).values({ workspaceId: ws!.id, accountId: a!.id, name: 'Ada Lovelace', title: 'CTO' }).returning();
    Object.assign(ids, { ws: ws!.id, prospect: p!.id });
  });
  afterAll(() => close());

  it('asks for web grounding, stores a summary + signals, and is cached for 7 days', async () => {
    const fake = new FakeResearch();
    const env = { OPENROUTER_API_KEY: 'k' };
    const r = await researchProspect({ db, env, now: () => new Date('2026-03-03T15:00:00Z'), providerOverride: fake }, ids.prospect, { focus: 'outbound tooling' });
    expect(r.status).toBe('ok');
    expect(fake.last!.web).toEqual({ maxResults: 6 });
    expect(fake.last!.user).toContain('Globex (globex.test)');
    expect(fake.last!.user).toContain('outbound tooling');
    const rows = await db.select().from(signals).where(eq(signals.prospectId, ids.prospect));
    expect(rows.map((x) => x.kind).sort()).toEqual(['research.funding', 'research.hiring', 'research.summary']);
    const latest = await latestResearch(db, ids.prospect);
    expect(latest?.summary).toContain('Globex');
    expect(latest?.citations).toEqual([{ url: 'https://news.test/globex-b' }]);
    const again = await researchProspect({ db, env, now: () => new Date('2026-03-04T15:00:00Z'), providerOverride: fake }, ids.prospect, { focus: 'outbound tooling' });
    expect(again.status === 'ok' && again.cached).toBe(true);
    const runs = await db.select().from(agentRuns).where(eq(agentRuns.workspaceId, ids.ws));
    expect(runs).toHaveLength(2);
    expect(runs.filter((x) => x.kind === 'research')).toHaveLength(2);
  });
});
