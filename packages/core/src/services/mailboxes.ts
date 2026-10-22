import { and, eq, ne, type SQL } from 'drizzle-orm';
import { mailboxCredentials, mailboxes, users } from '@cooks/db';
import type { Ctx } from '../context.js';
import { badRequest, conflict, notFound, pgConstraint, unprocessable } from '../errors.js';
import { encrypt } from '../crypto.js';
import { parseInclude, ref } from '../include.js';
import type { PageArgs } from '../pagination.js';
import { isManagerOrAdmin } from '../principal.js';
import { serializeUser, usersByIds } from './users.js';
import { isUuid, isoReq, paginate, requireMember, tenantWhere, updatedAtFilter, uuidOr404 } from './_shared.js';

export type MailboxRow = typeof mailboxes.$inferSelect;
export const MAILBOX_INCLUDES = ['user'] as const;

export function serializeMailbox(m: MailboxRow, user?: typeof users.$inferSelect) {
  return { id: m.id, email: m.email, isDefault: m.isDefault, user: user ? serializeUser(user) : ref('users', m.userId), createdAt: isoReq(m.createdAt), updatedAt: isoReq(m.updatedAt) };
}

async function serializeMailboxes(ctx: Ctx, rows: MailboxRow[], includes: string[]) {
  const us = includes.includes('user') ? await usersByIds(ctx, rows.map((r) => r.userId)) : new Map();
  return rows.map((r) => serializeMailbox(r, us.get(r.userId)));
}

export async function listMailboxes(ctx: Ctx, q: { page: PageArgs; filter?: Record<string, unknown>; include?: unknown; requestUrl: string }) {
  const f = q.filter ?? {};
  const includes = parseInclude(q.include, MAILBOX_INCLUDES);
  const conds: SQL[] = [tenantWhere(mailboxes, ctx.principal.workspaceId)];
  if (typeof f.userId === 'string' && f.userId) {
    if (!isUuid(f.userId)) throw badRequest('filter[userId] must be a UUID');
    conds.push(eq(mailboxes.userId, f.userId));
  }
  conds.push(...updatedAtFilter(mailboxes.updatedAt, f, 'lt'));
  const page = await paginate({
    table: mailboxes,
    page: q.page,
    requestUrl: q.requestUrl,
    run: (where, orderBy, limit) =>
      ctx.db
        .select()
        .from(mailboxes)
        .where(and(...conds, where))
        .orderBy(...orderBy)
        .limit(limit),
  });
  return { data: await serializeMailboxes(ctx, page.data, includes), links: page.links };
}

export async function getMailbox(ctx: Ctx, id: string, include?: unknown) {
  uuidOr404(id, 'Mailbox');
  const includes = parseInclude(include, MAILBOX_INCLUDES);
  const [row] = await ctx.db
    .select()
    .from(mailboxes)
    .where(and(tenantWhere(mailboxes, ctx.principal.workspaceId), eq(mailboxes.id, id)))
    .limit(1);
  if (!row) throw notFound('Mailbox');
  return (await serializeMailboxes(ctx, [row], includes))[0]!;
}

export interface CreateMailboxInput {
  email: string;
  userId?: string;
  isDefault?: boolean;
  dailySendLimit?: number;
  minGapSeconds?: number;
  smtpUrl?: string;
  imapUrl?: string;
  signatureHtml?: string;
}

/** Cooks extension: connect an SMTP mailbox. Credentials are encrypted with the KEK when given. */
export async function createMailbox(ctx: Ctx, input: CreateMailboxInput, kek: string | undefined) {
  const userId = await requireMember(ctx, input.userId ?? ctx.principal.userId, 'userId');
  if (!isManagerOrAdmin(ctx.principal) && ctx.principal.userId !== userId) throw unprocessable('Users can only connect their own mailboxes', { field: 'userId' });
  if ((input.smtpUrl || input.imapUrl) && !kek) throw unprocessable('Set COOKS_KEK on the server before storing mailbox credentials');
  try {
    const [row] = await ctx.db
      .insert(mailboxes)
      .values({
        workspaceId: ctx.principal.workspaceId,
        userId,
        email: input.email.toLowerCase(),
        provider: 'smtp',
        isDefault: input.isDefault ?? false,
        dailySendLimit: input.dailySendLimit ?? 50,
        minGapSeconds: input.minGapSeconds ?? 60,
        signatureHtml: input.signatureHtml ?? null,
      })
      .returning();
    if (input.isDefault) {
      await ctx.db
        .update(mailboxes)
        .set({ isDefault: false })
        .where(and(eq(mailboxes.userId, userId), eq(mailboxes.workspaceId, ctx.principal.workspaceId), eq(mailboxes.isDefault, true), ne(mailboxes.id, row!.id)));
    }
    if ((input.smtpUrl || input.imapUrl) && kek) {
      await ctx.db.insert(mailboxCredentials).values({ mailboxId: row!.id, encrypted: encrypt(JSON.stringify({ smtpUrl: input.smtpUrl, imapUrl: input.imapUrl }), kek) });
    }
    return serializeMailbox(row!);
  } catch (e) {
    if (pgConstraint(e) === 'mailboxes_ws_email_uq') throw conflict('A mailbox with this address already exists in the workspace');
    throw e;
  }
}
