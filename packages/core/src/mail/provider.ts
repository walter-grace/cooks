export interface OutboundMessage {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  html: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string | null;
  threadId?: string | null;
  /** Providers that assign their own Message-ID (Microsoft Graph) report it here so replies can be matched. */
  messageId?: string | null;
  accepted: string[];
  rejected: string[];
}

export interface InboundMessage {
  providerId: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadId?: string | null;
  from: string;
  to: string[];
  date: Date;
  subject: string;
  text: string;
  html: string | null;
  headers: Record<string, string>;
  autoSubmitted: boolean;
  dsn: { action: string; status: string; recipient: string | null; originalMessageId: string | null; diagnostic: string | null } | null;
}

export type SyncCursor = Record<string, unknown>;

export interface InboundProvider {
  /** Fetch messages newer than the cursor. Returns the messages and the cursor to persist. */
  sync(cursor: SyncCursor | null): Promise<{ messages: InboundMessage[]; cursor: SyncCursor }>;
}

export interface MailProvider {
  readonly kind: 'smtp' | 'gmail' | 'ms_graph' | 'memory' | 'inkbox';
  send(msg: OutboundMessage): Promise<SendResult>;
  verify?(): Promise<void>;
}

/** Records messages instead of sending. Used by tests and `COOKS_MAIL_DRY_RUN`. */
export class MemoryMailProvider implements MailProvider {
  readonly kind = 'memory' as const;
  public sent: OutboundMessage[] = [];
  public failNext: Error | null = null;
  async send(msg: OutboundMessage): Promise<SendResult> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.sent.push(msg);
    return { providerMessageId: `mem-${this.sent.length}`, accepted: msg.to, rejected: [] };
  }
}

/** Resolves the provider for a mailbox. */
export type ProviderResolver = (mailbox: { id: string; provider: string; email: string } | null) => Promise<MailProvider>;
