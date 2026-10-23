# Webhooks

Cooks posts signed JSON to the endpoints you register. The signature scheme, the `call.logged`
payload and the retry schedule match the upstream API, so a receiver written for it verifies
Cooks deliveries unchanged.

## Register an endpoint

```bash
curl -X POST $COOKS/v1/webhooks -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"data":{"url":"https://example.com/hooks/cooks","events":["call.logged","email.replied"]}}'
```

The response carries the signing secret once (`cooks-webhook-signing-key-…`). Before the endpoint
is saved Cooks sends a `webhook.verification` ping; the URL must answer 2xx within 15 seconds or
the request fails with 422. Omit `events` to subscribe to everything. Manage endpoints with
`GET/PATCH/DELETE /v1/webhooks/{id}`, `POST /v1/webhooks/{id}/actions/test` and
`GET /v1/webhooks/{id}/deliveries`. The UI lists them under Settings → Webhooks.

## Verify a delivery

Headers on every POST:

| Header | Value |
| --- | --- |
| `x-webhook-signature` | `t=<unix ms>,s=<base64 HMAC-SHA256(secret, "<t>.<raw body>")>` |
| `x-webhook-id` | Event id, stable across retries. Use it to dedupe |
| `x-webhook-event` | Event type |
| `x-webhook-attempt` | 1-based attempt number |

Recompute the HMAC over the exact raw body, compare in constant time, and reject timestamps older
than five minutes. `@cooks/core` exports `verifyWebhookSignature(header, rawBody, secret)` if you
run Node; the algorithm is small enough to port anywhere:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';
const [t, s] = header.split(',').map((kv) => kv.slice(kv.indexOf('=') + 1));
const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('base64');
const ok = timingSafeEqual(Buffer.from(expected), Buffer.from(s)) && Math.abs(Date.now() - Number(t)) < 5 * 60_000;
```

## Events

`call.logged` keeps the upstream envelope: `{ event, eventId, occurredAt, callData: { callId, … } }`.
Every other event uses `{ event, eventId, occurredAt, data: { … } }` with ids you can resolve
through the REST API.

| Event | When | `data` |
| --- | --- | --- |
| `call.logged` | A call is logged with a disposition (dialer or manual) | `callData` |
| `email.sent` / `email.delivered` / `email.opened` / `email.clicked` / `email.replied` / `email.bounced` | Outbound email lifecycle | `emailId`, `prospectId`, `sequenceStateId` |
| `message.sent` / `message.received` / `message.replied` / `message.failed` | SMS, iMessage and agent messages through Inkbox | `messageId`, `channel`, `prospectId`, `textPreview` |
| `prospect.opted_out` | A prospect texted STOP | `prospectId`, `channel`, `from` |
| `email.failed` | Delivery gave up: a permanent provider error, or a transient one after the last retry | `emailId`, `prospectId`, `sequenceStateId`, `attempts`, `transient`, `error` |
| `prospect.created` / `prospect.updated` / `prospect.unsubscribed` | Prospect changes | `prospectId` |
| `sequence_state.created` / `.paused` / `.resumed` / `.finished` | Enrollment changes | `sequenceStateId`, `prospectId`, `sequenceId`, `reason` |
| `task.created` / `task.due` / `task.completed` / `task.skipped` | Task queue | `taskId`, `prospectId`, `action` |
| `signal.created` | A buying signal is recorded (push, research, engagement, CRM) | `signalId`, `kind`, `prospectId`, `accountId` |

## Retries and disabling

A delivery counts as successful on any 2xx within 10 seconds. Otherwise Cooks retries after
30 s, 60 s, 2 min, 4 min, 6 min, 8 min and 9 min (eight attempts in about 30 minutes, each with
±20 % jitter). After 50 consecutive exhausted deliveries the endpoint is disabled and shows as
such in the UI; re-enable it with `PATCH /v1/webhooks/{id} {"data":{"enabled":true}}`.

Deliveries are deduplicated per endpoint on `callId` for calls, `emailId:kind` for email events
and `sequenceStateId:state` for enrollment events, so a replayed outbox event never double-posts.
