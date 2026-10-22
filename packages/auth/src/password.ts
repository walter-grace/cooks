import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number }) => Promise<Buffer>;
const N = 16384;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32, { N, r: 8, p: 1 });
  return `scrypt$${N}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !n || !saltB64 || !hashB64) return false;
  const hash = await scrypt(password, Buffer.from(saltB64, 'base64url'), 32, { N: Number(n), r: 8, p: 1 });
  const expected = Buffer.from(hashB64, 'base64url');
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
