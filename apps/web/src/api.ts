/** Browser API client: session cookie → short-lived access token → /v1 calls. */
export interface Session {
  access_token: string;
  expires_in: number;
  workspace: { id: string; name: string; role: string };
  user: { id: string; email: string; name: string };
  workspaces: Array<{ id: string; name: string; role: string }>;
}

let session: Session | null = null;
let expiresAt = 0;
let pending: Promise<Session | null> | null = null;

export async function loadSession(workspaceId?: string, force = false): Promise<Session | null> {
  if (!force && session && Date.now() < expiresAt - 60_000 && !workspaceId) return session;
  if (pending && !workspaceId && !force) return pending;
  pending = (async () => {
    const res = await fetch('/auth/session-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(workspaceId ? { workspaceId } : {}), credentials: 'same-origin' });
    if (!res.ok) {
      session = null;
      return null;
    }
    session = (await res.json()) as Session;
    expiresAt = Date.now() + session.expires_in * 1000;
    try {
      localStorage.setItem('cooks.workspace', session.workspace.id);
    } catch {}
    return session;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

export function currentSession() {
  return session;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const s = await loadSession();
  if (!s) throw new ApiError(401, 'UNAUTHORIZED', 'Not signed in', null);
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${s.access_token}`);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  const res = await fetch(path, { ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: any = undefined;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = text;
  }
  if (!res.ok) throw new ApiError(res.status, body?.error?.code ?? `HTTP_${res.status}`, body?.error?.message ?? res.statusText, body);
  return body as T;
}

export const q = (params: Record<string, string | number | boolean | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export async function logout() {
  await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
  session = null;
  location.href = '/app/login';
}

const thisYear = (d: Date) => d.getFullYear() === new Date().getFullYear();
/** "Oct 22, 4:03 PM" this year, "Oct 22, 2025, 4:03 PM" otherwise. */
export const fmtDate = (s: string | null | undefined) => {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleString(undefined, thisYear(d) ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { dateStyle: 'medium', timeStyle: 'short' });
};
/** "Oct 22" this year, "Oct 22, 2025" otherwise. */
export const fmtDay = (s: string | null | undefined) => {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString(undefined, thisYear(d) ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' });
};
