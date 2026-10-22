import { Liquid } from 'liquidjs';
import { DateTime } from 'luxon';

/**
 * Merge-field engine. Liquid is sandboxed (no JS helpers, no prototype access), strict
 * variables so a typo in a template blocks the send instead of mailing "Hi ,".
 */
const engine = new Liquid({ strictVariables: true, strictFilters: true, cache: true, jsTruthy: true });
engine.registerFilter('first_name_or', (v: unknown, fallback = 'there') => (typeof v === 'string' && v.trim() ? v.trim().split(/\s+/)[0] : fallback));
engine.registerFilter('titlecase', (v: unknown) => String(v ?? '').replace(/\w\S*/g, (w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()));
engine.registerFilter('date_fmt', (v: unknown, fmt = 'cccc') => {
  const d = v instanceof Date ? DateTime.fromJSDate(v) : DateTime.fromISO(String(v));
  return d.isValid ? d.toFormat(String(fmt)) : '';
});

export interface MergeContext {
  prospect: Record<string, unknown>;
  account: Record<string, unknown>;
  owner: Record<string, unknown>;
  sequence: Record<string, unknown>;
  step: Record<string, unknown>;
  now: Record<string, unknown>;
  unsubscribeUrl: string;
}

export class TemplateError extends Error {
  constructor(message: string, public readonly field: 'subject' | 'body') {
    super(message);
    this.name = 'TemplateError';
  }
}

export async function renderTemplate(subject: string, body: string, ctx: MergeContext): Promise<{ subject: string; html: string; text: string }> {
  let s: string;
  let h: string;
  try {
    s = (await engine.parseAndRender(subject, ctx)).trim();
  } catch (e) {
    throw new TemplateError(`Subject template failed: ${(e as Error).message}`, 'subject');
  }
  try {
    h = await engine.parseAndRender(body, ctx);
  } catch (e) {
    throw new TemplateError(`Body template failed: ${(e as Error).message}`, 'body');
  }
  return { subject: s, html: h, text: htmlToText(h) };
}

/** Good-enough plain-text alternative for multipart emails. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => (String(label).trim() === href ? href : `${String(label).trim()} (${href})`))
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildMergeContext(args: {
  prospect: { firstName?: string | null; lastName?: string | null; name?: string | null; title?: string | null; primaryEmail?: string | null; phone?: string | null; linkedInUrl?: string | null; city?: string | null; state?: string | null; country?: string | null; timezone?: string | null; crmCustomFields?: Record<string, unknown> };
  account?: { name?: string | null; domain?: string | null; website?: string | null; industry?: string | null; numEmployees?: number | null; city?: string | null; crmCustomFields?: Record<string, unknown> } | null;
  owner: { name?: string | null; email?: string | null; title?: string | null; phone?: string | null; calendarUrl?: string | null; signatureHtml?: string | null };
  sequence?: { name?: string | null } | null;
  step?: { order?: number | null; name?: string | null } | null;
  now: Date;
  tz: string;
  unsubscribeUrl: string;
}): MergeContext {
  const ownerParts = (args.owner.name ?? '').trim().split(/\s+/);
  const nowTz = DateTime.fromJSDate(args.now).setZone(args.tz);
  return {
    prospect: {
      firstName: args.prospect.firstName ?? (args.prospect.name ?? '').split(/\s+/)[0] ?? '',
      lastName: args.prospect.lastName ?? '',
      name: args.prospect.name ?? '',
      title: args.prospect.title ?? '',
      email: args.prospect.primaryEmail ?? '',
      phone: args.prospect.phone ?? '',
      linkedInUrl: args.prospect.linkedInUrl ?? '',
      city: args.prospect.city ?? '',
      state: args.prospect.state ?? '',
      country: args.prospect.country ?? '',
      timezone: args.prospect.timezone ?? '',
      custom: args.prospect.crmCustomFields ?? {},
    },
    account: {
      name: args.account?.name ?? '',
      domain: args.account?.domain ?? '',
      website: args.account?.website ?? '',
      industry: args.account?.industry ?? '',
      employeeCount: args.account?.numEmployees ?? '',
      city: args.account?.city ?? '',
      custom: args.account?.crmCustomFields ?? {},
    },
    owner: {
      firstName: ownerParts[0] ?? '',
      lastName: ownerParts.slice(1).join(' '),
      name: args.owner.name ?? '',
      email: args.owner.email ?? '',
      title: args.owner.title ?? '',
      phone: args.owner.phone ?? '',
      calendarUrl: args.owner.calendarUrl ?? '',
      signature: args.owner.signatureHtml ?? '',
    },
    sequence: { name: args.sequence?.name ?? '' },
    step: { order: args.step?.order ?? '', name: args.step?.name ?? '' },
    now: { date: nowTz.toISODate(), dayOfWeek: nowTz.toFormat('cccc'), month: nowTz.toFormat('LLLL'), year: nowTz.year },
    unsubscribeUrl: args.unsubscribeUrl,
  };
}
