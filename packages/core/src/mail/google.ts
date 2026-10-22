import { parseRfc822 } from './parse.js';
import type { InboundMessage, InboundProvider, MailProvider, OutboundMessage, SendResult, SyncCursor } from './provider.js';
import { apiJson, b64url, buildRfc822, postForm, type Fetch, type OAuthAppConfig, type OAuthTokens } from './oauth-mail.js';

export const GOOGLE_SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/userinfo.email', 'openid'];

export function googleAuthUrl(app: OAuthAppConfig, state: string): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', app.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  return u.toString();
}

export async function googleExchangeCode(fetchImpl: Fetch, app: OAuthAppConfig, code: string): Promise<OAuthTokens> {
  const t = await postForm(fetchImpl, 'https://oauth2.googleapis.com/token', { code, client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: app.redirectUri, grant_type: 'authorization_code' });
  const tokens: OAuthTokens = { refreshToken: String(t.refresh_token), accessToken: String(t.access_token), expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000 };
  const profile = await apiJson<{ emailAddress: string }>(fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { token: tokens.accessToken! });
  tokens.email = profile.emailAddress.toLowerCase();
  return tokens;
}

export class GoogleTokenSource {
  constructor(
    private fetchImpl: Fetch,
    private app: Pick<OAuthAppConfig, 'clientId' | 'clientSecret'>,
    public tokens: OAuthTokens,
    private onRefresh?: (t: OAuthTokens) => Promise<void>,
  ) {}
  async token(): Promise<string> {
    if (this.tokens.accessToken && (this.tokens.expiresAt ?? 0) > Date.now() + 60_000) return this.tokens.accessToken;
    const t = await postForm(this.fetchImpl, 'https://oauth2.googleapis.com/token', { refresh_token: this.tokens.refreshToken, client_id: this.app.clientId, client_secret: this.app.clientSecret, grant_type: 'refresh_token' });
    this.tokens = { ...this.tokens, accessToken: String(t.access_token), expiresAt: Date.now() + Number(t.expires_in ?? 3600) * 1000 };
    await this.onRefresh?.(this.tokens);
    return this.tokens.accessToken!;
  }
}

/** Gmail: send raw RFC 822 (keeps our Message-ID), read new inbox mail via the history API. */
export class GmailProvider implements MailProvider, InboundProvider {
  readonly kind = 'gmail' as const;
  constructor(
    private fetchImpl: Fetch,
    private src: GoogleTokenSource,
  ) {}

  async send(msg: OutboundMessage): Promise<SendResult> {
    const raw = buildRfc822(msg);
    const res = await apiJson<{ id: string; threadId: string }>(this.fetchImpl, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', token: await this.src.token(), body: JSON.stringify({ raw: b64url(raw) }) });
    return { providerMessageId: res.id, threadId: res.threadId, accepted: msg.to, rejected: [] };
  }

  async sync(cursor: SyncCursor | null): Promise<{ messages: InboundMessage[]; cursor: SyncCursor }> {
    const token = await this.src.token();
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
    if (!cursor?.historyId) {
      const profile = await apiJson<{ historyId: string }>(this.fetchImpl, `${base}/profile`, { token });
      return { messages: [], cursor: { historyId: profile.historyId } };
    }
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = String(cursor.historyId);
    try {
      do {
        const u = new URL(`${base}/history`);
        u.searchParams.set('startHistoryId', String(cursor.historyId));
        u.searchParams.set('historyTypes', 'messageAdded');
        u.searchParams.set('labelId', 'INBOX');
        if (pageToken) u.searchParams.set('pageToken', pageToken);
        const page = await apiJson<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; nextPageToken?: string; historyId?: string }>(this.fetchImpl, u.toString(), { token });
        for (const h of page.history ?? []) for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
        if (page.historyId) latest = page.historyId;
        pageToken = page.nextPageToken;
      } while (pageToken && ids.size < 200);
    } catch (e) {
      if ((e as { status?: number }).status === 404) {
        // history expired: re-anchor and fall back to recent inbox mail
        const list = await apiJson<{ messages?: Array<{ id: string }> }>(this.fetchImpl, `${base}/messages?q=${encodeURIComponent('in:inbox newer_than:2d')}&maxResults=100`, { token });
        for (const m of list.messages ?? []) ids.add(m.id);
        const profile = await apiJson<{ historyId: string }>(this.fetchImpl, `${base}/profile`, { token });
        latest = profile.historyId;
      } else throw e;
    }
    const messages: InboundMessage[] = [];
    for (const id of ids) {
      const full = await apiJson<{ id: string; threadId: string; raw: string }>(this.fetchImpl, `${base}/messages/${id}?format=raw`, { token });
      const parsed = await parseRfc822(Buffer.from(full.raw, 'base64url'), `gmail:${full.id}`);
      parsed.threadId = full.threadId;
      messages.push(parsed);
    }
    return { messages, cursor: { historyId: latest } };
  }
}
