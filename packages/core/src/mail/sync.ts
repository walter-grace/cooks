import { and, eq, isNull } from 'drizzle-orm';
import { mailboxCredentials, mailboxes, emails, tasks, prospects, suppressions, sequenceStates } from '@cooks/db';
import type { Ctx } from '../context.js';
import { decrypt } from '../crypto.js';
import { finishEnrollment, pauseEnrollment } from '../engine/transitions.js';
import { processInbound, type InboundOutcome } from './inbound.js';
import { ImapProvider, parseMailUrl } from './imap.js';
import type { InboundProvider, SyncCursor } from './provider.js';
import type { OAuthTokens } from './oauth-mail.js';
import { emitEvent } from '../events.js';
import { sql } from 'drizzle-orm';

export interface MailboxCreds {
  smtpUrl?: string;
  imapUrl?: string;
  google?: OAuthTokens;
  microsoft?: OAuthTokens;
}

export async function loadCreds(ctx: Ctx, mailboxId: string, kek: string | undefined): Promise<MailboxCreds | null> {
  const [c] = await ctx.db.select().from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mailboxId)).limit(1);
  if (!c) return null;
  if (c.encrypted.startsWith('plain:')) return JSON.parse(c.encrypted.slice(6)) as MailboxCreds;
  if (!kek) return null;
  return JSON.parse(decrypt(c.encrypted, kek)) as MailboxCreds;
}

export type InboundProviderFactory = (mailbox: typeof mailboxes.$inferSelect, creds: MailboxCreds) => InboundProvider | null;

/** Default: IMAP for SMTP mailboxes. Gmail/Graph factories are registered by their modules. */
const factories: Record<string, InboundProviderFactory> = {
  smtp: (_m, creds) => (creds.imapUrl ? new ImapProvider({ ...parseMailUrl(creds.imapUrl), mailbox: 'INBOX' }) : null),
};
export function registerInboundProvider(kind: string, f: InboundProviderFactory) {
  factories[kind] = f;
}

/** Pull new messages for one mailbox and process them. Returns counts for logs. */
export async function syncMailbox(ctx: Ctx, mailboxId: string, deps: { kek?: string; classify: boolean; providerOverride?: InboundProvider }): Promise<Record<string, number>> {
  const [mb] = await ctx.db.select().from(mailboxes).where(and(eq(mailboxes.id, mailboxId), isNull(mailboxes.deletedAt))).limit(1);
  if (!mb) return { skipped: 1 };
  const creds = deps.providerOverride ? ({} as MailboxCreds) : await loadCreds(ctx, mb.id, deps.kek);
  const provider = deps.providerOverride ?? (creds ? factories[mb.provider]?.(mb, creds) : null);
  if (!provider) return { noProvider: 1 };
  const [credRow] = await ctx.db.select({ cursor: mailboxCredentials.syncCursor }).from(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, mb.id)).limit(1);
  const { messages, cursor } = await provider.sync((credRow?.cursor as SyncCursor | null) ?? null);
  const counts: Record<string, number> = { fetched: messages.length };
  for (const msg of messages) {
    const out: InboundOutcome = await processInbound(ctx, mb, msg, { classify: deps.classify });
    counts[out.kind] = (counts[out.kind] ?? 0) + 1;
  }
  if (credRow) await ctx.db.update(mailboxCredentials).set({ syncCursor: cursor }).where(eq(mailboxCredentials.mailboxId, mb.id));
  else await ctx.db.insert(mailboxCredentials).values({ mailboxId: mb.id, encrypted: 'plain:{}', syncCursor: cursor }).onConflictDoNothing();
  return counts;
}

/** Every connected mailbox that has credentials. */
export async function syncableMailboxIds(ctx: Ctx): Promise<Array<{ id: string; workspaceId: string }>> {
  return ctx.db
    .select({ id: mailboxes.id, workspaceId: mailboxes.workspaceId })
    .from(mailboxes)
    .innerJoin(mailboxCredentials, eq(mailboxCredentials.mailboxId, mailboxes.id))
    .where(and(isNull(mailboxes.deletedAt), eq(mailboxes.status, 'connected')));
}

export interface Classification {
  intent: string;
  confidence: number;
  summary: string;
  suggestedAction: string;
  pauseUntil: string | null;
  draftReply: string | null;
}

/**
 * Apply a reply classification conservatively: annotate the task; unsubscribe only at high
 * confidence; pause-until only for stated dates within 60 days. Everything else stays human.
 */
export async function applyClassification(ctx: Ctx, a: { inboundEmailId: string; taskId: string | null; result: Classification; reviewed: boolean }) {
  const now = ctx.clock.now();
  const [inb] = await ctx.db.select().from(emails).where(eq(emails.id, a.inboundEmailId)).limit(1);
  if (!inb) return { applied: 'none' as const };
  const note = `AI: ${a.result.intent} (${Math.round(a.result.confidence * 100)}%). ${a.result.summary}${a.result.draftReply ? `\n\nSuggested reply:\n${a.result.draftReply}` : ''}`;
  if (a.taskId) await ctx.db.update(tasks).set({ note: sql`coalesce(${tasks.note}, '') || ${'\n\n' + note}` }).where(eq(tasks.id, a.taskId));
  if (a.reviewed) return { applied: 'note' as const };
  if (a.result.intent === 'unsubscribe' && a.result.confidence >= 0.9 && inb.fromAddr) {
    await ctx.db.insert(suppressions).values({ workspaceId: inb.workspaceId, emailLower: inb.fromAddr.toLowerCase(), reason: 'unsubscribe', source: `classify:${inb.id}` }).onConflictDoNothing();
    if (inb.prospectId) {
      await ctx.db.update(prospects).set({ unsubscribedAt: now, emailStatus: 'unsubscribed' }).where(eq(prospects.id, inb.prospectId));
      const active = await ctx.db.select({ id: sequenceStates.id }).from(sequenceStates).where(and(eq(sequenceStates.prospectId, inb.prospectId), sql`${sequenceStates.state} <> 'finished'`));
      for (const s of active) await finishEnrollment(ctx, s.id, 'unsubscribed');
      await emitEvent(ctx.db, { workspaceId: inb.workspaceId, type: 'prospect.unsubscribed', aggregateType: 'prospect', aggregateId: inb.prospectId, payload: { prospectId: inb.prospectId, via: 'reply' } });
    }
    if (a.taskId) await ctx.db.update(tasks).set({ status: 'skipped', skippedAt: now }).where(eq(tasks.id, a.taskId));
    return { applied: 'unsubscribe' as const };
  }
  if ((a.result.intent === 'not_now' || a.result.intent === 'ooo') && a.result.pauseUntil && inb.sequenceStateId) {
    const until = new Date(a.result.pauseUntil);
    if (!Number.isNaN(until.getTime()) && until > now && until.getTime() - now.getTime() <= 60 * 86_400_000) {
      const [st] = await ctx.db.select().from(sequenceStates).where(eq(sequenceStates.id, inb.sequenceStateId)).limit(1);
      if (st && st.state === 'active') {
        await pauseEnrollment(ctx, st.id);
        await ctx.db.update(sequenceStates).set({ scheduledAt: until }).where(eq(sequenceStates.id, st.id));
        return { applied: 'pause_until' as const, until };
      }
    }
  }
  return { applied: 'note' as const };
}
