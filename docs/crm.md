# CRM: HubSpot

Cooks connects to HubSpot so prospects, companies, notes and activity stay in sync. Salesforce
follows the same connector interface and is not built yet.

## Connect

Settings → CRM, as a workspace admin. Two options:

- **Private app token.** In HubSpot: Settings → Integrations → Private apps → create an app with
  scopes `crm.objects.contacts.read/write`, `crm.objects.companies.read/write`,
  `crm.objects.deals.read`, `crm.objects.owners.read`, `crm.lists.read`. Paste the `pat-…` token.
  Cooks verifies it against the account before saving it, encrypted with `COOKS_KEK`.
- **OAuth.** If the server has `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` (a HubSpot app with
  redirect URL `$COOKS_PUBLIC_URL/connect/hubspot/callback`), the "Connect HubSpot" button runs
  the OAuth flow and stores refreshable tokens.

On connect, HubSpot owners are matched to Cooks users by email so synced contacts land with the
right owner and activity is attributed to the right rep.

## What syncs

| Direction | What | How |
| --- | --- | --- |
| HubSpot → Cooks | Contacts + their companies | `POST /v1/integrations/prospects/sync` (`type: hubspot`, contact ids) or `POST /v1/integrations/hubspot/import` (emails); Settings → Import |
| HubSpot → Cooks | Auto-enroll from a **list** or a **deal stage** | Rules under Settings → CRM; the worker runs them every 5 minutes (`crm.poll`), syncing members and enrolling new ones into the chosen sequence with the chosen owner |
| Cooks → HubSpot | Notes | `POST /v1/prospects/{id}/notes` / `/accounts/{id}/notes` with `integrationType: hubspot`, associated to the contact or company |
| Cooks → HubSpot | Sent emails | Logged as email engagements on the contact timeline when `logEmails` is on (default) |
| Cooks → HubSpot | Completed call tasks | Logged as call engagements when `logCalls` is on (default) |

Prospects carry `crmId` (HubSpot contact id) and `crmCustomFields.hubspot` (lifecycle stage,
owner). Companies map to accounts by HubSpot company id.

The deal-stage rule mirrors the pipeline/stage configuration from the TGI orchestrator: a HubSpot
pipeline stage acts as the work queue; anyone attached to a deal that enters the stage gets the
sequence.

## MCP

`cooks_crm_status`, `cooks_sync_hubspot_contacts` (by ids or emails). Notes written through
`cooks_add_note` with `integrationType: hubspot` go to HubSpot.

## QA without a HubSpot account

`scripts/qa/mock-hubspot.mjs` is a small HubSpot stand-in. `pnpm qa:hubspot <chromium> <url> <outDir>`
drives the real UI in headless Chromium through connect, rule, import and note flows. Point the
API at the mock with `HUBSPOT_API_BASE=http://127.0.0.1:18090`.
