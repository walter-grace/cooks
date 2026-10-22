/**
 * HubSpot client over the public REST API. Works with a private-app token or OAuth tokens.
 * Only the calls Cooks needs: contacts, companies, owners, lists, deals, and engagement
 * objects (notes, emails, calls) with associations.
 */
export interface HubSpotAuth {
  /** Private app token (pat-...) or an OAuth access token. */
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface HubSpotApp {
  clientId: string;
  clientSecret: string;
}

export const HUBSPOT_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.deals.read',
  'crm.objects.owners.read',
  'crm.lists.read',
  'sales-email-read',
];

/** Overridable so tests and QA can point at a mock server. */
export const HUBSPOT_API_BASE = process.env.HUBSPOT_API_BASE ?? 'https://api.hubapi.com';
const API = HUBSPOT_API_BASE;

export class HubSpotError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

export function hubspotAuthUrl(app: HubSpotApp, redirectUri: string, state: string): string {
  const u = new URL('https://app.hubspot.com/oauth/authorize');
  u.searchParams.set('client_id', app.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', HUBSPOT_SCOPES.join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

export async function hubspotExchangeCode(fetchImpl: typeof fetch, app: HubSpotApp, redirectUri: string, code: string): Promise<HubSpotAuth> {
  const res = await fetchImpl(`${API}/oauth/v1/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri, code }).toString() });
  const j = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  if (!res.ok) throw new HubSpotError(res.status, 'HubSpot token exchange failed', j);
  return { accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: Date.now() + j.expires_in * 1000 };
}

export interface HsContact {
  id: string;
  properties: Record<string, string | null>;
  companyId?: string | null;
}
export interface HsCompany {
  id: string;
  properties: Record<string, string | null>;
}

export const CONTACT_PROPS = ['firstname', 'lastname', 'email', 'jobtitle', 'phone', 'mobilephone', 'hs_linkedin_url', 'linkedinbio', 'city', 'state', 'country', 'hs_timezone', 'hubspot_owner_id', 'lifecyclestage', 'associatedcompanyid'];
export const COMPANY_PROPS = ['name', 'domain', 'industry', 'numberofemployees', 'description', 'linkedin_company_page', 'city', 'timezone', 'hubspot_owner_id'];

export class HubSpotClient {
  constructor(
    private fetchImpl: typeof fetch,
    private auth: HubSpotAuth,
    private app?: HubSpotApp,
    private onRefresh?: (a: HubSpotAuth) => Promise<void>,
  ) {}

  private async token(): Promise<string> {
    if (this.auth.refreshToken && this.app && (this.auth.expiresAt ?? Infinity) < Date.now() + 60_000) {
      const res = await this.fetchImpl(`${API}/oauth/v1/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: this.app.clientId, client_secret: this.app.clientSecret, refresh_token: this.auth.refreshToken }).toString() });
      const j = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
      if (!res.ok) throw new HubSpotError(res.status, 'HubSpot token refresh failed', j);
      this.auth = { accessToken: j.access_token, refreshToken: j.refresh_token ?? this.auth.refreshToken, expiresAt: Date.now() + j.expires_in * 1000 };
      await this.onRefresh?.(this.auth);
    }
    return this.auth.accessToken;
  }

  async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, { method, headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json', accept: 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
      return this.request(method, path, body, attempt + 1);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) throw new HubSpotError(res.status, `HubSpot ${method} ${path} → ${res.status}`, json);
    return json as T;
  }

  /** Verify the token and learn the portal. */
  async accountInfo(): Promise<{ portalId: number; uiDomain?: string; timeZone?: string }> {
    return this.request('GET', '/account-info/v3/details');
  }

  async owners(): Promise<Array<{ id: string; email: string; firstName?: string; lastName?: string }>> {
    const out: Array<{ id: string; email: string; firstName?: string; lastName?: string }> = [];
    let after: string | undefined;
    do {
      const page = await this.request<{ results: Array<{ id: string; email: string; firstName?: string; lastName?: string }>; paging?: { next?: { after: string } } }>('GET', `/crm/v3/owners?limit=100${after ? `&after=${after}` : ''}`);
      out.push(...page.results);
      after = page.paging?.next?.after;
    } while (after && out.length < 1000);
    return out;
  }

  /** Batch read contacts by id, or by email when idProperty is 'email'. Missing ids are simply absent. */
  async contacts(ids: string[], idProperty?: 'email'): Promise<HsContact[]> {
    const out: HsContact[] = [];
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const page = await this.request<{ results: Array<{ id: string; properties: Record<string, string | null> }> }>('POST', '/crm/v3/objects/contacts/batch/read', { properties: CONTACT_PROPS, ...(idProperty ? { idProperty } : {}), inputs: chunk.map((id) => ({ id })) });
      out.push(...page.results.map((r) => ({ id: r.id, properties: r.properties, companyId: r.properties.associatedcompanyid ?? null })));
    }
    return out;
  }

  async companies(ids: string[]): Promise<HsCompany[]> {
    const uniq = [...new Set(ids.filter(Boolean))];
    const out: HsCompany[] = [];
    for (let i = 0; i < uniq.length; i += 100) {
      const page = await this.request<{ results: HsCompany[] }>('POST', '/crm/v3/objects/companies/batch/read', { properties: COMPANY_PROPS, inputs: uniq.slice(i, i + 100).map((id) => ({ id })) });
      out.push(...page.results);
    }
    return out;
  }

  async listMembers(listId: string, limit = 500): Promise<string[]> {
    const ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await this.request<{ results: Array<{ recordId: string }>; paging?: { next?: { after: string } } }>('GET', `/crm/v3/lists/${encodeURIComponent(listId)}/memberships?limit=250${after ? `&after=${after}` : ''}`);
      ids.push(...page.results.map((r) => r.recordId));
      after = page.paging?.next?.after;
    } while (after && ids.length < limit);
    return ids.slice(0, limit);
  }

  /** Contacts associated with deals currently in a pipeline stage (TGI-style stage trigger). */
  async dealStageContacts(pipelineId: string, stageId: string, limit = 500): Promise<Array<{ dealId: string; contactIds: string[] }>> {
    const deals = await this.request<{ results: Array<{ id: string }> }>('POST', '/crm/v3/objects/deals/search', {
      filterGroups: [{ filters: [{ propertyName: 'pipeline', operator: 'EQ', value: pipelineId }, { propertyName: 'dealstage', operator: 'EQ', value: stageId }] }],
      properties: ['dealname'],
      limit: Math.min(limit, 200),
    });
    const out: Array<{ dealId: string; contactIds: string[] }> = [];
    for (const d of deals.results) {
      const assoc = await this.request<{ results: Array<{ toObjectId: number | string }> }>('GET', `/crm/v4/objects/deals/${d.id}/associations/contacts`);
      out.push({ dealId: d.id, contactIds: assoc.results.map((a) => String(a.toObjectId)) });
    }
    return out;
  }

  async searchContacts(q: { property: string; operator: string; value: string }, limit = 100): Promise<HsContact[]> {
    const page = await this.request<{ results: Array<{ id: string; properties: Record<string, string | null> }> }>('POST', '/crm/v3/objects/contacts/search', { filterGroups: [{ filters: [{ propertyName: q.property, operator: q.operator, value: q.value }] }], properties: CONTACT_PROPS, limit: Math.min(limit, 200) });
    return page.results.map((r) => ({ id: r.id, properties: r.properties, companyId: r.properties.associatedcompanyid ?? null }));
  }

  private assoc(objectId: string, typeId: number) {
    return { to: { id: objectId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: typeId }] };
  }

  async createNote(a: { body: string; at: Date; contactId?: string | null; companyId?: string | null; ownerId?: string | null }): Promise<{ id: string }> {
    const associations = [...(a.contactId ? [this.assoc(a.contactId, 202)] : []), ...(a.companyId ? [this.assoc(a.companyId, 190)] : [])];
    return this.request('POST', '/crm/v3/objects/notes', { properties: { hs_timestamp: a.at.toISOString(), hs_note_body: a.body, ...(a.ownerId ? { hubspot_owner_id: a.ownerId } : {}) }, associations });
  }

  async logEmail(a: { subject: string; text: string; html?: string | null; at: Date; direction: 'EMAIL' | 'INCOMING_EMAIL'; contactId: string; from?: string | null; to?: string | null; ownerId?: string | null }): Promise<{ id: string }> {
    return this.request('POST', '/crm/v3/objects/emails', {
      properties: {
        hs_timestamp: a.at.toISOString(),
        hs_email_direction: a.direction,
        hs_email_status: 'SENT',
        hs_email_subject: a.subject,
        hs_email_text: a.text,
        ...(a.html ? { hs_email_html: a.html } : {}),
        ...(a.ownerId ? { hubspot_owner_id: a.ownerId } : {}),
        hs_email_headers: JSON.stringify({ from: { email: a.from ?? '' }, to: [{ email: a.to ?? '' }] }),
      },
      associations: [this.assoc(a.contactId, 198)],
    });
  }

  async logCall(a: { title: string; body?: string | null; at: Date; durationMs?: number | null; disposition?: string | null; contactId: string; direction?: 'INBOUND' | 'OUTBOUND'; ownerId?: string | null }): Promise<{ id: string }> {
    return this.request('POST', '/crm/v3/objects/calls', {
      properties: {
        hs_timestamp: a.at.toISOString(),
        hs_call_title: a.title,
        hs_call_body: a.body ?? '',
        hs_call_direction: a.direction ?? 'OUTBOUND',
        hs_call_status: 'COMPLETED',
        ...(a.durationMs ? { hs_call_duration: String(a.durationMs) } : {}),
        ...(a.ownerId ? { hubspot_owner_id: a.ownerId } : {}),
      },
      associations: [this.assoc(a.contactId, 194)],
    });
  }
}
