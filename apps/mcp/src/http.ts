/**
 * Hosted transport as its own process: Streamable HTTP at /mcp on MCP_PORT (default 8081).
 * The routes live in ./http-app.ts so the Vercel function can mount them next to the API.
 */
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { createMcpHttpApp } from './http-app.js';
import { SERVER_VERSION } from './server.js';

const env = {
  COOKS_PUBLIC_URL: process.env.COOKS_PUBLIC_URL ?? 'http://localhost:8080',
  COOKS_MCP_PUBLIC_URL: process.env.COOKS_MCP_PUBLIC_URL ?? 'http://localhost:8081',
  MCP_PORT: Number(process.env.MCP_PORT ?? 8081),
};
const apiUrl = process.env.COOKS_API_URL ?? env.COOKS_PUBLIC_URL;
const app = new Hono();

app.get('/health', (c) => c.json({ ok: true, version: SERVER_VERSION, api: apiUrl }));
app.route('/', createMcpHttpApp({ apiUrl, publicUrl: env.COOKS_PUBLIC_URL, mcpPublicUrl: env.COOKS_MCP_PUBLIC_URL }));

serve({ fetch: app.fetch, port: env.MCP_PORT }, (info) => console.log(`cooks mcp (http) on http://localhost:${info.port}/mcp → api ${apiUrl}`));
