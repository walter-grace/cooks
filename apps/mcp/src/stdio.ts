import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';

const apiUrl = process.env.COOKS_API_URL ?? 'http://localhost:8080';
const token = process.env.COOKS_API_KEY;
if (!token) {
  console.error('cooks-mcp: set COOKS_API_KEY (and COOKS_API_URL, default http://localhost:8080)');
  process.exit(2);
}
const server = createServer({ apiUrl, token });
await server.connect(new StdioServerTransport());
