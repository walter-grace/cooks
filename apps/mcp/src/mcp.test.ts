import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from './server.js';
import { TOOLS } from './tools.js';

/** Fake Cooks API: records calls and answers with canned bodies. */
function fakeApi() {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    if (url.endsWith('/v1/me')) return Response.json({ data: { workspaceId: 'ws', userId: null, authType: 'apiKey', scopes: ['sequences:write'] } });
    if (url.includes('/actions/finish')) return new Response(null, { status: 204 });
    if (url.includes('/v1/sequenceStates') && init?.method === 'POST') return Response.json({ error: { code: 'CONFLICT', message: 'already enrolled' }, traceId: 't' }, { status: 409 });
    return Response.json({ data: [], links: { first: '/x', prev: null, next: null } });
  };
  return { calls, fetchImpl };
}

describe('cooks-mcp', () => {
  it('exposes the tool catalog with annotations and proxies calls to the API', async () => {
    const api = fakeApi();
    const server = createServer({ apiUrl: 'http://api.test', token: 'cooks-api-x', fetchImpl: api.fetchImpl });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(ct);

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const me = tools.tools.find((t) => t.name === 'cooks_me')!;
    expect(me.annotations?.readOnlyHint).toBe(true);

    const r = await client.callTool({ name: 'cooks_me', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect((r.structuredContent as any).data.workspaceId).toBe('ws');

    const list = await client.callTool({ name: 'cooks_list_tasks', arguments: { ownerId: 'u1', dueBefore: '2026-03-03T15:00:00Z', pageSize: 10 } });
    expect(list.isError).toBeFalsy();
    const last = api.calls.at(-1)!;
    expect(decodeURIComponent(last.url)).toContain('filter[owner][id]=u1');
    expect(decodeURIComponent(last.url)).toContain('filter[completed]=false');
    expect(decodeURIComponent(last.url)).toContain('page[size]=10');

    const conflict = await client.callTool({ name: 'cooks_enroll_prospect', arguments: { prospectId: '00000000-0000-7000-8000-000000000001', sequenceId: '00000000-0000-7000-8000-000000000002', ownerId: 'u1' } });
    expect(conflict.isError).toBe(true);
    expect((conflict.content as any)[0].text).toContain('CONFLICT');
    expect(api.calls.at(-1)!.body).toMatchObject({ data: { prospect: { id: '00000000-0000-7000-8000-000000000001' }, state: 'active' } });

    const fin = await client.callTool({ name: 'cooks_finish_enrollment', arguments: { id: '00000000-0000-7000-8000-000000000003' } });
    expect(fin.isError).toBeFalsy();

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain('work-the-task-queue');
    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain('cooks://docs/merge-fields');
    await client.close();
  });
});
