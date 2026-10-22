import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import { sessions, users, type DbOrTx } from '@cooks/db';

export const SESSION_COOKIE = 'cooks_session';
const TTL_MS = 30 * 24 * 60 * 60_000;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(db: DbOrTx, userId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + TTL_MS);
  await db.insert(sessions).values({ userId, tokenHash: sha256(token), expiresAt });
  return { token, expiresAt };
}

export async function getSessionUser(db: DbOrTx, token: string | undefined, now = new Date()) {
  if (!token) return null;
  const [row] = await db
    .select({ u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, sha256(token)), gt(sessions.expiresAt, now)))
    .limit(1);
  return row?.u ?? null;
}

export async function destroySession(db: DbOrTx, token: string | undefined) {
  if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
}
