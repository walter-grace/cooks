/** Wire Gmail / Microsoft providers into the mailbox credential model. */
import { eq } from 'drizzle-orm';
import { mailboxCredentials, type DbOrTx, type mailboxes } from '@cooks/db';
import { encrypt } from '../crypto.js';
import { GmailProvider, GoogleTokenSource } from './google.js';
import { MicrosoftGraphProvider, MicrosoftTokenSource } from './microsoft.js';
import type { Fetch, OAuthAppConfig, OAuthTokens } from './oauth-mail.js';
import { SmtpProvider } from './smtp.js';
import type { MailProvider } from './provider.js';
import { registerInboundProvider, type MailboxCreds } from './sync.js';

export interface ConnectorApps {
  google?: Pick<OAuthAppConfig, 'clientId' | 'clientSecret'>;
  microsoft?: Pick<OAuthAppConfig, 'clientId' | 'clientSecret'>;
}

export interface ConnectorDeps {
  db: DbOrTx;
  kek?: string;
  apps: ConnectorApps;
  fetchImpl?: Fetch;
  /** Default relay for SMTP mailboxes without their own credentials. */
  fallback: MailProvider;
}

/** Persist refreshed tokens back to the encrypted credential blob. */
function persist(db: DbOrTx, kek: string | undefined, mailboxId: string, creds: MailboxCreds, key: 'google' | 'microsoft') {
  return async (t: OAuthTokens) => {
    if (!kek) return;
    await db.update(mailboxCredentials).set({ encrypted: encrypt(JSON.stringify({ ...creds, [key]: t }), kek) }).where(eq(mailboxCredentials.mailboxId, mailboxId));
  };
}

export function outboundProviderFor(d: ConnectorDeps, mailbox: typeof mailboxes.$inferSelect, creds: MailboxCreds | null): MailProvider {
  const f = d.fetchImpl ?? fetch;
  if (mailbox.provider === 'gmail' && creds?.google && d.apps.google) return new GmailProvider(f, new GoogleTokenSource(f, d.apps.google, creds.google, persist(d.db, d.kek, mailbox.id, creds, 'google')));
  if (mailbox.provider === 'ms_graph' && creds?.microsoft && d.apps.microsoft) return new MicrosoftGraphProvider(f, new MicrosoftTokenSource(f, d.apps.microsoft, creds.microsoft, persist(d.db, d.kek, mailbox.id, creds, 'microsoft')));
  if (creds?.smtpUrl) return new SmtpProvider(creds.smtpUrl);
  return d.fallback;
}

/** Register inbound factories for Gmail and Graph so `syncMailbox` can read those inboxes. */
export function registerOAuthInbound(d: Omit<ConnectorDeps, 'fallback'>) {
  const f = d.fetchImpl ?? fetch;
  registerInboundProvider('gmail', (mb, creds) => (creds.google && d.apps.google ? new GmailProvider(f, new GoogleTokenSource(f, d.apps.google, creds.google, persist(d.db, d.kek, mb.id, creds, 'google'))) : null));
  registerInboundProvider('ms_graph', (mb, creds) => (creds.microsoft && d.apps.microsoft ? new MicrosoftGraphProvider(f, new MicrosoftTokenSource(f, d.apps.microsoft, creds.microsoft, persist(d.db, d.kek, mb.id, creds, 'microsoft'))) : null));
}
