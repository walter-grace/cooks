import { and, eq, isNull } from 'drizzle-orm';
import { apiKeys, workspaceMembers, type DbOrTx } from '@cooks/db';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function b62(len: number): string {
  const bytes = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += B62[bytes[i]! % 62];
  return s;
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export type KeyPrefix = 'cooks' | 'nooks';

/** `<prefix>-api-<keyId 12>-<secret 40>` */
export function formatApiKey(prefix: KeyPrefix, keyId: string, secret: string): string {
  return `${prefix}-api-${keyId}-${secret}`;
}

export interface ParsedApiKey {
  prefix: KeyPrefix;
  keyId: string;
  secret: string;
}

export function parseApiKey(token: string): ParsedApiKey | null {
  const m = /^(cooks|nooks)-api-([0-9A-Za-z]{12})-([0-9A-Za-z]{40})$/.exec(token.trim());
  if (!m) return null;
  return { prefix: m[1] as KeyPrefix, keyId: m[2]!, secret: m[3]! };
}

export function looksLikeApiKey(token: string): boolean {
  return /^(cooks|nooks)-api-/.test(token);
}

export async function createApiKey(
  db: DbOrTx,
  args: { workspaceId: string; name: string; createdBy?: string | null; prefix?: KeyPrefix },
): Promise<{ id: string; keyId: string; token: string }> {
  const prefix = args.prefix ?? 'cooks';
  const keyId = b62(12);
  const secret = b62(40);
  const [row] = await db
    .insert(apiKeys)
    .values({ workspaceId: args.workspaceId, keyId, secretHash: sha256(secret), prefix, name: args.name, createdBy: args.createdBy ?? null })
    .returning({ id: apiKeys.id });
  return { id: row!.id, keyId, token: formatApiKey(prefix, keyId, secret) };
}

export interface VerifiedApiKey {
  apiKeyId: string;
  workspaceId: string;
  keyId: string;
  name: string;
}

export async function verifyApiKey(
  db: DbOrTx,
  token: string,
  opts: { acceptNooksPrefix: boolean },
): Promise<VerifiedApiKey | null> {
  const parsed = parseApiKey(token);
  if (!parsed) return null;
  if (parsed.prefix === 'nooks' && !opts.acceptNooksPrefix) return null;
  const [row] = await db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.keyId, parsed.keyId), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;
  const a = Buffer.from(row.secretHash, 'hex');
  const b = Buffer.from(sha256(parsed.secret), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  // fire-and-forget last_used_at bump (best effort, never blocks the request)
  void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id)).catch(() => {});
  return { apiKeyId: row.id, workspaceId: row.workspaceId, keyId: row.keyId, name: row.name };
}

export async function revokeApiKey(db: DbOrTx, workspaceId: string, id: string): Promise<boolean> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
    .returning({ id: apiKeys.id });
  return rows.length > 0;
}

export async function memberRole(db: DbOrTx, workspaceId: string, userId: string) {
  const [m] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return m?.role ?? null;
}
