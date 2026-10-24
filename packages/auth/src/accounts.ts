/**
 * Self-serve accounts: sign-up that creates a workspace, email verification, password reset and
 * workspace invites. Links are one-time tokens; only their hash is stored.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { authTokens, sessions, users, workspaceMembers, workspaces, type DbOrTx } from '@cooks/db';
import { hashPassword } from './password.js';

export type SignupMode = 'open' | 'invite' | 'off';
export type TokenKind = 'verify' | 'reset' | 'invite';
export type MemberRole = 'user' | 'manager' | 'admin';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const TTL: Record<TokenKind, number> = { verify: 3 * 24 * 60 * 60_000, reset: 60 * 60_000, invite: 7 * 24 * 60 * 60_000 };

export class AccountError extends Error {
  constructor(
    public code: 'EMAIL_TAKEN' | 'INVALID_TOKEN' | 'WEAK_PASSWORD' | 'INVALID_EMAIL' | 'ALREADY_MEMBER',
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function assertEmail(e: string) {
  if (!EMAIL_RE.test(e) || e.length > 254) throw new AccountError('INVALID_EMAIL', 'Enter a valid email address', 400);
}
export function assertPassword(p: string) {
  if (typeof p !== 'string' || p.length < 10) throw new AccountError('WEAK_PASSWORD', 'Use at least 10 characters', 400);
  if (p.length > 200) throw new AccountError('WEAK_PASSWORD', 'That password is too long', 400);
}

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'workspace';

/* ------------------------------------------------------------------ tokens */

export async function issueToken(
  db: DbOrTx,
  t: { kind: TokenKind; email: string; userId?: string | null; workspaceId?: string | null; role?: MemberRole | null; invitedBy?: string | null },
  now = new Date(),
): Promise<{ token: string; id: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + TTL[t.kind]);
  const [row] = await db
    .insert(authTokens)
    .values({ kind: t.kind, tokenHash: sha256(token), email: normalizeEmail(t.email), userId: t.userId ?? null, workspaceId: t.workspaceId ?? null, role: t.role ?? null, invitedBy: t.invitedBy ?? null, expiresAt })
    .returning({ id: authTokens.id });
  return { token, id: row!.id, expiresAt };
}

export async function peekToken(db: DbOrTx, kind: TokenKind, token: string, now = new Date()) {
  if (!token) return null;
  const [row] = await db
    .select()
    .from(authTokens)
    .where(and(eq(authTokens.kind, kind), eq(authTokens.tokenHash, sha256(token)), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .limit(1);
  return row ?? null;
}

async function consumeToken(db: DbOrTx, kind: TokenKind, token: string, now = new Date()) {
  const row = await peekToken(db, kind, token, now);
  if (!row) throw new AccountError('INVALID_TOKEN', 'This link is invalid or has expired', 400);
  await db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, row.id));
  return row;
}

/* ------------------------------------------------------------------ sign-up */

export async function findUserByEmail(db: DbOrTx, email: string) {
  const [u] = await db.select().from(users).where(eq(sql`lower(${users.email})`, normalizeEmail(email))).limit(1);
  return u ?? null;
}

async function uniqueSlug(db: DbOrTx, base: string) {
  for (let i = 0; i < 20; i++) {
    const slug = i === 0 ? base : `${base}-${randomBytes(2).toString('hex')}`;
    const [hit] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    if (!hit) return slug;
  }
  return `${base}-${randomBytes(4).toString('hex')}`;
}

/** Create a user, a workspace and the admin membership. Fails with EMAIL_TAKEN when the address is in use. */
export async function createAccount(db: DbOrTx, input: { email: string; name: string; password: string; workspaceName: string }, now = new Date()) {
  const email = normalizeEmail(input.email);
  assertEmail(email);
  assertPassword(input.password);
  const name = input.name.trim() || email.split('@')[0]!;
  const wsName = input.workspaceName.trim() || `${name}'s team`;
  if (await findUserByEmail(db, email)) throw new AccountError('EMAIL_TAKEN', 'An account with that email already exists. Sign in instead.', 409);
  const passwordHash = await hashPassword(input.password);
  const slug = await uniqueSlug(db, slugify(wsName));
  const [user] = await db.insert(users).values({ email, name, passwordHash, createdAt: now, updatedAt: now }).returning();
  const [workspace] = await db.insert(workspaces).values({ name: wsName, slug, createdAt: now, updatedAt: now }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId: user!.id, role: 'admin' });
  return { user: user!, workspace: workspace! };
}

export async function verifyEmail(db: DbOrTx, token: string, now = new Date()) {
  const row = await consumeToken(db, 'verify', token, now);
  if (!row.userId) throw new AccountError('INVALID_TOKEN', 'This link is invalid', 400);
  await db.update(users).set({ emailVerifiedAt: now, updatedAt: now }).where(eq(users.id, row.userId));
  return row.userId;
}

/* ------------------------------------------------------------------ password reset */

export async function resetPassword(db: DbOrTx, token: string, password: string, now = new Date()) {
  assertPassword(password);
  const row = await consumeToken(db, 'reset', token, now);
  if (!row.userId) throw new AccountError('INVALID_TOKEN', 'This link is invalid', 400);
  await db.update(users).set({ passwordHash: await hashPassword(password), emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now})`, updatedAt: now }).where(eq(users.id, row.userId));
  // every other browser is signed out
  await db.delete(sessions).where(eq(sessions.userId, row.userId));
  return row.userId;
}

/* ------------------------------------------------------------------ invites */

export async function createInvite(db: DbOrTx, input: { workspaceId: string; email: string; role: MemberRole; invitedBy: string }, now = new Date()) {
  const email = normalizeEmail(input.email);
  assertEmail(email);
  const existing = await findUserByEmail(db, email);
  if (existing) {
    const [m] = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, input.workspaceId), eq(workspaceMembers.userId, existing.id))).limit(1);
    if (m) throw new AccountError('ALREADY_MEMBER', 'That person is already in the workspace', 409);
  }
  // one live invite per address and workspace
  await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.kind, 'invite'), eq(authTokens.workspaceId, input.workspaceId), eq(sql`lower(${authTokens.email})`, email), isNull(authTokens.usedAt)));
  return issueToken(db, { kind: 'invite', email, workspaceId: input.workspaceId, role: input.role, invitedBy: input.invitedBy, userId: existing?.id ?? null }, now);
}

export async function listInvites(db: DbOrTx, workspaceId: string, now = new Date()) {
  return db
    .select({ id: authTokens.id, email: authTokens.email, role: authTokens.role, invitedBy: authTokens.invitedBy, expiresAt: authTokens.expiresAt, createdAt: authTokens.createdAt })
    .from(authTokens)
    .where(and(eq(authTokens.kind, 'invite'), eq(authTokens.workspaceId, workspaceId), isNull(authTokens.usedAt), gt(authTokens.expiresAt, now)))
    .orderBy(desc(authTokens.createdAt));
}

export async function revokeInvite(db: DbOrTx, workspaceId: string, id: string, now = new Date()) {
  const r = await db
    .update(authTokens)
    .set({ usedAt: now })
    .where(and(eq(authTokens.id, id), eq(authTokens.kind, 'invite'), eq(authTokens.workspaceId, workspaceId), isNull(authTokens.usedAt)))
    .returning({ id: authTokens.id });
  return r.length > 0;
}

/** What an invite link shows before the person commits. */
export async function describeInvite(db: DbOrTx, token: string, now = new Date()) {
  const row = await peekToken(db, 'invite', token, now);
  if (!row || !row.workspaceId) return null;
  const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, row.workspaceId)).limit(1);
  const existing = await findUserByEmail(db, row.email);
  return { email: row.email, role: row.role ?? 'user', workspaceName: ws?.name ?? 'the workspace', existingUser: !!existing };
}

/** Accept an invite: a new address gets a user (name + password required); an existing one just joins. */
export async function acceptInvite(db: DbOrTx, token: string, input: { name?: string; password?: string }, now = new Date()) {
  const peek = await peekToken(db, 'invite', token, now);
  if (!peek || !peek.workspaceId) throw new AccountError('INVALID_TOKEN', 'This invite is invalid or has expired', 400);
  let user = await findUserByEmail(db, peek.email);
  if (!user) {
    assertPassword(input.password ?? '');
    const name = (input.name ?? '').trim() || peek.email.split('@')[0]!;
    const [created] = await db.insert(users).values({ email: peek.email, name, passwordHash: await hashPassword(input.password!), emailVerifiedAt: now, createdAt: now, updatedAt: now }).returning();
    user = created!;
  }
  const [m] = await db.select({ id: workspaceMembers.id }).from(workspaceMembers).where(and(eq(workspaceMembers.workspaceId, peek.workspaceId), eq(workspaceMembers.userId, user!.id))).limit(1);
  if (!m) await db.insert(workspaceMembers).values({ workspaceId: peek.workspaceId, userId: user!.id, role: peek.role ?? 'user' });
  await db.update(authTokens).set({ usedAt: now }).where(eq(authTokens.id, peek.id));
  return { user: user!, workspaceId: peek.workspaceId };
}
