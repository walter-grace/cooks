import { describe, expect, it, beforeAll } from 'vitest';
import { createTestApp, type TestApp } from './test/harness.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});

describe('landing page', () => {
  it('serves the page at / with every section and the MCP command', async () => {
    const res = await t.app.request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    for (const id of ['features', 'dialer', 'assistant', 'more', 'selfhost', 'footer']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('claude mcp add cooks');
    expect(html).toContain('not affiliated with or endorsed by Nooks');
    expect(html).not.toContain('cooks-api-' + 'XXXX'); // no real key shapes leak into the page
  });
  it('serves the footer art and screenshots from /landing, nothing else', async () => {
    for (const f of ['scene.png', 'boat.png', 'power-dialer.png', 'signals.png']) {
      const res = await t.app.request(`/landing/${f}`);
      expect(res.status, f).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
    }
    expect((await t.app.request('/landing/missing.png')).status).toBe(404);
    expect((await t.app.request('/landing/..%2Fapp.ts')).status).toBe(404);
  });
});
