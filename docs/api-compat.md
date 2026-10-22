# API compatibility

Cooks mirrors the public sales-engagement API documented at `developer.nooks.in` (vendored at
`spec/nooks-upstream.openapi.yml`). `pnpm conformance` diffs the live `/openapi.json` against it
and writes `docs/conformance.md`; CI fails if an upstream path, parameter, required field or enum
value goes missing.

## What is identical

- Base path `/v1`, bearer auth, `{data}` and `{data, links}` envelopes, cursor paging with
  `page[size]`, `page[after]`, `page[before]`, bracket filters (`filter[updatedAt][gte]`),
  `include=` with at most three relations, unexpanded refs as `{id, _href}`.
- Error envelope `{error: {code, message, details?}, traceId}` with the upstream codes.
- Per-workspace rate classes (list 300, get 600, writes 120, notes 30, sync 20, default 30 per
  60 s) with `X-RateLimit-*` and `Retry-After`.
- Resource shapes and behaviours: 409 on double enrollment, 422 when enrolling without a valid
  email, full-replace `emailOverrides`, `reorderSteps` requiring every step id, role rules on
  step deletion, idempotent tag creation (200 vs 201), the singular `/emailTemplate/{id}` quirk.
- API key prefix `cooks-api-`; `nooks-api-` is accepted on input and can be issued with
  `COOKS_API_KEY_PREFIX=nooks` for clients that regex-check the prefix.
- OAuth scopes (the 24 upstream names) and the `call.logged` webhook signature.

## Extensions

Operations tagged `Cooks extensions` in `/docs` are additive and never change an upstream
response. They cover prospect and account writes, enrollment pause/resume, email sending and
importing mail from outside Cooks, mailboxes and connectors, webhooks management, API keys, hosted AI, research, HubSpot, signals,
the dialer and coaching. Extension scopes: `webhooks:write`, `api-keys:write`, `agents:run`,
`emails:send`.

## Switching a client

Change the base URL and the key. The upstream OpenAPI-generated SDKs compile against Cooks
unchanged; `packages/sdk` is generated from the upstream spec and exercised in the test suite
for exactly this reason.
