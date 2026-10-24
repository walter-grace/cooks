import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MemoryAuthMailer } from './auth-mail.js';
import { createTestApp, type TestApp } from './test/harness.js';

const linkIn = (text: string, path: string) => {
  const m = text.match(new RegExp(`https?://[^\\s]+${path}\\?token=([A-Za-z0-9_-]+)`));
  return m?.[1] ?? null;
};
const cookieOf = (headers: Headers): string => (headers.get('set-cookie') ?? '').split(';')[0] ?? '';

describe('self-serve accounts', () => {
  let t: TestApp;
  const mail = new MemoryAuthMailer();
  beforeAll(async () => {
    t = await createTestApp({ account: { signup: 'open', mailer: mail } });
  });
  afterAll(() => t.close());

  it('advertises the sign-up mode', async () => {
    const r = await t.request('/auth/config', { token: null });
    expect(r.json).toMatchObject({ mode: 'password', signup: 'open' });
  });

  it('signs up: user, workspace, admin role, cookie, verification mail', async () => {
    const r = await t.request('/auth/signup', { method: 'POST', token: null, json: { email: 'Nina@Startup.test', name: 'Nina', password: 'correct horse battery', workspaceName: 'Startup Inc' } });
    expect(r.status).toBe(201);
    expect(r.json.workspace.name).toBe('Startup Inc');
    const cookie = cookieOf(r.headers);
    expect(cookie.startsWith('cooks_session=')).toBe(true);
    const me = await t.request('/auth/session-token', { method: 'POST', token: null, headers: { cookie } });
    expect(me.status).toBe(200);
    expect(me.json.workspace.role).toBe('admin');
    expect(me.json.user.email).toBe('nina@startup.test');
    expect(me.json.user.emailVerified).toBe(false);
    const sent = mail.sent.find((m) => m.to === 'nina@startup.test' && /Confirm/.test(m.subject));
    expect(sent).toBeTruthy();
    const token = linkIn(sent!.text, '/app/verify');
    expect(token).toBeTruthy();
    const v = await t.request('/auth/verify', { method: 'POST', token: null, json: { token } });
    expect(v.status).toBe(200);
    const again = await t.request('/auth/verify', { method: 'POST', token: null, json: { token } });
    expect(again.status).toBe(400);
    const me2 = await t.request('/auth/session-token', { method: 'POST', token: null, headers: { cookie } });
    expect(me2.json.user.emailVerified).toBe(true);
  });

  it('rejects a taken address, a weak password and a bad email', async () => {
    const dup = await t.request('/auth/signup', { method: 'POST', token: null, json: { email: 'nina@startup.test', name: 'N', password: 'correct horse battery', workspaceName: 'X' } });
    expect(dup.status).toBe(409);
    const weak = await t.request('/auth/signup', { method: 'POST', token: null, json: { email: 'z@z.test', name: 'Z', password: 'short', workspaceName: 'X' } });
    expect(weak.status).toBe(400);
    const bad = await t.request('/auth/signup', { method: 'POST', token: null, json: { email: 'nope', name: 'Z', password: 'correct horse battery', workspaceName: 'X' } });
    expect(bad.status).toBe(400);
  });

  it('resets a password from the mailed link and signs other sessions out', async () => {
    const before = mail.sent.length;
    const unknown = await t.request('/auth/password/forgot', { method: 'POST', token: null, json: { email: 'nobody@startup.test' } });
    expect(unknown.status).toBe(200);
    expect(mail.sent.length).toBe(before);
    const r = await t.request('/auth/password/forgot', { method: 'POST', token: null, json: { email: 'nina@startup.test' } });
    expect(r.status).toBe(200);
    const token = linkIn(mail.sent.at(-1)!.text, '/app/reset');
    expect(token).toBeTruthy();
    const reset = await t.request('/auth/password/reset', { method: 'POST', token: null, json: { token, password: 'a brand new passphrase' } });
    expect(reset.status).toBe(200);
    const old = await t.request('/auth/login', { method: 'POST', token: null, json: { email: 'nina@startup.test', password: 'correct horse battery', next: '/app' }, redirect: 'manual' });
    expect(old.status).toBe(401);
    const fresh = await t.request('/auth/login', { method: 'POST', token: null, json: { email: 'nina@startup.test', password: 'a brand new passphrase', next: '/app' }, redirect: 'manual' });
    expect(fresh.status).toBe(303);
  });

  it('admins invite by email; the link creates the account in the right workspace with the right role', async () => {
    const list0 = await t.request('/v1/workspace/invites');
    expect(list0.status).toBe(200);
    const inv = await t.request('/v1/workspace/invites', { method: 'POST', json: { data: { email: 'rep2@acme.test', role: 'manager' } } });
    expect(inv.status).toBe(201);
    expect(inv.json.data.email).toBe('rep2@acme.test');
    expect(inv.json.data.link).toBeUndefined();
    const sent = mail.sent.find((m) => m.to === 'rep2@acme.test');
    const token = linkIn(sent!.text, '/app/join');
    expect(token).toBeTruthy();
    const peek = await t.request(`/auth/invite/${token}`, { token: null });
    expect(peek.status).toBe(200);
    expect(peek.json).toMatchObject({ email: 'rep2@acme.test', role: 'manager', workspaceName: 'Acme', existingUser: false });
    const noPw = await t.request('/auth/invite/accept', { method: 'POST', token: null, json: { token, name: 'Rae' } });
    expect(noPw.status).toBe(400);
    const ok = await t.request('/auth/invite/accept', { method: 'POST', token: null, json: { token, name: 'Rae', password: 'rae has a long password' } });
    expect(ok.status).toBe(200);
    expect(ok.json.workspaceId).toBe(t.workspaceId);
    const me = await t.request('/auth/session-token', { method: 'POST', token: null, headers: { cookie: cookieOf(ok.headers) } });
    expect(me.json.workspace.id).toBe(t.workspaceId);
    expect(me.json.workspace.role).toBe('manager');
    expect(me.json.user.emailVerified).toBe(true);
    const list1 = await t.request('/v1/workspace/invites');
    expect(list1.json.data.find((i: { email: string }) => i.email === 'rep2@acme.test')).toBeUndefined();
    const again = await t.request('/v1/workspace/invites', { method: 'POST', json: { data: { email: 'rep2@acme.test' } } });
    expect(again.status).toBe(409);
  });

  it('an existing user accepting an invite just joins the second workspace', async () => {
    const inv = await t.request('/v1/workspace/invites', { method: 'POST', json: { data: { email: 'nina@startup.test', role: 'user' } } });
    expect(inv.status).toBe(201);
    const token = linkIn(mail.sent.at(-1)!.text, '/app/join')!;
    const peek = await t.request(`/auth/invite/${token}`, { token: null });
    expect(peek.json.existingUser).toBe(true);
    const ok = await t.request('/auth/invite/accept', { method: 'POST', token: null, json: { token } });
    expect(ok.status).toBe(200);
    const me = await t.request('/auth/session-token', { method: 'POST', token: null, headers: { cookie: cookieOf(ok.headers) }, json: { workspaceId: t.workspaceId } });
    expect(me.json.workspaces.length).toBe(2);
    expect(me.json.workspace.role).toBe('user');
  });

  it('revokes an invite', async () => {
    const inv = await t.request('/v1/workspace/invites', { method: 'POST', json: { data: { email: 'gone@acme.test' } } });
    const del = await t.request(`/v1/workspace/invites/${inv.json.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    const token = linkIn(mail.sent.at(-1)!.text, '/app/join')!;
    const peek = await t.request(`/auth/invite/${token}`, { token: null });
    expect(peek.status).toBe(404);
  });
});

describe('sign-up closed', () => {
  it('returns 403 when off, and invite-only still accepts invites', async () => {
    const off = await createTestApp();
    const r = await off.request('/auth/signup', { method: 'POST', token: null, json: { email: 'a@b.test', name: 'A', password: 'correct horse battery', workspaceName: 'X' } });
    expect(r.status).toBe(403);
    const cfg = await off.request('/auth/config', { token: null });
    expect(cfg.json.signup).toBe('off');
    await off.close();
    const inviteOnly = await createTestApp({ account: { signup: 'invite' } });
    const r2 = await inviteOnly.request('/auth/signup', { method: 'POST', token: null, json: { email: 'a@b.test', name: 'A', password: 'correct horse battery', workspaceName: 'X' } });
    expect(r2.status).toBe(403);
    const inv = await inviteOnly.request('/v1/workspace/invites', { method: 'POST', json: { data: { email: 'new@acme.test' } } });
    expect(inv.status).toBe(201);
    expect(typeof inv.json.data.link).toBe('string'); // no mailer: the admin gets the link to pass on
    await inviteOnly.close();
  });
});
