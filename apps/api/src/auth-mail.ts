/**
 * Mail the API sends on its own behalf: verification links, password resets, invites.
 * Resend when RESEND_API_KEY is set, otherwise the server SMTP relay; tests inject a recorder.
 */
import { randomUUID } from 'node:crypto';
import { SmtpProvider } from '@cooks/core';

export interface AuthMail {
  to: string;
  subject: string;
  text: string;
}
export interface AuthMailer {
  send(mail: AuthMail): Promise<void>;
}

export class MemoryAuthMailer implements AuthMailer {
  public sent: AuthMail[] = [];
  async send(mail: AuthMail) {
    this.sent.push(mail);
  }
}

const escape = (s: string) => s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch]!);
const asHtml = (text: string) =>
  `<div style="font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;max-width:560px">${text
    .split('\n\n')
    .map((p) => `<p>${escape(p).replace(/(https?:\/\/\S+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</p>`)
    .join('')}</div>`;

export class SmtpAuthMailer implements AuthMailer {
  private smtp: SmtpProvider;
  constructor(
    url: string,
    private from: string,
    private domain: string,
  ) {
    this.smtp = new SmtpProvider(url);
  }
  async send(mail: AuthMail) {
    await this.smtp.send({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text, html: asHtml(mail.text), messageId: `<${randomUUID()}@${this.domain}>` });
  }
}

export class ResendAuthMailer implements AuthMailer {
  constructor(
    private apiKey: string,
    private from: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async send(mail: AuthMail) {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [mail.to], subject: mail.subject, text: mail.text, html: asHtml(mail.text) }),
    });
    if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

/** Pick a mailer from the environment. `from` defaults to no-reply at the public host. */
export function authMailerFrom(env: { RESEND_API_KEY?: string; SMTP_URL?: string; COOKS_MAIL_FROM?: string; COOKS_PUBLIC_URL: string }, fetchImpl?: typeof fetch): { mailer: AuthMailer; from: string } {
  const host = new URL(env.COOKS_PUBLIC_URL).hostname;
  const from = env.COOKS_MAIL_FROM ?? `Cooks <no-reply@${host}>`;
  if (env.RESEND_API_KEY) return { mailer: new ResendAuthMailer(env.RESEND_API_KEY, from, fetchImpl), from };
  return { mailer: new SmtpAuthMailer(env.SMTP_URL ?? 'smtp://127.0.0.1:1025', from, host), from };
}
