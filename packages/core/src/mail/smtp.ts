import nodemailer, { type Transporter } from 'nodemailer';
import type { MailProvider, OutboundMessage, SendResult } from './provider.js';

/** SMTP via nodemailer. In dev point SMTP_URL at Mailpit (smtp://localhost:1025). */
export class SmtpProvider implements MailProvider {
  readonly kind = 'smtp' as const;
  private transporter: Transporter;
  constructor(url: string) {
    this.transporter = nodemailer.createTransport(url);
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
