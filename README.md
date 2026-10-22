# Cooks

Free, open-source sales engagement. Sequences, tasks, email, prospects and accounts behind an
API that is wire-compatible with the public Nooks Sequencing API, plus an MCP server so any
Claude, Grok, Cursor or other MCP-capable assistant can run your outbound.

Cooks is an independent project. It is not affiliated with or endorsed by Nooks.

## Why

Sales engagement platforms charge per seat for what is mostly a scheduler, a mail merge, a task
queue and a CRM sync. Cooks gives you those parts under MIT, self-hosted on one Postgres, with
the AI brought by whatever model you already pay for.

## Status

| Milestone | State |
| --- | --- |
| M0 scaffold, schema, PGlite tests | done |
| M1 API keys, users, accounts, prospects, tags, notes, rate limits, OpenAPI | done |
| M2 sequences, steps, enrollments, tasks, templates, enrollment engine | done |
| M3 email transport (SMTP now; Gmail, Microsoft Graph, inbound reply detection next) | in progress |
| M4 OAuth 2.1 + MCP server + hosted agents | next |
| M5 webhooks (`call.logged` compatible + Cooks events) | planned |
| Later: dialer (Twilio Voice), CRM connectors, signals, coaching, web UI | planned |

## Run it locally

Requirements: Node 22+, pnpm 9, Postgres 15+ (Homebrew works), optional Mailpit for email.

```bash
pnpm install
createdb cooks
cp .env.example .env            # defaults point at postgres://localhost:5432/cooks
pnpm bootstrap --email you@example.com --workspace "My Team"   # prints an API key once
pnpm --filter @cooks/api dev    # http://localhost:8080, docs at /docs
pnpm --filter @cooks/worker dev # runs the sequence engine and sends email
mailpit                         # optional: SMTP on :1025, inbox UI on http://localhost:8025
```

Then:

```bash
export KEY=cooks-api-...
curl -H "Authorization: Bearer $KEY" localhost:8080/v1/me
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
apps/api      Hono + zod-openapi. API keys now, OAuth 2.1 in M4. Serves /openapi.yml and /docs.
apps/worker   pg-boss consumers: enrollment.advance, step.execute, email.send, start_pending cron.
apps/mcp      MCP server (M4): stdio for local assistants, streamable HTTP with OAuth for hosted.
packages/db   Drizzle schema + migrations. UUIDv7 ids, keyset-cursor indexes, soft deletes.
packages/core Domain: services, enrollment engine, scheduling, mail pipeline, error envelope.
packages/auth API keys (sha256 at rest, timing-safe compare), OAuth server in M4.
packages/jobs pg-boss adapter behind the JobsPort interface.
spec/         Vendored upstream OpenAPI document and lock file.
docs/         Research notes and, later, self-host / MCP / webhook guides.
```

The enrollment engine is a small state machine. An enrollment points at its current step,
`advance` picks the next live step by order and schedules `step.execute` for the computed
time (interval, prospect time zone, send window, seeded jitter). Manual steps become tasks;
completing or skipping the task advances the enrollment. Automatic email steps queue an email
which the worker renders (LiquidJS, strict variables) and sends through the owner's mailbox,
honouring suppression lists, daily caps and spacing. Every step runs at most once per
enrollment thanks to a unique execution row, so duplicate job deliveries are harmless.

## Tests

```bash
pnpm test          # vitest; database tests run on PGlite, no Docker needed
pnpm typecheck
```

## License

MIT. See `LICENSE`. Research material in `docs/research` is compiled from public sources.
