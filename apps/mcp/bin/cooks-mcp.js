#!/usr/bin/env node
// Stdio MCP server for Cooks. Env: COOKS_API_URL (default http://localhost:8080), COOKS_API_KEY.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dist = new URL('../dist/stdio.js', import.meta.url);
if (!existsSync(fileURLToPath(dist))) {
  console.error('cooks-mcp: build output missing. Run `pnpm --filter cooks-mcp build` in the repo, or install the release tarball.');
  process.exit(1);
}
await import(dist.href);
