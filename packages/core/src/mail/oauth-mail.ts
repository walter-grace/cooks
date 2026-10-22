/**
 * Shared pieces for mailbox providers that authenticate with OAuth (Google, Microsoft).
 * Tokens live in mailbox_credentials (encrypted). Access tokens are refreshed on demand.
 */
export interface OAuthTokens {
  /** Empty when the token is managed elsewhere (Clerk) and refreshed through `refresher`. */
  refreshToken: string;
  viaClerk?: boolean;
  accessToken?: string;
  expiresAt?: number;
  email?: string;
}

export interface OAuthAppConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export type Fetch = typeof fetch;

export async function postForm(fetchImpl: Fetch, url: string, body: Record<string, string>, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(body).toString() });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${url} → ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

export async function apiJson<T>(fetchImpl: Fetch, url: string, init: RequestInit & { token: string }): Promise<T> {
  const { token, ...rest } = init;
  const res = await fetchImpl(url, { ...rest, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(rest.body && !(rest.headers as Record<string, string> | undefined)?.['content-type'] ? { 'content-type': 'application/json' } : {}), ...(rest.headers as Record<string, string> | undefined) } });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  if (!res.ok) {
    const err = new Error(`${init.method ?? 'GET'} ${url} → ${res.status} ${typeof json === 'string' ? json.slice(0, 300) : JSON.stringify(json).slice(0, 300)}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return json as T;
}

/** Build an RFC 822 message (headers + multipart/alternative) without extra dependencies. */
export function buildRfc822(m: { from: string; to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html: string; messageId: string; inReplyTo?: string; references?: string[]; headers?: Record<string, string> }): string {
  const boundary = `cooks-${Math.random().toString(36).slice(2)}`;
  const enc = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
  const lines = [
    `From: ${m.from}`,
    `To: ${m.to.join(', ')}`,
    ...(m.cc?.length ? [`Cc: ${m.cc.join(', ')}`] : []),
    ...(m.bcc?.length ? [`Bcc: ${m.bcc.join(', ')}`] : []),
    `Subject: ${enc(m.subject)}`,
    `Message-ID: ${m.messageId}`,
    `Date: ${new Date().toUTCString()}`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`] : []),
    ...(m.references?.length ? [`References: ${m.references.join(' ')}`] : []),
    ...Object.entries(m.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(m.html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

export const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');
