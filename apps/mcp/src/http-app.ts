/**
 * The Streamable HTTP transport as a mountable Hono app: `/mcp` plus the RFC 9728 resource
 * metadata. Stateless (one MCP server per request) so it scales horizontally. The client's
 * `Authorization: Bearer <cooks api key or OAuth token>` is forwarded to the REST API, which
 * enforces scopes and rate limits. Unauthenticated requests get a 401 pointing at the API's
 * authorization server.
 *
 * `fetchImpl` lets a host that already runs the API in the same process answer the MCP server's
 * calls without a network hop (the Vercel function does this with `app.request`).
 */
import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { createServer } from './server.js';

export interface McpHttpOptions {
  /** Where the REST API lives, as seen by this process (or by `fetchImpl`). */
  apiUrl: string;
  /** The API's public URL: the OAuth authorization server. */
  publicUrl: string;
  /** This server's public URL; `/mcp` is appended for the resource identifier. */
  mcpPublicUrl: string;
  fetchImpl?: typeof fetch;
}

export function createMcpHttpApp(o: McpHttpOptions) {
  const app = new Hono();
  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: `${o.mcpPublicUrl}/mcp`,
      authorization_servers: [o.publicUrl],
      bearer_methods_supported: ['header'],
      resource_name: 'Cooks MCP Server',
      resource_documentation: `${o.publicUrl}/docs`,
    }),
  );
  app.all('/mcp', async (c) => {
    const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
    if (!m) {
      c.header('WWW-Authenticate', `Bearer resource_metadata="${o.mcpPublicUrl}/.well-known/oauth-protected-resource"`);
      return c.json({ error: { code: 'UNAUTHORIZED', message: 'Send a Cooks API key or access token as Authorization: Bearer <token>' } }, 401);
    }
    const server = createServer({ apiUrl: o.apiUrl, token: m[1]!.trim(), fetchImpl: o.fetchImpl });
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });
  return app;
}
