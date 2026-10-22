# Cooks

Free, open-source sales engagement. Sequences, tasks, email, prospects and accounts behind an
API that is wire-compatible with the public Nooks Sequencing API, plus an MCP server so any
Claude, Grok, Cursor or other MCP-capable assistant can run your outbound.

Cooks is an independent project. It is not affiliated with or endorsed by Nooks.

## Why

Sales engagement platforms charge per seat for what is mostly a scheduler, a mail merge, a task
queue and a CRM sync. Cooks gives you those parts under MIT, self-hosted on one Postgres, with
the AI brought by whatever model you already pay for.

![Tasks](docs/screenshots/tasks.png)

| Signals feed | Call coaching |
| --- | --- |
| ![Signals](docs/screenshots/signals.png) | ![Coaching](docs/screenshots/call-coaching.png) |

## Status

| Milestone | State |
| --- | --- |
| M0 scaffold, schema, PGlite tests | done |
| M1 API keys, users, accounts, prospects, tags, notes, rate limits, OpenAPI | done |
| M2 sequences, steps, enrollments, tasks, templates, enrollment engine | done |
| M3 email transport: SMTP/Gmail/Microsoft 365 send, open/click tracking, one-click unsubscribe | done |
| M4 OAuth 2.1 (PKCE, DCR, rotating refresh, ES256 JWT) + MCP server (32 tools, stdio + HTTP) | done |
| M5 webhooks (`call.logged` compatible + Cooks events, signed, retried) | done |
| Hosted AI agents: AI email drafts on `aiEmail` steps, reply classification, run ledger with cost, per-workspace provider (Anthropic, xAI/Grok, OpenAI, OpenRouter, Ollama) | done |
| Inbound mail: IMAP / Gmail / Microsoft 365 sync, replies, bounces, out-of-office | done |
| Web UI at `/app` built on shadcn/ui (tasks, prospects, sequences, emails, settings) | done |
| Clerk SSO: organizations become workspaces, Gmail / Microsoft 365 / HubSpot connect with the tokens Clerk holds | done |
| HubSpot: token or OAuth connect, contact/company sync, list and deal-stage auto-enroll, notes + email/call logging | done |
| Web-grounded prospect research (OpenRouter web search) | done |
| Signals: feed, push API for bots, email-engagement and web-scan sources, rules that enroll or create tasks | done |
| Dialer: Twilio bridge + browser softphone, dual-channel recording, dispositions, upstream `call.logged`, HubSpot call logging | done |
| Coaching: speaker-split transcripts, talk stats, AI scorecard per call | done |
| Later: Salesforce connector (today: run the Salesforce MCP next to Cooks MCP in the same bot) | planned |

## Run it locally

Requirements: Node 22+, pnpm 9, Postgres 15+ (Homebrew works), optional Mailpit for email. Sign in at `/app` with the email and `--password` you gave to `pnpm bootstrap`, or set `CLERK_SECRET_KEY` and let your team in through Clerk SSO (see `docs/auth.md`).

```bash
pnpm install
createdb cooks
cp .env.example .env            # defaults point at postgres://localhost:5432/cooks
pnpm bootstrap --email you@example.com --workspace "My Team" --password 'choose-one'   # prints an API key once
pnpm --filter @cooks/api dev    # http://localhost:8080, docs at /docs
pnpm --filter @cooks/worker dev # runs the sequence engine, sends email, reads replies
pnpm web:build                  # builds the UI; the API serves it at http://localhost:8080/app
pnpm seed                       # optional demo data
mailpit                         # optional: SMTP on :1025, inbox UI on http://localhost:8025
```

Then:

```bash
export KEY=cooks-api-...
curl -H "Authorization: Bearer $KEY" localhost:8080/v1/me
```

## MCP in one line

```bash
claude mcp add cooks -e COOKS_API_URL=http://localhost:8080 -e COOKS_API_KEY=cooks-api-... \
  -- npx -y https://github.com/walter-grace/cooks/releases/latest/download/cooks-mcp.tgz
```

The server ships as a tarball on GitHub Releases (no npm registry involved). Create the key under Settings → API keys.

## Docker

```bash
export COOKS_KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
docker compose --profile dev up -d          # postgres, api :8080, worker, mcp :8081, mailpit :8025
docker compose run --rm api pnpm bootstrap --email you@example.com --workspace "My Team"
```

## API compatibility

Paths, envelopes (`{data}`, `{data, links}`), cursor paging (`page[size]`, `page[after]`),
filters (`filter[updatedAt][gte]`), `include=`, error codes and rate-limit headers follow the
upstream contract vendored in `spec/nooks-upstream.openapi.yml`. A client written against
Nooks works against Cooks by changing the base URL and key. Operations that only exist in Cooks
(creating prospects, pausing an enrollment, webhooks management) are tagged `Cooks extensions`
in `/openapi.yml`.

Behaviours that match upstream on purpose: 409 when a prospect is already enrolled, 422 when
enrolling a prospect without an email into an email sequence, `emailOverrides` is a full
replace, `reorderSteps` must list every step, tag creation is idempotent by name
(200 vs 201), `aiEmail` is for email steps, reply steps force an empty subject, one LinkedIn
connection request per sequence, `role: user` can only delete steps in sequences they own.

## Architecture

```
apps/api      Hono + zod-openapi. API keys + OAuth 2.1 (PKCE, DCR, JWKS). Serves /openapi.yml and /docs.
apps/worker   pg-boss consumers: enrollment.advance, step.execute, email.send, start_pending cron.
apps/mcp      MCP server: stdio for local assistants, streamable HTTP for hosted connectors.
apps/web      React UI served by the API at /app (session login, task queue, sequences, settings).
packages/db   Drizzle schema + migrations. UUIDv7 ids, keyset-cursor indexes, soft deletes.
packages/core Domain: services, enrollment engine, scheduling, mail pipeline, error envelope.
packages/auth API keys (sha256 at rest), passwords (scrypt), sessions, ES256 signing keys, OAuth 2.1 server.
packages/jobs pg-boss adapter behind the JobsPort interface.
packages/agent Hosted AI: provider abstraction, structured contracts, run ledger, draft/classify/research jobs.
packages/core/crm HubSpot client + connector (sync, auto-enroll rules, write-back).
spec/         Vendored upstream OpenAPI document and lock file.
docs/         auth, mcp, self-host, ai, crm, signals, dialer, coaching, webhooks, api-compat, conformance + research notes.
```

The enrollment engine is a small state machine. An enrollment points at its current step,
`advance` picks the next live step by order and schedules `step.execute` for the computed
time (interval, prospect time zone, send window, seeded jitter). Manual steps become tasks;
completing or skipping the task advances the enrollment. Automatic email steps queue an email
which the worker renders (LiquidJS, strict variables) and sends through the owner's mailbox,
honouring suppression lists, daily caps and spacing. Every step runs at most once per
enrollment thanks to a unique execution row, so duplicate job deliveries are harmless.

## AI

Two modes, see `docs/ai.md`: bring your own assistant through MCP (Cooks spends no tokens), or configure a provider per workspace and let the worker draft emails for `aiEmail` steps and classify replies, with every run logged with tokens and cost and uncertain output routed to a human.

## Tests

```bash
pnpm test          # vitest; database tests run on PGlite, no Docker needed
pnpm typecheck
```

## License

MIT. See `LICENSE`. Research material in `docs/research` is compiled from public sources.
