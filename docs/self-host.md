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

## Mailboxes

Each rep needs a mailbox row (`POST /v1/mailboxes`, a Cooks extension). With no per-mailbox credentials, the worker sends through `SMTP_URL` using the mailbox address as the sender; supply `smtpUrl` to send through the rep's own relay. Daily caps (`dailySendLimit`, default 50) and spacing (`minGapSeconds`, default 60) are per mailbox.

## Backups

Everything lives in Postgres, including the job queue (`pgboss` schema). Back up the database and the `.env` file.
