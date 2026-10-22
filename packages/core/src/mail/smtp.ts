import nodemailer, { type Transporter } from 'nodemailer';
import type { MailProvider, OutboundMessage, SendResult } from './provider.js';

export interface SmtpTransportOptions {
  url: string;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

/**
 * Turn an smtp:// URL into nodemailer transport options.
 *
 * `localhost` is rewritten to `127.0.0.1`: Node 17+ returns `::1` first for localhost and most
 * dev relays (Mailpit, MailHog, Postfix defaults) only listen on IPv4, which made the first
 * send hang until the two-minute default connection timeout. Timeouts are also shortened so a
 * dead relay surfaces as a retryable error in seconds, not minutes.
 */
export function smtpTransportOptions(url: string): SmtpTransportOptions {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`SMTP_URL is not a valid URL: ${url.replace(/\/\/[^@]*@/, '//***@')}`);
  }
  if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
  return { url: u.toString(), connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 120_000 };
}

/** SMTP via nodemailer. In dev point SMTP_URL at Mailpit (smtp://127.0.0.1:1025). */
export class SmtpProvider implements MailProvider {
  readonly kind = 'smtp' as const;
  private transporter: Transporter;
  constructor(url: string) {
    this.transporter = nodemailer.createTransport(smtpTransportOptions(url) as never);
  }
  async verify() {
    await this.transporter.verify();
  }
  async send(msg: OutboundMessage): Promise<SendResult> {
    const info = await this.transporter.sendMail({
      from: msg.from,
      to: msg.to,
      cc: msg.cc,
      bcc: msg.bcc,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
      messageId: msg.messageId,
      inReplyTo: msg.inReplyTo,
      references: msg.references,
      headers: msg.headers,
    });
    return {
      providerMessageId: info.messageId ?? null,
      accepted: (info.accepted ?? []).map(String),
      rejected: (info.rejected ?? []).map(String),
    };
  }
}
