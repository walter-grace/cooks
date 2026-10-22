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
  -- npx -y https://github.com/walter-grace/cooks/releases/latest/download/cooks-mcp.tgz
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "cooks": {
      "command": "npx",
      "args": ["-y", "https://github.com/walter-grace/cooks/releases/latest/download/cooks-mcp.tgz"],
      "env": { "COOKS_API_URL": "http://localhost:8080", "COOKS_API_KEY": "cooks-api-..." }
    }
  }
}
```

Cursor (`.cursor/mcp.json`) uses the same `command` / `args` / `env` shape.

Cooks does not publish to the npm registry; the tarball on GitHub Releases is the distribution (`npx` and `npm i -g` accept the URL directly, and `releases/latest/download/cooks-mcp.tgz` always points at the newest tag). From a checkout:

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

### OAuth (per-user access for hosted connectors)

Unauthenticated requests get a `401` with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource"`. OAuth-capable clients (Claude.ai connectors, Claude Code remote MCP, Cursor) follow that to the API's authorization server and run the standard flow:

1. Dynamic client registration at `POST /oauth/register` (on by default, `COOKS_OAUTH_DCR=false` to disable).
2. `GET /oauth/authorize` with PKCE S256. The user signs in with email + password (`pnpm bootstrap --password ...` sets one) and approves the requested scopes for one workspace.
3. `POST /oauth/token` returns a 1-hour ES256 access token plus a 90-day rotating refresh token. Reusing a rotated refresh token revokes the whole family.
4. Tokens carry the user's role and scopes, so a `user` cannot delete steps in sequences they do not own, and a token without `prospects:write` gets `INSUFFICIENT_SCOPE`.

Discovery: `/.well-known/oauth-authorization-server`, `/.well-known/jwks.json`.

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
| `cooks_dialer_status`, `cooks_dial`, `cooks_place_ai_call`, `cooks_get_call_transcript`, `cooks_hangup_call`, `cooks_dialer_balance`, `cooks_log_call`, `cooks_record_call` | Dialer: rep calls on Twilio, AI-voiced calls on Speko (queued, then polled to an outcome and transcript), balance and spend |
| `cooks_list_emails`, `cooks_create_email`, `cooks_import_email` | Emails: list, draft or send, and record mail sent or received outside Cooks (an imported reply runs the normal reply pipeline) |
| `cooks_list_email_templates`, `cooks_list_tags`, `cooks_create_tag`, `cooks_add_note` | Templates, tags, CRM notes |

Prompts: `enroll-prospect-in-sequence`, `work-the-task-queue`, `draft-sequence`. Resources: `cooks://openapi`, `cooks://docs/merge-fields`.

Tool errors carry the API's error envelope, so the model sees `CONFLICT` (already enrolled) or `UNPROCESSABLE_ENTITY` with the rule that was broken and can recover on its own.

## Safety defaults

- Nothing is sent to a prospect unless the user confirms the draft. The server instructions say so, and `cooks_create_sequence_step` with `auto_email` is the only path that sends without a human, which the user chooses explicitly.
- Suppression lists, unsubscribes and daily caps are enforced server-side in the send pipeline. The model cannot bypass them.
- Scopes come from the API key. OAuth tokens (M4) will narrow them per user.
