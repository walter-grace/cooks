import { describe, expect, it } from 'vitest';
import { GmailProvider, GoogleTokenSource } from './google.js';
import { MicrosoftGraphProvider, MicrosoftTokenSource } from './microsoft.js';
import { buildRfc822 } from './oauth-mail.js';
import { parseRfc822 } from './parse.js';

function fakeFetch(routes: Array<[RegExp, (url: string, init?: RequestInit) => unknown | Response]>) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const f: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined });
    for (const [re, h] of routes) if (re.test(url)) {
      const r = h(url, init);
      return r instanceof Response ? r : Response.json(r);
    }
    return new Response('not found', { status: 404 });
  };
  return { f, calls };
}

describe('RFC 822 builder', () => {
  it('round-trips through the parser with threading headers', async () => {
    const raw = buildRfc822({ from: '"Olive" <olive@acme.test>', to: ['ada@globex.test'], subject: 'Héllo Ada', text: 'plain', html: '<p>html</p>', messageId: '<m1@acme.test>', inReplyTo: '<o0@acme.test>', references: ['<o0@acme.test>'], headers: { 'X-Cooks-Email-Id': 'e1' } });
    const p = await parseRfc822(raw, 'x');
    expect(p).toMatchObject({ from: 'olive@acme.test', to: ['ada@globex.test'], subject: 'Héllo Ada', messageId: '<m1@acme.test>', inReplyTo: '<o0@acme.test>' });
    expect(p.text.trim()).toBe('plain');
    expect(p.html).toContain('<p>html</p>');
    expect(p.headers['x-cooks-email-id']).toBe('e1');
  });
});

describe('Gmail provider', () => {
  it('refreshes expired tokens, sends raw, syncs via history', async () => {
    const raw = buildRfc822({ from: 'ada@globex.test', to: ['olive@acme.test'], subject: 'Re: Hello', text: 'yes please', html: '<p>yes please</p>', messageId: '<r1@globex.test>', inReplyTo: '<o1@acme.test>' });
    const { f, calls } = fakeFetch([
      [/oauth2\.googleapis\.com\/token/, () => ({ access_token: 'fresh', expires_in: 3600 })],
      [/messages\/send/, () => ({ id: 'g1', threadId: 't1' })],
      [/users\/me\/profile/, () => ({ emailAddress: 'olive@acme.test', historyId: '500' })],
      [/users\/me\/history/, () => ({ history: [{ messagesAdded: [{ message: { id: 'm9' } }] }], historyId: '600' })],
      [/messages\/m9\?format=raw/, () => ({ id: 'm9', threadId: 't1', raw: Buffer.from(raw).toString('base64url') })],
    ]);
    const refreshed: string[] = [];
    const src = new GoogleTokenSource(f, { clientId: 'c', clientSecret: 's' }, { refreshToken: 'r', accessToken: 'old', expiresAt: Date.now() - 1 }, async (t) => void refreshed.push(t.accessToken!));
    const g = new GmailProvider(f, src);
    const sent = await g.send({ from: 'olive@acme.test', to: ['ada@globex.test'], subject: 'Hello', text: 't', html: '<p>t</p>', messageId: '<o1@acme.test>' });
    expect(sent).toMatchObject({ providerMessageId: 'g1', threadId: 't1' });
    expect(refreshed).toEqual(['fresh']);
    expect(calls.find((c) => c.url.includes('messages/send'))!.body).toContain('"raw":"');
    const first = await g.sync(null);
    expect(first).toEqual({ messages: [], cursor: { historyId: '500' } });
    const second = await g.sync(first.cursor);
    expect(second.cursor).toEqual({ historyId: '600' });
    expect(second.messages[0]).toMatchObject({ providerId: 'gmail:m9', threadId: 't1', from: 'ada@globex.test', inReplyTo: '<o1@acme.test>' });
    expect(calls.filter((c) => c.url.includes('oauth2.googleapis.com/token'))).toHaveLength(1); // token reused after refresh
  });
});

describe('Microsoft Graph provider', () => {
  it('sends draft→send returning Graph Message-ID, and syncs via delta', async () => {
    const { f, calls } = fakeFetch([
      [/login\.microsoftonline\.com/, () => ({ access_token: 'ms', refresh_token: 'r2', expires_in: 3600 })],
      [/\/me\/messages\/d1\/send/, () => new Response(null, { status: 202 })],
      [/\/me\/messages$/, () => ({ id: 'd1', internetMessageId: '<graph-1@outlook.test>', conversationId: 'conv1' })],
      [/messages\/delta\?/, () => ({ value: [], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=A' })],
      [/delta\?token=A/, () => ({
        value: [
          { id: 'x1', internetMessageId: '<r2@globex.test>', conversationId: 'conv1', subject: 'Re: Hello', from: { emailAddress: { address: 'Ada@Globex.test' } }, toRecipients: [{ emailAddress: { address: 'olive@acme.test' } }], receivedDateTime: '2026-03-03T16:00:00Z', body: { contentType: 'html', content: '<p>Sounds <b>good</b></p>' }, internetMessageHeaders: [{ name: 'In-Reply-To', value: '<graph-1@outlook.test>' }] },
          { id: 'x2', isDraft: true, from: { emailAddress: { address: 'me@acme.test' } } },
        ],
        '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/delta?token=B',
      })],
    ]);
    const src = new MicrosoftTokenSource(f, { clientId: 'c', clientSecret: 's' }, { refreshToken: 'r' });
    const g = new MicrosoftGraphProvider(f, src);
    const sent = await g.send({ from: 'olive@acme.test', to: ['ada@globex.test'], subject: 'Hello', text: 't', html: '<p>t</p>', messageId: '<ours@acme.test>', headers: { 'X-Cooks-Email-Id': 'e1', 'List-Unsubscribe': '<u>' } });
    expect(sent).toMatchObject({ providerMessageId: 'd1', messageId: '<graph-1@outlook.test>', threadId: 'conv1' });
    const draftBody = JSON.parse(calls.find((c) => /\/me\/messages$/.test(c.url))!.body!);
    expect(draftBody.internetMessageHeaders).toEqual([{ name: 'X-Cooks-Email-Id', value: 'e1' }]);
    const first = await g.sync(null);
    expect(first.messages).toEqual([]);
    const second = await g.sync(first.cursor);
    expect(second.cursor).toEqual({ deltaLink: 'https://graph.microsoft.com/v1.0/delta?token=B' });
    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ providerId: 'graph:x1', from: 'ada@globex.test', inReplyTo: '<graph-1@outlook.test>', threadId: 'conv1', text: 'Sounds good' });
  });
});
