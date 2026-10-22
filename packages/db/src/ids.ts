import { randomBytes } from 'node:crypto';

let lastMs = 0;
let seq = 0;

/**
 * RFC 9562 UUIDv7: 48-bit unix ms, 12-bit monotonic sequence, 62 random bits.
 * Time-ordered so (created_at, id) keyset cursors stay stable.
 */
export function uuidv7(now: number = Date.now()): string {
  if (now === lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) now = ++lastMs;
  } else {
    lastMs = now;
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  const b = Buffer.alloc(16);
  b.writeUIntBE(now, 0, 6);
  b.writeUInt16BE(0x7000 | seq, 6);
  randomBytes(8).copy(b, 8);
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
