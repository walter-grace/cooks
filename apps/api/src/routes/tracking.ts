import type { OpenAPIHono } from '@hono/zod-openapi';
import { recordClick, recordOpen, recordUnsubscribe, systemPrincipal, type Clock, type JobsPort } from '@cooks/core';
import type { Db } from '@cooks/db';
import type { AppEnv } from '../types.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Unauthenticated tracking endpoints: open pixel, click redirect, one-click unsubscribe. */
export function mountTracking(app: OpenAPIHono<AppEnv>, deps: { db: Db; secret: string; clock: Clock; jobs: JobsPort; publicUrl: string }) {
  app.get('/t/o/:token', async (c) => {
    await recordOpen({ db: deps.db, secret: deps.secret, now: deps.clock.now(), userAgent: c.req.header('user-agent') }, c.req.param('token')).catch(() => false);
    return c.body(GIF, 200, { 'content-type': 'image/gif', 'cache-control': 'no-store, no-cache, must-revalidate, private', pragma: 'no-cache', expires: '0' });
  });
  app.get('/t/c/:token', async (c) => {
    const url = await recordClick({ db: deps.db, secret: deps.secret, now: deps.clock.now(), userAgent: c.req.header('user-agent') }, c.req.param('token')).catch(() => null);
    if (!url) return c.text('Link expired', 410);
    return c.redirect(url, 302);
  });
  const unsubscribe = async (token: string) => {
    const ctx = { db: deps.db, principal: systemPrincipal('system'), jobs: deps.jobs, clock: deps.clock, traceId: 'unsubscribe', publicUrl: deps.publicUrl };
    return recordUnsubscribe(ctx, deps.secret, token);
  };
  app.get('/u/:token', async (c) => {
    const r = await unsubscribe(c.req.param('token')).catch(() => ({ ok: false as const }));
    const body = r.ok
      ? `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>You're unsubscribed</h1><p>${'email' in r && r.email ? r.email : 'This address'} won't receive further emails from this sender.</p></body>`
      : `<!doctype html><meta charset="utf-8"><title>Link expired</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>This link is no longer valid</h1><p>Reply to the original email and ask to be removed.</p></body>`;
    return c.html(body, r.ok ? 200 : 410);
  });
  // RFC 8058 one-click (List-Unsubscribe-Post)
  app.post('/u/:token', async (c) => {
    const r = await unsubscribe(c.req.param('token')).catch(() => ({ ok: false as const }));
    return c.body(null, r.ok ? 200 : 410);
  });
}
