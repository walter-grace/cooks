import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signature format shared with the upstream contract:
 *   x-webhook-signature: t=<unix ms>,s=<base64 HMAC-SHA256(key, `${t}.${rawBody}`)>
 */
export function signWebhook(secret: string, rawBody: string, t: number = Date.now()): string {
  const s = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('base64');
  return `t=${t},s=${s}`;
}

export function verifyWebhookSignature(header: string | null | undefined, rawBody: string, secret: string, opts: { toleranceMs?: number; now?: number } = {}): boolean {
  if (!header) return false;
  // split on the first '=' only: base64 signatures may end in '=' padding
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as [string, string];
    }),
  );
  const t = Number(parts.t);
  const s = parts.s;
  if (!Number.isFinite(t) || !s) return false;
  const tolerance = opts.toleranceMs ?? 5 * 60_000;
  if (Math.abs((opts.now ?? Date.now()) - t) > tolerance) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('base64');
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
