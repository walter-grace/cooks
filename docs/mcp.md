# Cooks MCP server

`cooks-mcp` lets any MCP-capable assistant (Claude Code, Claude Desktop, Cursor, Grok, Windsurf, Codex) run your sales engagement: find prospects, build sequences, enroll, work the task queue, draft and send email. The assistant is the brain and pays for its own tokens; Cooks is the hands.

The server is a thin client over the Cooks REST API. It never touches the database, so it can run on your laptop against a hosted Cooks, or be hosted next to the API.

## 1. Get an API key

```bash
pnpm bootstrap --email you@example.com --workspace "My Team"   # first time
# or create more keys later (extension endpoint): POST /v1/apiKeys
```

## 2. Local (stdio) setup

Claude Code:

```bash
claude mcp add cooks \
  -e COOKS_API_URL=http://localhost:8080 \
  -e COOKS_API_KEY=cooks-api-... \
  -- npx -y cooks-mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cooks": {
      "command": "npx",
      "args": ["-y", "cooks-mcp"],
      "env": { "COOKS_API_URL": "http://localhost:8080", "COOKS_API_KEY": "cooks-api-..." }
    }
  }
}
```

Cursor (`.cursor/mcp.json`) uses the same `command` / `args` / `env` shape.

From a checkout (before the npm package is published):

```bash
COOKS_API_URL=http://localhost:8080 COOKS_API_KEY=cooks-api-... pnpm --filter cooks-mcp stdio
```

## 3. Hosted (Streamable HTTP) setup

```bash
pnpm --filter cooks-mcp dev      # http://localhost:8081/mcp
```

Any client that can send an `Authorization: Bearer` header can connect with a Cooks API key:

```bash
claude mcp add --transport http cooks http://localhost:8081/mcp --header "Authorization: Bearer cooks-api-..."
```

Grok: add a custom MCP connector pointing at `https://<your host>/mcp` and supply the bearer token in the connector's auth settings. The exact UI changes often; check xAI's current connector docs.

Unauthenticated requests get a `401` with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`, which is what OAuth-capable clients use to discover the authorization server once M4 OAuth ships.

## Tools

| Tool | What it does |
| --- | --- |
| `cooks_me`, `cooks_list_users` | Workspace, scopes, owner ids |
| `cooks_list_prospects`, `cooks_get_prospect`, `cooks_create_prospect`, `cooks_update_prospect` | Prospects |
| `cooks_list_accounts`, `cooks_get_account`, `cooks_create_account` | Accounts |
| `cooks_list_sequences`, `cooks_get_sequence`, `cooks_create_sequence`, `cooks_update_sequence` | Sequences |
| `cooks_list_sequence_steps`, `cooks_create_sequence_step`, `cooks_update_sequence_step`, `cooks_delete_sequence_step`, `cooks_reorder_sequence_steps` | Steps |
| `cooks_enroll_prospect`, `cooks_list_enrollments`, `cooks_pause_enrollment`, `cooks_resume_enrollment`, `cooks_finish_enrollment` | Enrollments |
| `cooks_list_tasks`, `cooks_create_task`, `cooks_complete_task`, `cooks_skip_task` | Task queue |
| `cooks_list_email_templates`, `cooks_list_tags`, `cooks_create_tag`, `cooks_add_note` | Templates, tags, CRM notes |

Prompts: `enroll-prospect-in-sequence`, `work-the-task-queue`, `draft-sequence`. Resources: `cooks://openapi`, `cooks://docs/merge-fields`.

Tool errors carry the API's error envelope, so the model sees `CONFLICT` (already enrolled) or `UNPROCESSABLE_ENTITY` with the rule that was broken and can recover on its own.

## Safety defaults

- Nothing is sent to a prospect unless the user confirms the draft. The server instructions say so, and `cooks_create_sequence_step` with `auto_email` is the only path that sends without a human, which the user chooses explicitly.
- Suppression lists, unsubscribes and daily caps are enforced server-side in the send pipeline. The model cannot bypass them.
- Scopes come from the API key. OAuth tokens (M4) will narrow them per user.
