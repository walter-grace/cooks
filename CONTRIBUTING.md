# Contributing to Cooks

Thanks for helping. Cooks is a small codebase with a clear shape, and most changes fit in one of the places below.

## Setup

```bash
pnpm install
createdb cooks cooks_test
cp .env.example .env
pnpm bootstrap --email you@example.com --workspace "Dev" --password 'dev-pass-123'
pnpm --filter @cooks/api dev
pnpm --filter @cooks/worker dev
```

Tests run on PGlite and need no running database:

```bash
pnpm test
pnpm typecheck
pnpm conformance
```

## Where things live

- `packages/core` holds every business rule. The API, worker and MCP server call these services in process. Put new behavior here first, then expose it.
- `apps/api` is routing, validation and serialization only. A route handler that contains logic is a bug.
- `apps/worker` owns anything that runs later: scheduling, sending, syncing, transcribing, scoring.
- `apps/mcp` maps services to MCP tools. One tool per user-level action, with honest `readOnlyHint` and `destructiveHint` annotations.
- `packages/db` is the Drizzle schema. Generate a migration with `pnpm db:generate` and commit the SQL.

## Rules of the road

- **Keep the upstream contract.** Paths, envelopes, paging, filters and error codes under `/v1` follow the vendored spec in `spec/`. Anything new gets the `x-cooks-extension` tag. The conformance script runs in CI and fails on a silent divergence.
- **Never return a secret.** Mailbox credentials, provider keys, Twilio tokens and webhook secrets are encrypted with `COOKS_KEK`. Serializers expose `hasKey` and the last four characters, nothing more.
- **Guardrails live in code, not prompts.** Suppression lists, do-not-call and daily caps are enforced in the send and dial paths. A model can suggest, it cannot bypass.
- **Clean room.** Cooks is built from public documentation. Do not copy code, assets, screenshots or prose from any commercial product.
- **Tests with the change.** Add a vitest case for new services and routes. UI changes should keep their `data-testid` hooks so the Playwright QA scripts in `scripts/qa` keep working.

## Pull requests

Open an issue first for anything larger than a fix, so we can agree on the shape. Keep PRs focused, describe the user-visible change in the first line, and include the command you ran to verify it.

## Releases

The MCP server is distributed as a tarball attached to GitHub Releases, not through the npm registry. Tagging `v*` runs `.github/workflows/release.yml`, which builds and attaches `cooks-mcp.tgz`.
