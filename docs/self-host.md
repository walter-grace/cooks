# Self-hosting Cooks

One Postgres, three Node processes. No Redis, no Docker required (a Compose file is planned).

## Requirements

- Node 22 or newer, pnpm 9
- Postgres 15 or newer (`pgcrypto`'s `gen_random_uuid()` is built in on 13+)
- An SMTP relay (or Mailpit for development). Gmail and Microsoft 365 mailbox connectors are on the roadmap.

## Install

```bash
git clone https://github.com/walter-grace/cooks && cd cooks
pnpm install
createdb cooks
cp .env.example .env
```

Edit `.env`:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | e.g. `postgres://cooks:secret@localhost:5432/cooks` (a user is required for the job queue driver) |
| `COOKS_PUBLIC_URL` | Public URL of the API; used in tracking links and OAuth metadata |
| `COOKS_KEK` | 32-byte base64 key. Encrypts mailbox credentials and webhook secrets, signs tracking tokens. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `SMTP_URL` | Default outbound relay, `smtp://user:pass@host:587` |
| `COOKS_MAIL_FROM` | From address when a rep has no connected mailbox |
| `COOKS_PUBLIC_IPS` | Comma-separated egress IPs reported by `GET /v1/public-ip-list` |

## First run

```bash
pnpm bootstrap --email you@example.com --workspace "My Team" --password 'choose-one'   # migrates, creates admin + API key, sets the login password used by OAuth consent
pnpm --filter @cooks/api start      # :8080
pnpm --filter @cooks/worker start   # sequence engine + email sender
pnpm --filter cooks-mcp start       # :8081, optional
```

Migrations run on boot (`COOKS_AUTO_MIGRATE=true`) under an advisory lock, so API and worker can start together.

## Web UI

`pnpm web:build` writes `apps/web/dist`; the API serves it at `/app` (set `COOKS_WEB_DIR` to point elsewhere). Users sign in with email + password (set with `pnpm bootstrap --password` or by an admin) and get a 1-hour browser token scoped to their workspace role. During development run `pnpm --filter @cooks/web dev` for hot reload on :5173 with a proxy to the API.

The UI is monochrome by design: every colour token in `apps/web/src/styles.css` has zero chroma, and state is carried by weight (filled, soft, outlined, quiet). `pnpm qa:design <chromium> <base-url> <out-dir>` screenshots every page at desktop, phone and dark scheme and measures hue, contrast, tap targets, clipped text, spacing scale and numeric alignment (`scripts/qa/design-audit.mjs`); `scripts/qa/jev_design_review.py <out-dir> [--diff <other>]` sends those screenshots and metrics to Jev for a scored critique.

## Vercel

`apps/hosted` runs the whole product on Vercel with Neon for Postgres: the API and web app as one function, the worker as a cron tick. Create a project with the root directory `apps/hosted`, connect the repository, add Neon from the Marketplace (it sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED`), and add these variables for production and preview:

| Variable | Value |
| --- | --- |
| `COOKS_KEK` | 32 random bytes, base64 (`openssl rand -base64 32`) |
| `CRON_SECRET` | random; Vercel sends it to the cron route |
| `COOKS_PUBLIC_URL` | `https://<project>.vercel.app` or your domain |
| `COOKS_MCP_PUBLIC_URL` | the same host; the function serves the MCP transport at `/mcp` on it |
| `COOKS_SIGNUP` | `open`, `invite` or `off` |
| `COOKS_AUTO_MIGRATE` | `false` (migrations run at build time) |
| `RESEND_API_KEY` or `SMTP_URL` | optional, for verification, reset and invite mail |

The build bundles the two functions, copies the web app to the CDN and runs migrations over the direct connection. WebSockets (practice calls, the speech gate) ride on the same function, so set the function duration to the plan's maximum; `vercel.json` asks for 800 seconds. The cron tick runs every minute, which is the floor for the sequencing engine's timing. Previews are protected by Vercel Authentication; use `vercel curl` to probe them.

## Process management

Run each process under systemd, pm2 or your platform's supervisor. The worker is safe to run with several replicas: every job is idempotent and step executions are unique per enrollment. The API is stateless; put it behind any reverse proxy with TLS.

## Workspace settings

Stored as JSON on `workspaces.settings` until the settings API lands:

```json
{
  "timezone": "America/New_York",
  "sendWindow": { "days": [1,2,3,4,5], "start": "08:00", "end": "18:00" },
  "jitterSeconds": 300,
  "replyBehavior": "finish",
  "tracking": { "opens": true, "clicks": true },
  "requireUnsubscribeLink": true
}
```

Prospect, account and owner time zones take precedence over the workspace zone when scheduling.

## Mailbox connectors

Three ways to connect a rep's mailbox:

| Provider | Sending | Reading replies and bounces | Setup |
| --- | --- | --- | --- |
| SMTP + IMAP | `smtpUrl` on `POST /v1/mailboxes` (or the server `SMTP_URL` relay) | `imapUrl` (`imaps://user:pass@host:993`), polled every 2 minutes | Any mail host; app passwords work |
| Gmail | Gmail API, keeps Cooks' Message-ID | Gmail history API | Create an OAuth client in Google Cloud with scopes `gmail.send`, `gmail.readonly`; set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`; redirect URI `$COOKS_PUBLIC_URL/connect/google/callback`; reps visit `/connect/google/start` |
| Microsoft 365 | Graph `/me/messages` draft then send | Graph inbox delta | App registration with delegated `Mail.Send`, `Mail.Read`, `User.Read`, `offline_access`; set `MS_CLIENT_ID` / `MS_CLIENT_SECRET` (and `MS_TENANT` for single-tenant); redirect URI `$COOKS_PUBLIC_URL/connect/microsoft/callback`; reps visit `/connect/microsoft/start` |

Tokens are encrypted with `COOKS_KEK`. Replies finish or pause the enrollment according to the workspace `replyBehavior` and create a high-priority task; hard bounces suppress the address; out-of-office replies push the next step past the stated return date.

## Email that happens outside Cooks

Reps send and receive mail in their own clients, and other tools log activity in the CRM. `POST /v1/emails/import` (MCP: `cooks_import_email`) records those messages so the engine can act on them:

- `direction: outbound` stores a `sent` email linked to the prospect's active enrollment. Pass the provider's `messageId` (and `threadId` if you have it) so a later reply can be matched.
- `direction: inbound` runs the same pipeline as synced mail. The reply finishes or pauses the enrollment according to `replyBehavior`, creates a high-priority reply task, counts in reply statistics and raises an `email.replied` signal. Out-of-office messages are detected from the subject or forced with `autoSubmitted: true` and never finish an enrollment.

Repeated imports with the same `messageId` or `externalId` return the existing row with status 200.

## Delivery retries

A send that fails on a transient error (connection refused or reset, DNS, timeouts, SMTP 4xx, HTTP 429 or 5xx) stays `queued` and is retried after 1, 5, 15 and then 60 minutes, up to five attempts. A permanent error (SMTP 5xx, other HTTP 4xx) or the last failed attempt marks the email `failed`, opens a high-priority task for the owner when the email belongs to a sequence step, and emits `email.failed`. The `sendAttempts` and `error` fields on the email show what happened.

In development, point `SMTP_URL` at `smtp://127.0.0.1:1025`, not `localhost`: Node resolves `localhost` to IPv6 first and Mailpit listens on IPv4 only. Cooks rewrites `localhost` to `127.0.0.1` anyway, but the explicit address keeps other tools honest.

## Mailboxes

Each rep needs a mailbox row (`POST /v1/mailboxes`, a Cooks extension). With no per-mailbox credentials, the worker sends through `SMTP_URL` using the mailbox address as the sender; supply `smtpUrl` to send through the rep's own relay. Daily caps (`dailySendLimit`, default 50) and spacing (`minGapSeconds`, default 60) are per mailbox.

## Backups

Everything lives in Postgres, including the job queue (`pgboss` schema). Back up the database and the `.env` file.
