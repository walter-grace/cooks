# Signals

A signal is a dated, scored observation about a prospect or account that suggests it is time to
reach out. Signals land in one feed (Signals page, `GET /v1/signals`, `cooks_list_signals`) and
rules can act on them automatically.

## Sources

| Source | Kinds | How it arrives |
| --- | --- | --- |
| Email engagement | `email.clicked`, `email.engaged` (3+ opens), `email.replied` | Derived by the worker from tracking and inbound mail |
| Web research | `research.funding`, `.hiring`, `.news`, `.tech`, `.leadership`, `.expansion`, `.product`, `.event` | Prospect research (`cooks_research_prospect`) and account scans (`cooks_scan_account`, Signals → Scan, or the daily scheduler) |
| Your bot or integration | anything `category.type`, e.g. `web.visit`, `intent.topic`, `crm.job_change`, `custom.event` | `POST /v1/signals` / `cooks_push_signal` |

Every signal has `kind`, `title`, optional `url`, `score` 0..1, `occurredAt`, `status`
(`new`, `acted`, `dismissed`) and the prospect/account it belongs to. `dedupeKey` makes pushes
idempotent; research findings are deduped by content so repeated scans never double-post.

## Pushing from a bot

```json
POST /v1/signals
{"data":{"kind":"web.visit","title":"Visited /pricing twice today","url":"https://globex.com/pricing",
 "score":0.8,"prospect":{"email":"ada@globex.com"},"dedupeKey":"ga4:visit:2026-10-22:ada"}}
```

Attach by `prospect.id` or `prospect.email`, or by `account.id` or `account.domain`. Unknown
prospects return 422 so the bot can create the prospect first (`cooks_create_prospect`).

## Rules

Settings → Signals (admins) or `POST /v1/workspace/signalRules`:

- `kindPattern`: exact kind, a prefix such as `research.*`, or `*`
- `minScore`: ignore weaker signals
- `action: enroll` with `sequenceId` and `ownerId`, or `action: task` with `ownerId`, optional
  `taskAction` and `taskNote`

Rules run as soon as a signal is recorded. A signal fires at most one enroll and one task; a
prospect already active in the sequence is skipped. Fired counts show on each rule.

## Daily account scans

The worker runs `signals.scan_due` every morning: accounts with a prospect in an active
enrollment whose last scan is older than seven days are scanned, at most ten per workspace per
day, using the workspace AI provider (OpenRouter adds live web search). Set
`COOKS_SIGNAL_SCAN_DAYS=0` to disable. Each scan is a run in the AI ledger with its cost.
