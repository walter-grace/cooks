# Inkbox channels

[Inkbox](https://inkbox.ai) gives each rep or AI agent an **identity**: an email address, a phone
number for SMS and MMS, and an iMessage line, plus hosted outbound calls and agent-to-agent tasks.
Cooks connects a workspace to Inkbox, maps identities to reps, sends sequence steps through them,
and receives every reply through one signed webhook.

## Connect

1. Create an admin-scoped API key at inkbox.ai → API keys and paste it under Settings → Channels.
   Cooks verifies it, stores it encrypted with `COOKS_KEK`, and pulls the identities.
2. Map each identity to the Cooks user it sends as. Mapping creates a mailbox row (provider
   `inkbox`) for the identity email, so the sequence engine can pick it like Gmail or SMTP.
3. Subscribe the identity to Cooks' webhook. Cooks creates the identity signing key (Inkbox
   returns it exactly once), stores it encrypted, and registers a subscription for
   `message.received`, `text.received`, `imessage.received`, `call.ended`, `a2a.task.created`
   and `a2a.task.message`, with a bearer `auth_token` Cooks generated.

Cooks must be reachable from Inkbox at `COOKS_PUBLIC_URL/webhooks/inkbox?ws=<workspace id>`.
Locally, run a tunnel.

## Outbound

| Step action | What happens |
| --- | --- |
| `auto_email` on an Inkbox mailbox | Sent through `POST /api/v1/mail/mailboxes/{email}/messages` with the Message-ID Inkbox assigns, so replies thread back. |
| `auto_sms` | The step body (Liquid merge fields) goes out from the identity number after the preflight below. |
| `auto_imessage` | Same, over the identity's iMessage line (carrier fallback to SMS). |
| `auto_ai_call` | The step body is the task brief for an Inkbox hosted call agent; voicemail behaviour is `leave_message`. The call row is finished by `call.ended`. |
| `manual_sms`, `manual_imessage` | A task for the rep with the suggested text. |

One-off sends: `POST /v1/messages` or `cooks_send_sms` / `cooks_send_imessage`; `POST /v1/calls/actions/inkboxCall` for a hosted call.

### SMS preflight

Before any text leaves Cooks:

| Check | Result |
| --- | --- |
| Prospect flagged do-not-contact, or texted STOP | Blocked, `do_not_contact` / `opted_out` |
| Outside 08:00–21:00 in the prospect's zone (prospect → account → owner → workspace) | Sequence steps wait for the next window; one-off sends are refused with `QUIET_HOURS` |
| US number without `opted_in` in Inkbox's SMS consent registry (the recipient must have texted START) | Blocked, `not_opted_in` |
| An outbound phone contact rule on the identity blocks the number | Blocked, `contact_rule` |
| Inkbox refuses at send time (403 `recipient_not_opted_in`, `recipient_opted_out`, spam filter) | Blocked with Inkbox's code; `recipient_opted_out` also marks the prospect |

Blocked sequence messages are skipped (the enrollment moves on) with the reason stored on the
message and counted as `messages.blocked` in sequence analytics.

## Inbound

`POST /webhooks/inkbox?ws=<workspace id>` accepts Inkbox deliveries. Every request must carry the
subscription bearer token; when the identity has a signing key, `X-Inkbox-Signature`
(`sha256=<hex HMAC-SHA256(key, "<request id>.<timestamp>.<raw body>")>`, 5-minute window) is
verified too. Events are deduplicated on the envelope `id`, so retries and replays are no-ops.

| Event | What Cooks does |
| --- | --- |
| `message.received` | Runs the mail reply pipeline through the identity mailbox: match by Message-ID, thread or sender; mark the outbound replied; finish or pause the enrollment per `replyBehavior`; high-priority reply task; `email.replied` event and signal. |
| `text.received`, `imessage.received` | Match the sender to a prospect by phone; thread onto the latest outbound on that channel; apply the reply policy; `manual_sms` / `manual_imessage` task; `messages.replied` and `inbox.replies` counters; `sms.replied` / `imessage.replied` signal. A STOP-family keyword opts the prospect out (`smsOptOutAt`, do-not-contact) and emits `prospect.opted_out`. |
| `text.delivered`, `*.delivery_failed`, `message.bounced` | Delivery state on the message row. |
| `call.ended` | Stores (or completes) the call with outcome, duration, transcript (the full transcript is fetched when the webhook copy is abridged) and post-call action items as the summary, logs the disposition, and advances an `auto_ai_call` step. |
| `a2a.task.created`, `a2a.task.message` | Kept in the inbox as an agent message with a task for the owner. |

The same code path serves `POST /v1/messages/import` and `cooks_import_message`, which is how a
future Gmail import or any other tool can hand Cooks an inbound email, text or iMessage.

Inbound content is untrusted. Cooks stores and displays it as text, never renders inbound HTML,
never follows links in it, and never treats it as instructions.

## Surfacing

- **Inbox** page: email, texts, iMessages, agent messages and calls across prospects, newest
  first (`GET /v1/inbox`, `cooks_inbox_list`).
- **Prospect page**: the same, for one prospect, with a Message button for SMS / iMessage.
- **Sequence analytics**: `messages.sent`, `messages.replied`, `messages.blocked` and
  `inbox.replies` (every reply that arrived through Inkbox, any channel).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET/PUT/DELETE | `/v1/workspace/channels/inkbox` | Connection and identities |
| POST | `/v1/workspace/channels/inkbox/actions/sync` | Re-pull identities |
| PUT | `/v1/workspace/channels/inkbox/identities/{id}/user` | Map to a rep (creates the mailbox) |
| POST | `/v1/workspace/channels/inkbox/identities/{id}/actions/subscribe` | Webhook subscription + signing key |
| GET/POST | `/v1/messages` | List, send SMS / iMessage |
| POST | `/v1/messages/import` | Shared inbound import |
| GET | `/v1/inbox`, `/v1/prospects/{id}/inbox` | Unified inbox |
| POST | `/v1/calls/actions/inkboxCall` | Hosted call from a brief |
| POST | `/webhooks/inkbox?ws=` | Inkbox deliveries (bearer + signature) |

Environment: `INKBOX_API_BASE` points the client at a mock for local QA.
