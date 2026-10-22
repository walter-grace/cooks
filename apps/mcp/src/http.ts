/**
 * Hosted transport: Streamable HTTP at /mcp. Stateless (one server per request) so it scales
 * horizontally. Auth: the client's `Authorization: Bearer <cooks api key or OAuth token>` is
 * forwarded to the REST API, which enforces scopes and rate limits. Unauthenticated requests
 * get a 401 with RFC 9728 resource metadata pointing at the API's authorization server.
 */
import { serve } from '@hono/node-server';
import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';
import { createServer, SERVER_VERSION } from './server.js';

const env = {
  COOKS_PUBLIC_URL: process.env.COOKS_PUBLIC_URL ?? 'http://localhost:8080',
  COOKS_MCP_PUBLIC_URL: process.env.COOKS_MCP_PUBLIC_URL ?? 'http://localhost:8081',
  MCP_PORT: Number(process.env.MCP_PORT ?? 8081),
};
const apiUrl = process.env.COOKS_API_URL ?? env.COOKS_PUBLIC_URL;
const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, version: SERVER_VERSION, api: apiUrl }));
app.get('/.well-known/oauth-protected-resource', (c) =>
  c.json({
    resource: `${env.COOKS_MCP_PUBLIC_URL}/mcp`,
    authorization_servers: [env.COOKS_PUBLIC_URL],
    bearer_methods_supported: ['header'],
    resource_name: 'Cooks MCP Server',
    resource_documentation: `${env.COOKS_PUBLIC_URL}/docs`,
  }),
);
app.all('/mcp', async (c) => {
  const m = /^Bearer\s+(.+)$/i.exec(c.req.header('authorization') ?? '');
  if (!m) {
    c.header('WWW-Authenticate', `Bearer resource_metadata="${env.COOKS_MCP_PUBLIC_URL}/.well-known/oauth-protected-resource"`);
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Send a Cooks API key or access token as Authorization: Bearer <token>' } }, 401);
  }
  const server = createServer({ apiUrl, token: m[1]!.trim() });
  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

serve({ fetch: app.fetch, port: env.MCP_PORT }, (info) => console.log(`cooks mcp (http) on http://localhost:${info.port}/mcp → api ${apiUrl}`));
