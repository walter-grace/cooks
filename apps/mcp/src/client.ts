/** Minimal typed client for the Cooks REST API. The MCP server never touches the database. */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body: unknown,
  ) {
    super(message);
  }
}

export interface ApiClient {
  call<T = unknown>(method: string, path: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }): Promise<T>;
  baseUrl: string;
}

export function createApiClient(baseUrl: string, token: string, fetchImpl: typeof fetch = fetch): ApiClient {
  const root = baseUrl.replace(/\/+$/, '');
  return {
    baseUrl: root,
    call: async <T = unknown>(method: string, path: string, opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}): Promise<T> => {
      const url = new URL(`${root}/v1${path}`);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
      const res = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), 'user-agent': 'cooks-mcp/0.1' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      });
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string } })?.error;
        throw new ApiError(res.status, err?.code ?? `HTTP_${res.status}`, err?.message ?? `Request failed with ${res.status}`, json);
      }
      return json as T;
    },
  };
}
