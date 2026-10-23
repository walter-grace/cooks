# API compatibility

Cooks speaks the same REST contract as the commercial sequencing platform it mirrors, so a client
written against that platform's public API works against Cooks by changing the base URL and the
key. The upstream OpenAPI document is vendored in `spec/` with a lock file. `pnpm conformance`
diffs the live `/openapi.json` against it and writes `docs/conformance.md`; CI fails if an upstream
path, parameter, required field or enum value goes missing.

The upstream contract is published openly by its vendor. Cooks implements it from that public
document alone and is an independent project with no affiliation to the vendor. See the notice at
the end of this page.

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
- API keys are issued as `cooks-api-…`. The upstream key prefix is accepted on input, and
  `COOKS_API_KEY_PREFIX` switches issuance to it for clients that regex-check the prefix.
- The 24 upstream OAuth scope names and the `call.logged` webhook signature scheme.

## Extensions

Operations tagged `Cooks extensions` in `/docs` are additive and never change an upstream
response. They cover prospect and account writes, enrollment pause/resume, email sending and
importing mail from outside Cooks, mailboxes and connectors, webhooks management, API keys,
hosted AI, research, HubSpot, signals, the dialer and coaching. Extension scopes:
`webhooks:write`, `api-keys:write`, `agents:run`, `emails:send`.

## Switching a client

Change the base URL and the key. SDKs generated from the upstream OpenAPI document compile
against Cooks unchanged; `packages/sdk` is generated from that document and exercised in the test
suite for exactly this reason.

## Other dialers

Cooks mirrors one public contract because, among the dialers it is compared with, only one
sequencing platform publishes a full REST reference. Checked in October 2026:

| Vendor | Public API reference | Webhooks | Notes |
| --- | --- | --- | --- |
| Orum | None. No developer portal, OpenAPI document, SDK or MCP server. | One documented event, `call-disposition-added`, sold as a paid add-on. Signed `x-webhook-signature: t=…,s=…` with base64 HMAC-SHA256 over `timestamp.body`, eight retries over about thirty minutes. | [support.orum.com, ART-463](https://support.orum.com/en-US/orum/article/ART-463-webhooks) |
| Salesfinity | Yes: OpenAPI 3.0.1 at `client-api.salesfinity.co`, `x-api-key` auth, plus a hosted MCP server. | In the settings UI, not documented publicly. | [docs.salesfinity.ai](https://docs.salesfinity.ai) |
| Kixie | Yes, per tier: contacts, activities, dispositions, lookups, power-list and cadence automations. | Calls, SMS, dispositions, voicemail and more. | [kixie.com/developer-api](https://www.kixie.com/developer-api/) |

There is nothing on Orum's side to be wire-compatible with. Its webhook signature scheme is the
same shape as the `call.logged` signature Cooks already verifies and emits, so a receiver that
turns `call-disposition-added` into Cooks call and disposition records would be a small addition;
it is not built. Salesfinity and Kixie publish enough to build compatibility layers if a team ever
wants them.

---

The mirrored contract is the public Sequencing API at `developer.nooks.in`, vendored as
`spec/nooks-upstream.openapi.yml`. Cooks is not affiliated with, endorsed by, or supported by that
vendor; the name appears here only to identify the document.
