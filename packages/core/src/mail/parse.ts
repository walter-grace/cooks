import { simpleParser, type ParsedMail } from 'mailparser';
import type { InboundMessage } from './provider.js';

const addr = (a: ParsedMail['from']) => (a && 'value' in a && a.value[0]?.address ? a.value[0].address.toLowerCase() : '');
const addrs = (a: ParsedMail['to']) => {
  const list = Array.isArray(a) ? a : a ? [a] : [];
  return list.flatMap((x) => x.value.map((v) => (v.address ?? '').toLowerCase()).filter(Boolean));
};
const AUTO_SUBJECT = /\b(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|abwesenheit|absence|vacation)\b/i;

/** Parse an RFC 822 message into the provider-neutral inbound shape, detecting DSNs and auto-replies. */
export async function parseRfc822(raw: Buffer | string, providerId: string): Promise<InboundMessage> {
  const m = await simpleParser(raw);
  const headers: Record<string, string> = {};
  for (const [k, v] of m.headers) headers[k.toLowerCase()] = typeof v === 'string' ? v : Array.isArray(v) ? v.map(String).join(', ') : JSON.stringify(v);
  const refs = (typeof m.references === 'string' ? [m.references] : (m.references ?? [])).map((r) => r.trim());
  const from = addr(m.from);
  const text = m.text ?? (m.html ? String(m.html).replace(/<[^>]+>/g, ' ') : '');
  const autoSubmitted =
    (headers['auto-submitted'] !== undefined && headers['auto-submitted'] !== 'no') ||
    'x-autoreply' in headers ||
    'x-autorespond' in headers ||
    /\b(auto_reply|bulk|junk)\b/i.test(headers['precedence'] ?? '') ||
    AUTO_SUBJECT.test(m.subject ?? '');
  const dsn = extractDsn(m, headers, from, text);
  return {
    providerId,
    messageId: m.messageId ?? null,
    inReplyTo: m.inReplyTo ?? null,
    references: refs,
    from,
    to: addrs(m.to),
    date: m.date ?? new Date(),
    subject: m.subject ?? '',
    text,
    html: m.html ? String(m.html) : null,
    headers,
    autoSubmitted,
    dsn,
  };
}

function extractDsn(m: ParsedMail, headers: Record<string, string>, from: string, text: string): InboundMessage['dsn'] {
  const isReport = /report-type=delivery-status/i.test(headers['content-type'] ?? '') || m.attachments.some((a) => a.contentType === 'message/delivery-status');
  const daemon = /^(mailer-daemon|postmaster)@/i.test(from) || /\b(undeliverable|delivery (status notification|failure)|returned mail|mail delivery failed)\b/i.test(m.subject ?? '');
  if (!isReport && !daemon) return null;
  const body = m.attachments.find((a) => a.contentType === 'message/delivery-status')?.content.toString('utf8') ?? text;
  const pick = (re: RegExp) => re.exec(body)?.[1]?.trim() ?? null;
  const status = pick(/^Status:\s*([245]\.\d+\.\d+)/im) ?? pick(/\b([245]\.\d\.\d)\b/) ?? (/\b5\d\d\b/.test(body) ? '5.0.0' : '4.0.0');
  const action = pick(/^Action:\s*(\w+)/im) ?? (status.startsWith('5') ? 'failed' : 'delayed');
  const recipient = (pick(/^(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*([^\s;]+)/im) ?? pick(/<?([\w.+-]+@[\w.-]+\.\w+)>?/))?.toLowerCase() ?? null;
  const originalMessageId = pick(/^Original-Message-ID:\s*(<[^>]+>)/im) ?? pick(/Message-ID:\s*(<[^>]+>)/i);
  const diagnostic = pick(/^Diagnostic-Code:\s*(.+)$/im);
  return { action, status, recipient, originalMessageId, diagnostic };
}

/** Pull a return date out of an out-of-office body ("back on March 9", "until 2026-03-09", "returning 03/09"). */
export function extractReturnDate(text: string, now: Date): Date | null {
  const t = text.slice(0, 4000);
  const iso = /\b(20\d\d-\d\d-\d\d)\b/.exec(t);
  if (iso) {
    const d = new Date(`${iso[1]}T00:00:00Z`);
    if (d > now) return d;
  }
  const us = /\b(?:back|return(?:ing)?|until|through|on)\s+(?:on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/i.exec(t);
  if (us) {
    const y = us[3] ? Number(us[3].length === 2 ? `20${us[3]}` : us[3]) : now.getUTCFullYear();
    const d = new Date(Date.UTC(y, Number(us[1]) - 1, Number(us[2])));
    if (d > now) return d;
  }
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const named = new RegExp(`\\b(?:back|return(?:ing)?|until|through|on)\\s+(?:on\\s+)?(?:\\w+day,?\\s+)?(${months.join('|')}|${months.map((m) => m.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d\\d))?`, 'i');
  const n = named.exec(t);
  if (n) {
    const mi = months.findIndex((m) => m.startsWith(n[1]!.toLowerCase().slice(0, 3)));
    const y = n[3] ? Number(n[3]) : now.getUTCFullYear();
    let d = new Date(Date.UTC(y, mi, Number(n[2])));
    if (d <= now && !n[3]) d = new Date(Date.UTC(y + 1, mi, Number(n[2])));
    if (d > now) return d;
  }
  return null;
}
