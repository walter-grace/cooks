# cooks-mcp

MCP server for [Cooks](https://github.com/walter-grace/cooks), the open-source sales engagement platform. Gives Claude Code, Claude Desktop, Cursor, Grok and any MCP client 35 tools over your prospects, sequences, tasks, emails, research and CRM.

Install from the GitHub release tarball (no npm registry needed):

```bash
# Claude Code
claude mcp add cooks \
  -e COOKS_API_URL=https://your-cooks-host \
  -e COOKS_API_KEY=cooks-api-... \
  -- npx -y https://github.com/walter-grace/cooks/releases/latest/download/cooks-mcp.tgz

# or install once
npm i -g https://github.com/walter-grace/cooks/releases/latest/download/cooks-mcp.tgz
cooks-mcp
```

Create the API key in Cooks → Settings → API keys. Full guide: `docs/mcp.md` in the repo.
