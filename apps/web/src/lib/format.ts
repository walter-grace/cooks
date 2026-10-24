/**
 * One place for every figure the UI prints. Locale-aware, grouped, and consistent about units,
 * so a cost reads "$1,234.50" everywhere and a share reads "42%" everywhere.
 */
const ints = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const cache = new Map<string, Intl.NumberFormat>();
const nf = (min: number, max: number) => {
  const k = `${min}:${max}`;
  let f = cache.get(k);
  if (!f) cache.set(k, (f = new Intl.NumberFormat(undefined, { minimumFractionDigits: min, maximumFractionDigits: max })));
  return f;
};
const money = new Map<string, Intl.NumberFormat>();

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Whole number with thousands grouping: 12,480. */
export const fmtInt = (v: unknown, empty = '—') => {
  const n = num(v);
  return n === null ? empty : ints.format(Math.round(n));
};

/** Up to `max` decimals, trailing zeros dropped: 2.5, 7, 0.25. */
export const fmtNum = (v: unknown, max = 1, empty = '—') => {
  const n = num(v);
  return n === null ? empty : nf(0, max).format(n);
};

/** Fixed decimals: 4.0, 3.75. */
export const fmtFixed = (v: unknown, digits = 1, empty = '—') => {
  const n = num(v);
  return n === null ? empty : nf(digits, digits).format(n);
};

/** Currency with two decimals: $0.08, $1,250.00. */
export const fmtMoney = (v: unknown, currency = 'USD', empty = '—') => {
  const n = num(v);
  if (n === null) return empty;
  let f = money.get(currency);
  if (!f) money.set(currency, (f = new Intl.NumberFormat(undefined, { style: 'currency', currency })));
  return f.format(n);
};

/** A 0..1 share as a percentage: 0.4231 → 42%. */
export const fmtPct = (fraction: unknown, max = 0, empty = '—') => {
  const n = num(fraction);
  return n === null ? empty : `${nf(0, max).format(n * 100)}%`;
};

/** A percentage that is already 0..100: 2.5 → 2.5%. */
export const fmtPctValue = (pct: unknown, max = 1, empty = '—') => {
  const n = num(pct);
  return n === null ? empty : `${nf(0, max).format(n)}%`;
};

/** Seconds as a short quantity: 1.2 s, 45 s. */
export const fmtSeconds = (v: unknown, max = 1, empty = '—') => {
  const n = num(v);
  return n === null ? empty : `${nf(0, max).format(n)} s`;
};

/** Clock duration: 0:07, 12:30, 1:02:15. */
export const fmtDuration = (s: number | null | undefined) => {
  const n = Math.max(0, Math.round(s ?? 0));
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const sec = String(n % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

/** A wait expressed in minutes: immediately, 45 min, 3 h, 2 d, 1.5 d. */
export const fmtWait = (minutes: number | null | undefined) => {
  const m = num(minutes) ?? 0;
  if (m <= 0) return 'immediately';
  if (m < 60) return `${fmtInt(m)} min`;
  if (m < 1440) return `${fmtNum(m / 60, 1)} h`;
  return `${fmtNum(m / 1440, 1)} d`;
};

/** Count with its noun: 1 step, 12 steps, 2 identities. */
export const plural = (v: unknown, one: string, many = `${one}s`) => {
  const n = num(v) ?? 0;
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
};

const ACTION_LABEL: Record<string, string> = {
  auto_email: 'Auto email',
  manual_email: 'Email',
  manual_email_reply: 'Email reply',
  call: 'Call',
  manual_call: 'Call',
  manual_linkedin_connection_request: 'LinkedIn request',
  manual_linkedin_message: 'LinkedIn message',
  manual_linkedin_view_profile: 'LinkedIn view',
  linkedin_connection_request: 'LinkedIn request',
  linkedin_message: 'LinkedIn message',
  manual_sms: 'Text',
  manual_whatsapp: 'WhatsApp',
  manual_task: 'Task',
};

/** Sequence step or task action as a short label: manual_linkedin_connection_request → LinkedIn request. */
export const actionLabel = (action: string | null | undefined) => (action ? ACTION_LABEL[action] ?? action.replace(/_/g, ' ') : '');
