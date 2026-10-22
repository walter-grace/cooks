import type { InboundMessage, InboundProvider, MailProvider, OutboundMessage, SendResult, SyncCursor } from './provider.js';
import { apiJson, postForm, type Fetch, type OAuthAppConfig, type OAuthTokens } from './oauth-mail.js';

export const MS_SCOPES = ['offline_access', 'User.Read', 'Mail.Send', 'Mail.Read'];
const GRAPH = 'https://graph.microsoft.com/v1.0';

export function microsoftAuthUrl(app: OAuthAppConfig, state: string, tenant = 'common'): string {
  const u = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', app.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('response_mode', 'query');
  u.searchParams.set('scope', MS_SCOPES.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

export async function microsoftExchangeCode(fetchImpl: Fetch, app: OAuthAppConfig, code: string, tenant = 'common'): Promise<OAuthTokens> {
  const t = await postForm(fetchImpl, `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri, grant_type: 'authorization_code', scope: MS_SCOPES.join(' ') });
  const tokens: OAuthTokens = { refreshToken: String(t.refresh_token), accessToken: String(t.access_token), expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000 };
  const me = await apiJson<{ mail?: string; userPrincipalName: string }>(fetchImpl, `${GRAPH}/me`, { token: tokens.accessToken! });
  tokens.email = (me.mail ?? me.userPrincipalName).toLowerCase();
  return tokens;
}

export class MicrosoftTokenSource {
  constructor(
    private fetchImpl: Fetch,
    private app: Pick<OAuthAppConfig, 'clientId' | 'clientSecret'>,
    public tokens: OAuthTokens,
    private onRefresh?: (t: OAuthTokens) => Promise<void>,
    private tenant = 'common',
    private refresher?: () => Promise<OAuthTokens>,
  ) {}
  async token(): Promise<string> {
    if (this.tokens.accessToken && (this.tokens.expiresAt ?? 0) > Date.now() + 60_000) return this.tokens.accessToken;
    if (this.refresher) {
      this.tokens = await this.refresher();
      await this.onRefresh?.(this.tokens);
      return this.tokens.accessToken!;
    }
    const t = await postForm(this.fetchImpl, `https://login.microsoftonline.com/${this.tenant}/oauth2/v2.0/token`, { refresh_token: this.tokens.refreshToken, client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: 'refresh_token', scope: MS_SCOPES.join(' ') });
    this.tokens = { ...this.tokens, accessToken: String(t.access_token), refreshToken: String(t.refresh_token ?? this.tokens.refreshToken), expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000 };
    await this.onRefresh?.(this.tokens);
    return this.tokens.accessToken!;
  }
}

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  from?: { emailAddress: { address: string } };
  toRecipients?: Array<{ emailAddress: { address: string } }>;
  receivedDateTime?: string;
  body?: { contentType: 'text' | 'html'; content: string };
  bodyPreview?: string;
  internetMessageHeaders?: Array<{ name: string; value: string }>;
  isDraft?: boolean;
  '@removed'?: unknown;
}

/**
 * Microsoft 365 via Graph. Graph assigns its own Message-ID, so sending is draft → read
 * internetMessageId → send, and the id is returned so Cooks can match replies.
 */
export class MicrosoftGraphProvider implements MailProvider, InboundProvider {
  readonly kind = 'ms_graph' as const;
  constructor(
    private fetchImpl: Fetch,
    private src: MicrosoftTokenSource,
  ) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const token = await this.src.token();
    const rcpt = (list?: string[]) => (list ?? []).map((address) => ({ emailAddress: { address } }));
    const draft = await apiJson<GraphMessage>(this.fetchImpl, `${GRAPH}/me/messages`, {
      method: 'POST',
      token,
      body: JSON.stringify({
        subject: msg.subject,
        body: { contentType: 'html', content: msg.html },
        toRecipients: rcpt(msg.to),
        ccRecipients: rcpt(msg.cc),
        bccRecipients: rcpt(msg.bcc),
        internetMessageHeaders: Object.entries(msg.headers ?? {})
          .filter(([k]) => /^x-/i.test(k))
          .map(([name, value]) => ({ name, value })),
      }),
    });
    await apiJson<void>(this.fetchImpl, `${GRAPH}/me/messages/${draft.id}/send`, { method: 'POST', token });
    return { providerMessageId: draft.id, threadId: draft.conversationId ?? null, messageId: draft.internetMessageId ?? null, accepted: msg.to, rejected: [] };
  }

  async sync(cursor: SyncCursor | null): Promise<{ messages: InboundMessage[]; cursor: SyncCursor }> {
    const token = await this.src.token();
    const select = '$select=id,internetMessageId,conversationId,subject,from,toRecipients,receivedDateTime,body,bodyPreview,internetMessageHeaders,isDraft';
    let url = (cursor?.deltaLink as string | undefined) ?? `${GRAPH}/me/mailFolders/inbox/messages/delta?${select}&$top=50`;
    const first = !cursor?.deltaLink;
    const messages: InboundMessage[] = [];
    let deltaLink: string | undefined;
    for (let i = 0; i < 20 && url; i++) {
      const page = await apiJson<{ value: GraphMessage[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>(this.fetchImpl, url, { token, headers: { Prefer: 'odata.maxpagesize=50' } });
      if (!first) {
        for (const m of page.value) {
          if (m['@removed'] || m.isDraft || !m.from) continue;
          const headers: Record<string, string> = {};
          for (const h of m.internetMessageHeaders ?? []) headers[h.name.toLowerCase()] = h.value;
          const text = m.body?.contentType === 'text' ? m.body.content : (m.body?.content ?? '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          const refs = (headers['references'] ?? '').split(/\s+/).filter(Boolean);
          const autoSubmitted = (headers['auto-submitted'] !== undefined && headers['auto-submitted'] !== 'no') || 'x-autoreply' in headers || /^(automatic reply|out of office)/i.test(m.subject ?? '');
          messages.push({
            providerId: `graph:${m.id}`,
            messageId: m.internetMessageId ?? null,
            inReplyTo: headers['in-reply-to'] ?? null,
            references: refs,
            threadId: m.conversationId ?? null,
            from: m.from.emailAddress.address.toLowerCase(),
            to: (m.toRecipients ?? []).map((r) => r.emailAddress.address.toLowerCase()),
            date: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
            subject: m.subject ?? '',
            text,
            html: m.body?.contentType === 'html' ? m.body.content : null,
            headers,
            autoSubmitted,
            dsn: /^(postmaster|mailer-daemon)@/i.test(m.from.emailAddress.address) && /undeliverable/i.test(m.subject ?? '') ? { action: 'failed', status: '5.0.0', recipient: null, originalMessageId: null, diagnostic: m.bodyPreview ?? null } : null,
          });
        }
      }
      deltaLink = page['@odata.deltaLink'];
      url = page['@odata.nextLink'] ?? '';
    }
    return { messages, cursor: { deltaLink: deltaLink ?? cursor?.deltaLink } };
  }
}
