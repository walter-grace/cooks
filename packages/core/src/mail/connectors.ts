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
import { users } from '@cooks/db';

/** Resolves a fresh provider token for a user from an identity broker (Clerk). */
export type BrokerTokenFn = (userId: string, provider: 'google' | 'microsoft' | 'hubspot') => Promise<OAuthTokens | null>;

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
  /** Clerk-managed tokens: refresh by asking the broker for the user's current token. */
  brokerToken?: BrokerTokenFn;
}

/** Persist refreshed tokens back to the encrypted credential blob. */
function persist(db: DbOrTx, kek: string | undefined, mailboxId: string, creds: MailboxCreds, key: 'google' | 'microsoft') {
  return async (t: OAuthTokens) => {
    if (!kek) return;
    await db.update(mailboxCredentials).set({ encrypted: encrypt(JSON.stringify({ ...creds, [key]: t }), kek) }).where(eq(mailboxCredentials.mailboxId, mailboxId));
  };
}

const NO_APP = { clientId: '', clientSecret: '' };
const brokerRefresher = (d: { brokerToken?: BrokerTokenFn }, userId: string, provider: 'google' | 'microsoft') => async (): Promise<OAuthTokens> => {
  const t = await d.brokerToken?.(userId, provider);
  if (!t) throw new Error(`No ${provider} token available from the identity provider for this user; reconnect the account.`);
  return t;
};

export function outboundProviderFor(d: ConnectorDeps, mailbox: typeof mailboxes.$inferSelect, creds: MailboxCreds | null): MailProvider {
  const f = d.fetchImpl ?? fetch;
  if (mailbox.provider === 'gmail' && creds?.google && (d.apps.google || creds.google.viaClerk)) return new GmailProvider(f, new GoogleTokenSource(f, d.apps.google ?? NO_APP, creds.google, persist(d.db, d.kek, mailbox.id, creds, 'google'), creds.google.viaClerk ? brokerRefresher(d, mailbox.userId, 'google') : undefined));
  if (mailbox.provider === 'ms_graph' && creds?.microsoft && (d.apps.microsoft || creds.microsoft.viaClerk)) return new MicrosoftGraphProvider(f, new MicrosoftTokenSource(f, d.apps.microsoft ?? NO_APP, creds.microsoft, persist(d.db, d.kek, mailbox.id, creds, 'microsoft'), 'common', creds.microsoft.viaClerk ? brokerRefresher(d, mailbox.userId, 'microsoft') : undefined));
  if (creds?.smtpUrl) return new SmtpProvider(creds.smtpUrl);
  return d.fallback;
}

/** Register inbound factories for Gmail and Graph so `syncMailbox` can read those inboxes. */
export function registerOAuthInbound(d: Omit<ConnectorDeps, 'fallback'>) {
  const f = d.fetchImpl ?? fetch;
  registerInboundProvider('gmail', (mb, creds) => (creds.google && (d.apps.google || creds.google.viaClerk) ? new GmailProvider(f, new GoogleTokenSource(f, d.apps.google ?? NO_APP, creds.google, persist(d.db, d.kek, mb.id, creds, 'google'), creds.google.viaClerk ? brokerRefresher(d, mb.userId, 'google') : undefined)) : null));
  registerInboundProvider('ms_graph', (mb, creds) => (creds.microsoft && (d.apps.microsoft || creds.microsoft.viaClerk) ? new MicrosoftGraphProvider(f, new MicrosoftTokenSource(f, d.apps.microsoft ?? NO_APP, creds.microsoft, persist(d.db, d.kek, mb.id, creds, 'microsoft'), 'common', creds.microsoft.viaClerk ? brokerRefresher(d, mb.userId, 'microsoft') : undefined)) : null));
}
export { users as _usersForBroker };
