import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accounts, callDispositions, calls, crmConnections, emails, notes, prospects, sequenceStates, tasks, users, workspaceMembers } from '@cooks/db';
import type { Ctx } from '../context.js';
import { decrypt, encrypt } from '../crypto.js';
import { noCrmConnection, unprocessable } from '../errors.js';
import { createSequenceState } from '../services/sequence-states.js';
import { fullName } from '../services/prospects.js';
import { HubSpotClient, HubSpotError, type HubSpotApp, type HubSpotAuth } from './hubspot.js';

export interface CrmCredentials {
  hubspot?: HubSpotAuth & { portalId?: number; kind: 'private_app' | 'oauth' | 'clerk'; clerkUserId?: string };
}

export interface AutoEnrollRule {
  id: string;
  kind: 'list' | 'dealStage';
  listId?: string;
  pipelineId?: string;
  stageId?: string;
  sequenceId: string;
  ownerId: string;
  enabled: boolean;
}

export interface CrmSettings {
  autoEnroll?: AutoEnrollRule[];
  /** HubSpot owner id → Cooks user id, learned by matching owner emails. */
  ownerMap?: Record<string, string>;
  logEmails?: boolean;
  logCalls?: boolean;
  lastPollAt?: string;
}

export interface CrmDeps {
  kek?: string;
  fetchImpl?: typeof fetch;
  hubspotApp?: HubSpotApp;
  /** Clerk-managed HubSpot tokens: ask the broker for the connecting user's current token. */
  brokerHubspotToken?: (clerkUserId: string) => Promise<HubSpotAuth | null>;
}

export async function getConnection(ctx: Ctx) {
  const [row] = await ctx.db.select().from(crmConnections).where(eq(crmConnections.workspaceId, ctx.principal.workspaceId)).limit(1);
  return row ?? null;
}

export function readCreds(row: typeof crmConnections.$inferSelect | null, kek: string | undefined): CrmCredentials | null {
  if (!row?.credentialsEncrypted) return null;
  if (row.credentialsEncrypted.startsWith('plain:')) return JSON.parse(row.credentialsEncrypted.slice(6)) as CrmCredentials;
  if (!kek) return null;
  return JSON.parse(decrypt(row.credentialsEncrypted, kek)) as CrmCredentials;
}

function writeCreds(c: CrmCredentials, kek: string | undefined): string {
  return kek ? encrypt(JSON.stringify(c), kek) : `plain:${JSON.stringify(c)}`;
}

/** A HubSpot client for the workspace, or an upstream-style NO_CRM_CONNECTION error. */
export async function hubspotFor(ctx: Ctx, d: CrmDeps): Promise<{ client: HubSpotClient; row: typeof crmConnections.$inferSelect; settings: CrmSettings }> {
  const row = await getConnection(ctx);
  const creds = readCreds(row, d.kek);
  if (!row || row.type !== 'hubspot' || !creds?.hubspot) throw noCrmConnection('hubspot');
  const refresher =
    creds.hubspot.kind === 'clerk' && creds.hubspot.clerkUserId && d.brokerHubspotToken
      ? async () => {
          const t = await d.brokerHubspotToken!(creds.hubspot!.clerkUserId!);
          if (!t) throw new Error('No HubSpot token available from the identity provider; reconnect HubSpot in Clerk.');
          return t;
        }
      : undefined;
  const client = new HubSpotClient(d.fetchImpl ?? fetch, creds.hubspot, d.hubspotApp, async (a) => {
    await ctx.db.update(crmConnections).set({ credentialsEncrypted: writeCreds({ hubspot: { ...creds.hubspot!, ...a } }, d.kek) }).where(eq(crmConnections.id, row.id));
  }, refresher);
  return { client, row, settings: (row.settings ?? {}) as CrmSettings };
}

/** Connect (or replace) the HubSpot connection; verifies the token first. */
export async function connectHubspot(ctx: Ctx, auth: HubSpotAuth, kind: 'private_app' | 'oauth' | 'clerk', d: CrmDeps, extra: { clerkUserId?: string } = {}) {
  const client = new HubSpotClient(d.fetchImpl ?? fetch, auth, d.hubspotApp);
  let info: { portalId: number };
  try {
    info = await client.accountInfo();
  } catch (e) {
    if (e instanceof HubSpotError) throw unprocessable(`HubSpot rejected the token (${e.status}). Check the token and its scopes.`, { status: e.status });
    throw e;
  }
  const ownerMap = await learnOwnerMap(ctx, client).catch(() => ({}));
  const creds = writeCreds({ hubspot: { ...auth, portalId: info.portalId, kind, ...(extra.clerkUserId ? { clerkUserId: extra.clerkUserId } : {}) } }, d.kek);
  const existing = await getConnection(ctx);
  const settings: CrmSettings = { ...((existing?.settings as CrmSettings) ?? {}), ownerMap, logEmails: (existing?.settings as CrmSettings)?.logEmails ?? true, logCalls: (existing?.settings as CrmSettings)?.logCalls ?? true };
  await ctx.db
    .insert(crmConnections)
    .values({ workspaceId: ctx.principal.workspaceId, type: 'hubspot', status: 'connected', credentialsEncrypted: creds, settings: settings as Record<string, unknown> })
    .onConflictDoUpdate({ target: crmConnections.workspaceId, set: { type: 'hubspot', status: 'connected', credentialsEncrypted: creds, settings: settings as Record<string, unknown> } });
  return serializeConnection(ctx, d);
}

export async function disconnectCrm(ctx: Ctx) {
  await ctx.db.update(crmConnections).set({ type: 'none', status: 'disconnected', credentialsEncrypted: null }).where(eq(crmConnections.workspaceId, ctx.principal.workspaceId));
}

export async function serializeConnection(ctx: Ctx, d: CrmDeps) {
  const row = await getConnection(ctx);
  const creds = readCreds(row, d.kek);
  const s = (row?.settings ?? {}) as CrmSettings;
  return {
    type: row?.type ?? 'none',
    status: row?.status ?? 'disconnected',
    hubspot: creds?.hubspot ? { portalId: creds.hubspot.portalId ?? null, kind: creds.hubspot.kind, tokenLast4: creds.hubspot.accessToken.slice(-4) } : null,
    settings: { autoEnroll: s.autoEnroll ?? [], logEmails: s.logEmails ?? true, logCalls: s.logCalls ?? true, ownerMapSize: Object.keys(s.ownerMap ?? {}).length, lastPollAt: s.lastPollAt ?? null },
    updatedAt: row?.updatedAt?.toISOString() ?? null,
  };
}

export async function updateCrmSettings(ctx: Ctx, patch: { autoEnroll?: AutoEnrollRule[]; logEmails?: boolean; logCalls?: boolean }, d: CrmDeps) {
  const row = await getConnection(ctx);
  if (!row) throw noCrmConnection('hubspot');
  const s = { ...((row.settings ?? {}) as CrmSettings), ...patch };
  await ctx.db.update(crmConnections).set({ settings: s as Record<string, unknown> }).where(eq(crmConnections.id, row.id));
  return serializeConnection(ctx, d);
}

/** Map HubSpot owners to Cooks users by email. */
export async function learnOwnerMap(ctx: Ctx, client: HubSpotClient): Promise<Record<string, string>> {
  const owners = await client.owners();
  const members = await ctx.db.select({ id: users.id, email: users.email }).from(users).innerJoin(workspaceMembers, eq(workspaceMembers.userId, users.id)).where(eq(workspaceMembers.workspaceId, ctx.principal.workspaceId));
  const byEmail = new Map(members.map((m) => [m.email.toLowerCase(), m.id]));
  const map: Record<string, string> = {};
  for (const o of owners) {
    const uid = byEmail.get((o.email ?? '').toLowerCase());
    if (uid) map[String(o.id)] = uid;
  }
  return map;
}

export interface SyncResult {
  results: Array<{ externalId: string; prospectId: string; created: boolean }>;
  errors: Array<{ externalId: string; code: 'NOT_FOUND_IN_CRM' | 'MAPPING_FAILED'; message: string }>;
}

/** Upsert prospects (and their companies) from HubSpot contact ids or emails. Mirrors POST /integrations/prospects/sync. */
export async function syncHubspotContacts(ctx: Ctx, externalIds: string[], d: CrmDeps, opts: { byEmail?: boolean } = {}): Promise<SyncResult> {
  const { client, settings } = await hubspotFor(ctx, d);
  const ws = ctx.principal.workspaceId;
  const contacts = await client.contacts(externalIds, opts.byEmail ? 'email' : undefined);
  const companies = await client.companies(contacts.map((c) => c.companyId!).filter(Boolean));
  const accountByHs = new Map<string, string>();
  for (const co of companies) {
    const p = co.properties;
    const [existing] = await ctx.db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.workspaceId, ws), eq(accounts.crmId, co.id), isNull(accounts.deletedAt))).limit(1);
    const values = { name: p.name ?? null, domain: p.domain?.toLowerCase() ?? null, industry: p.industry ?? null, numEmployees: p.numberofemployees ? Number(p.numberofemployees) || null : null, description: p.description ?? null, linkedInUrl: p.linkedin_company_page ?? null, city: p.city ?? null, timezone: p.timezone ?? null, crmType: 'hubspot' as const };
    if (existing) {
      await ctx.db.update(accounts).set(values).where(eq(accounts.id, existing.id));
      accountByHs.set(co.id, existing.id);
    } else {
      const [row] = await ctx.db.insert(accounts).values({ workspaceId: ws, crmId: co.id, ...values }).returning({ id: accounts.id });
      accountByHs.set(co.id, row!.id);
    }
  }
  const results: SyncResult['results'] = [];
  const errors: SyncResult['errors'] = [];
  const found = new Set<string>();
  for (const c of contacts) {
    const p = c.properties;
    const key = opts.byEmail ? (p.email ?? '').toLowerCase() : c.id;
    found.add(key);
    if (!p.email && !p.firstname && !p.lastname) {
      errors.push({ externalId: key, code: 'MAPPING_FAILED', message: 'Contact has no name or email' });
      continue;
    }
    const ownerId = p.hubspot_owner_id ? settings.ownerMap?.[p.hubspot_owner_id] : undefined;
    const values = {
      firstName: p.firstname ?? null,
      lastName: p.lastname ?? null,
      name: fullName(p.firstname, p.lastname, p.email),
      title: p.jobtitle ?? null,
      primaryEmail: p.email?.toLowerCase() ?? null,
      phone: p.phone ?? p.mobilephone ?? null,
      linkedInUrl: p.hs_linkedin_url ?? null,
      city: p.city ?? null,
      state: p.state ?? null,
      country: p.country ?? null,
      timezone: p.hs_timezone ?? null,
      accountId: c.companyId ? (accountByHs.get(c.companyId) ?? null) : null,
      crmType: 'hubspot' as const,
      crmCustomFields: { hubspot: { lifecyclestage: p.lifecyclestage ?? null, ownerId: p.hubspot_owner_id ?? null } },
      ...(ownerId ? { ownerId } : {}),
    };
    const [existing] = await ctx.db.select({ id: prospects.id }).from(prospects).where(and(eq(prospects.workspaceId, ws), eq(prospects.crmId, c.id), isNull(prospects.deletedAt))).limit(1);
    if (existing) {
      await ctx.db.update(prospects).set(values).where(eq(prospects.id, existing.id));
      results.push({ externalId: key, prospectId: existing.id, created: false });
    } else {
      const [row] = await ctx.db.insert(prospects).values({ workspaceId: ws, crmId: c.id, ...values }).returning({ id: prospects.id });
      results.push({ externalId: key, prospectId: row!.id, created: true });
    }
  }
  for (const id of externalIds) {
    const k = opts.byEmail ? id.toLowerCase() : id;
    if (!found.has(k)) errors.push({ externalId: id, code: 'NOT_FOUND_IN_CRM', message: 'No such contact in HubSpot' });
  }
  return { results, errors };
}

/** Pull a HubSpot list (or a deal stage) and enroll new prospects into a sequence. */
export async function runAutoEnrollRule(ctx: Ctx, rule: AutoEnrollRule, d: CrmDeps): Promise<{ synced: number; enrolled: number; skipped: number }> {
  const { client } = await hubspotFor(ctx, d);
  let contactIds: string[] = [];
  if (rule.kind === 'list' && rule.listId) contactIds = await client.listMembers(rule.listId);
  else if (rule.kind === 'dealStage' && rule.pipelineId && rule.stageId) contactIds = [...new Set((await client.dealStageContacts(rule.pipelineId, rule.stageId)).flatMap((x) => x.contactIds))];
  if (contactIds.length === 0) return { synced: 0, enrolled: 0, skipped: 0 };
  const sync = await syncHubspotContacts(ctx, contactIds, d);
  let enrolled = 0;
  let skipped = 0;
  const pids = sync.results.map((r) => r.prospectId);
  const already = new Set(
    pids.length
      ? (await ctx.db.select({ pid: sequenceStates.prospectId }).from(sequenceStates).where(and(eq(sequenceStates.sequenceId, rule.sequenceId), inArray(sequenceStates.prospectId, pids), isNull(sequenceStates.deletedAt)))).map((r) => r.pid)
      : [],
  );
  for (const r of sync.results) {
    if (already.has(r.prospectId)) {
      skipped++;
      continue;
    }
    try {
      await createSequenceState(ctx, { prospect: { id: r.prospectId }, sequence: { id: rule.sequenceId }, owner: { id: rule.ownerId } });
      enrolled++;
    } catch {
      skipped++; // already enrolled, unsubscribed, no email, etc.
    }
  }
  return { synced: sync.results.length, enrolled, skipped };
}

/** Write a note to HubSpot (and locally) for a prospect or account. */
export async function pushNote(ctx: Ctx, a: { associatedType: 'prospect' | 'account'; associatedId: string; text: string }, d: CrmDeps) {
  const { client, settings } = await hubspotFor(ctx, d);
  const ws = ctx.principal.workspaceId;
  let contactId: string | null = null;
  let companyId: string | null = null;
  if (a.associatedType === 'prospect') {
    const [p] = await ctx.db.select({ crmId: prospects.crmId, accountId: prospects.accountId }).from(prospects).where(eq(prospects.id, a.associatedId)).limit(1);
    contactId = p?.crmId ?? null;
    if (!contactId) throw unprocessable('This prospect is not linked to a HubSpot contact. Sync it first.', { field: 'prospectId' });
  } else {
    const [acc] = await ctx.db.select({ crmId: accounts.crmId }).from(accounts).where(eq(accounts.id, a.associatedId)).limit(1);
    companyId = acc?.crmId ?? null;
    if (!companyId) throw unprocessable('This account is not linked to a HubSpot company. Sync it first.', { field: 'accountId' });
  }
  const ownerHs = ctx.principal.userId ? Object.entries(settings.ownerMap ?? {}).find(([, uid]) => uid === ctx.principal.userId)?.[0] : undefined;
  const now = ctx.clock.now();
  const created = await client.createNote({ body: a.text, at: now, contactId, companyId, ownerId: ownerHs ?? null });
  const [row] = await ctx.db
    .insert(notes)
    .values({ workspaceId: ws, associatedType: a.associatedType, associatedId: a.associatedId, text: a.text, integrationType: 'hubspot', externalId: created.id, createdBy: ctx.principal.userId, userName: ctx.principal.name ?? null, userExternalId: ownerHs ?? null, externalCreatedAt: now, externalUpdatedAt: now })
    .returning();
  return row!;
}

/** Log a sent email on the HubSpot contact timeline. */
export async function logEmailToHubspot(ctx: Ctx, emailId: string, d: CrmDeps): Promise<'logged' | 'skipped'> {
  const row = await getConnection(ctx);
  const s = (row?.settings ?? {}) as CrmSettings;
  if (!row || row.type !== 'hubspot' || s.logEmails === false) return 'skipped';
  const [e] = await ctx.db.select().from(emails).where(eq(emails.id, emailId)).limit(1);
  if (!e || !e.prospectId || e.status !== 'sent') return 'skipped';
  const [p] = await ctx.db.select({ crmId: prospects.crmId }).from(prospects).where(eq(prospects.id, e.prospectId)).limit(1);
  if (!p?.crmId) return 'skipped';
  const { client, settings } = await hubspotFor(ctx, d);
  const ownerHs = e.ownerId ? Object.entries(settings.ownerMap ?? {}).find(([, uid]) => uid === e.ownerId)?.[0] : undefined;
  await client.logEmail({ subject: e.subject ?? '', text: e.bodyText ?? '', html: e.bodyHtml, at: e.date ?? ctx.clock.now(), direction: 'EMAIL', contactId: p.crmId, from: e.fromAddr, to: e.toAddr, ownerId: ownerHs ?? null });
  return 'logged';
}

/** Log a completed call task on the HubSpot contact timeline. */
/** Dialer / manual calls: write a call engagement with duration, disposition and notes. */
export async function logCallToHubspot(ctx: Ctx, callId: string, d: CrmDeps): Promise<'logged' | 'skipped'> {
  const row = await getConnection(ctx);
  const s = (row?.settings ?? {}) as CrmSettings;
  if (!row || row.type !== 'hubspot' || s.logCalls === false) return 'skipped';
  const [c] = await ctx.db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  if (!c || !c.prospectId || !c.loggedAt) return 'skipped';
  const [p] = await ctx.db.select({ crmId: prospects.crmId, name: prospects.name }).from(prospects).where(eq(prospects.id, c.prospectId)).limit(1);
  if (!p?.crmId) return 'skipped';
  const [disp] = c.callDispositionId ? await ctx.db.select({ name: callDispositions.name }).from(callDispositions).where(eq(callDispositions.id, c.callDispositionId)).limit(1) : [];
  const { client, settings } = await hubspotFor(ctx, d);
  const ownerHs = Object.entries(settings.ownerMap ?? {}).find(([, uid]) => uid === c.ownerId)?.[0];
  await client.logCall({ title: `${disp?.name ?? 'Call'} with ${p.name ?? 'prospect'}`, body: c.notes, at: c.time, durationMs: c.durationSeconds * 1000, disposition: disp?.name ?? null, contactId: p.crmId, direction: c.direction === 'inbound' ? 'INBOUND' : 'OUTBOUND', ownerId: ownerHs ?? null });
  return 'logged';
}

export async function logCallTaskToHubspot(ctx: Ctx, taskId: string, d: CrmDeps): Promise<'logged' | 'skipped'> {
  const row = await getConnection(ctx);
  const s = (row?.settings ?? {}) as CrmSettings;
  if (!row || row.type !== 'hubspot' || s.logCalls === false) return 'skipped';
  const [t] = await ctx.db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t || t.action !== 'call' || !t.completed) return 'skipped';
  const [p] = await ctx.db.select({ crmId: prospects.crmId, name: prospects.name }).from(prospects).where(eq(prospects.id, t.prospectId)).limit(1);
  if (!p?.crmId) return 'skipped';
  const { client, settings } = await hubspotFor(ctx, d);
  const ownerHs = Object.entries(settings.ownerMap ?? {}).find(([, uid]) => uid === t.ownerId)?.[0];
  await client.logCall({ title: `Call with ${p.name ?? 'prospect'}`, body: t.note, at: t.completedAt ?? ctx.clock.now(), contactId: p.crmId, ownerId: ownerHs ?? null });
  return 'logged';
}
