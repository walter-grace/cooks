/**
 * Twilio does not sign the Media Streams WebSocket upgrade, so the TwiML carries a short-lived
 * HMAC token as a <Parameter>. The socket is accepted only when the `start` message echoes a
 * valid token for that workspace, session and line.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface StreamClaims {
  ws: string;
  session: string;
  line: string;
  /** Unix seconds. */
  exp: number;
}

const b64u = (b: Buffer) => b.toString('base64url');
const sig = (secret: string, c: StreamClaims) => b64u(createHmac('sha256', secret).update(`${c.ws}.${c.session}.${c.line}.${c.exp}`).digest());

export function mintStreamToken(secret: string, c: StreamClaims): string {
  return `${c.exp}.${sig(secret, c)}`;
}

/** Returns the claims when the token matches and has not expired, else null. */
export function verifyStreamToken(secret: string, token: string | undefined, c: Omit<StreamClaims, 'exp'>, nowSeconds = Math.floor(Date.now() / 1000)): StreamClaims | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const exp = Number(token.slice(0, dot));
  if (!Number.isFinite(exp) || exp < nowSeconds) return null;
  const claims = { ...c, exp };
  const expected = Buffer.from(sig(secret, claims));
  const got = Buffer.from(token.slice(dot + 1));
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;
  return claims;
}
