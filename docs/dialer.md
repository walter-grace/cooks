# Dialer

Cooks has two dialer providers. **Twilio** carries calls a rep makes (phone bridge or browser
softphone). **Speko** places AI-voiced calls: a voice agent dials the prospect, follows your
script, and the outcome, transcript, summary, cost and recording land in Cooks. Both can be
connected at once; an admin picks which one the Call button uses under Settings → Dialer.
Every provider sits behind the same interface (`packages/core/src/dialer/providers`): place,
get, recording, hangup.

## Twilio

Cooks places and records calls through your own Twilio account. Two modes:

| Mode | Needs | How it works |
| --- | --- | --- |
| **Bridge** | Account SID + Auth Token, one Twilio number | Twilio rings the rep's phone first; when they pick up it dials the prospect and bridges the legs. Works from any phone, no browser audio. |
| **Softphone** | Bridge requirements + an API key pair + a TwiML App | The rep calls from the browser (Twilio Voice SDK). Twilio asks Cooks for TwiML at the app's voice URL. |

Both modes record dual-channel audio (rep on the left, prospect on the right), which is what makes
speaker-labelled transcripts and talk-ratio stats possible (see `docs/coaching.md`).

## Connect Twilio

1. Twilio Console → Account → copy the **Account SID** and **Auth Token**.
2. Buy or pick a voice-capable number.
3. Cooks → Settings → Dialer → paste SID and token. Cooks verifies them and lists your numbers.

For browser calling also:

4. Console → Account → API keys & tokens → create a **Standard** API key; keep the SID and secret.
5. Console → Voice → TwiML Apps → create one with **Voice request URL** set to
   `https://<your cooks host>/telephony/voice?ws=<workspace id>` (POST). The workspace id is shown in
   Settings → Dialer.
6. Paste the API key SID, secret and the TwiML App SID into Settings → Dialer.

Cooks must be reachable from Twilio for status, recording and TwiML callbacks. For local
development use a tunnel (`ngrok http 8080`, Cloudflare Tunnel) and set `COOKS_PUBLIC_URL` to it.
Every callback is verified with `X-Twilio-Signature` against your auth token.

## Speko (AI calls)

1. Create an API key at platform.speko.ai and paste it under Settings → Dialer → Speko. Cooks
   verifies it, stores it encrypted with `COOKS_KEK`, and lists your Speko numbers. Setting
   `SPEKO_API_KEY` on the server lets workspaces connect without pasting a key.
2. Pick a caller id. Numbers can be searched by area code and bought from the settings page.
   Buying is paid (setup fee plus a monthly rental on your Speko balance), so it always asks an
   admin to confirm the quoted price first.
3. Set the default script (instructions and opening line, with `{{ prospect.firstName }}`,
   `{{ account.name }}`, `{{ owner.name }}`, `{{ workspace.name }}` merge fields), the maximum
   length (hard ceiling 600 seconds) and the daily spend cap.

Place a call from a prospect page (AI call), a call task, the Calls page, or `cooks_place_ai_call`.
A successful request means the call is **queued**, not answered. The worker polls Speko every
10 seconds (or sooner when Speko's `call.status` webhook hits `/telephony/speko/webhook?ws=<workspace id>`,
verified with the Standard Webhooks signature when a secret is stored) until the call ends, then:

- stores the outcome (`answered`, `voicemail`, `no_answer`, `failed`), end reason, duration,
  cost, summary and the speaker-labelled transcript on the call;
- streams the recording through `GET /v1/calls/{id}/recording` (the signed Speko URL is never
  exposed);
- logs a disposition (Connected, Left voicemail, No answer, Not connected), which completes the
  linked call task, advances the sequence, fires `call.logged` and writes to HubSpot;
- queues AI coaching on the transcript when enabled.

Safety checks run before any request reaches Speko:

| Check | Behaviour |
| --- | --- |
| Do not call | Prospects flagged do-not-contact or with a Do-not-call disposition are refused (`DO_NOT_CALL`). |
| Quiet hours | Calls only go out 08:00 to 21:00 in the prospect's zone (prospect → account → owner → workspace). Refusals carry the next window (`QUIET_HOURS`). |
| Duration | `maxDurationSeconds` is capped at 600 whatever the request says. |
| Spend | Today's Speko cost plus an estimate for calls in flight must stay under the workspace cap (`SPEND_CAP`). |
| Credentials | API keys are held in memory per request and never written to logs, errors or responses. |

Speko error codes are translated into rep-facing messages (`INSUFFICIENT_CREDITS`,
`PHONE_NUMBER_KYB_ACCESS_SUSPENDED`, `PHONE_NUMBER_CONSENT_REQUIRED`,
`PHONE_NUMBER_PROVISIONING_CREDITS_REQUIRED`, price confirmation codes) and the original code is
returned in the error details so a bot can branch on it.

`scripts/qa/mock-speko.mjs` stands in for the Speko API locally (`SPEKO_API_BASE=http://127.0.0.1:18200`,
key `sk_live_qa`): sessions auto-play to a finished call with a transcript and recording.

## Calling

- **From a task**: call steps in sequences show a Call button; logging the call completes the task
  and advances the enrollment.
- **From a prospect page** or the Calls page: pick bridge or softphone.
- **From a bot**: `cooks_dial` (bridge), then `cooks_log_call`; or `cooks_place_ai_call` and
  `cooks_get_call_transcript` for Speko. `cooks_dialer_balance` shows credits and today's spend.
- **Without Twilio**: `POST /v1/calls` / `cooks_record_call` logs calls made elsewhere so the task
  queue, CRM and webhooks still see them.

Dispositions default to Connected, Meeting booked, Left voicemail, No answer, Busy, Wrong number,
Not interested, Call back later, Do not call. Add more with `POST /v1/callDispositions`.

## What logging a call does

`POST /v1/calls/{id}/actions/log` with an `outcome` or disposition:

1. stores disposition, notes and duration on the call;
2. completes the linked task (call steps);
3. emits `call.logged` with the upstream payload (`callData` with `userData`, `prospectData`,
   `accountData`, `disposition`, `sequenceData`, `recordingUrl`…), so webhook receivers written for
   the commercial API work unchanged;
4. writes a call engagement to HubSpot with duration, disposition and notes when the CRM is connected.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET/PUT/PATCH/DELETE | `/v1/workspace/telephony` | Connection, caller ids, record/transcribe/coach toggles |
| POST | `/v1/telephony/token` | Voice SDK access token for the signed-in user |
| POST | `/v1/calls/actions/dial` | Start a call (`mode: bridge | softphone`) |
| POST | `/v1/calls` | Log a call made elsewhere |
| POST | `/v1/calls/{id}/actions/log` | Disposition + notes |
| GET | `/v1/calls/{id}/recording` | Stream the recording (proxied, authenticated) |
| GET | `/v1/calls/{id}/insights` | Transcript, stats, coaching |
| POST | `/v1/calls/{id}/actions/coach` | Re-run transcription/coaching |
| POST | `/telephony/voice`, `/telephony/voice/bridge`, `/telephony/status`, `/telephony/recording` | Twilio webhooks (signed) |
| GET | `/v1/workspace/dialer` | Both connections and the chosen provider |
| PUT | `/v1/workspace/dialer/provider` | Choose `twilio` or `speko` |
| PUT/PATCH/DELETE | `/v1/workspace/telephony/speko` | Speko key, script, caps, caller id |
| GET | `/v1/workspace/telephony/speko/balance` | Credits, spend today, cap |
| GET/POST | `/v1/workspace/telephony/speko/numbers`, `…/numbers/available` | Owned numbers, search, buy (admin, `confirm: true`) |
| POST | `/v1/calls/actions/aiCall` | Place an AI call (202 = queued) |
| POST | `/v1/calls/{id}/actions/hangup` | End a running AI call |
| GET | `/v1/calls/{id}/transcript` | Outcome, summary, cost, transcript |
| POST | `/telephony/speko/webhook?ws=` | Speko `call.*` events (Standard Webhooks signature) |

Environment: `TWILIO_API_BASE` and `SPEKO_API_BASE` point the clients at `scripts/qa/mock-twilio.mjs` and `scripts/qa/mock-speko.mjs` for local QA; `SPEKO_API_KEY` is an optional server-wide key.

## Privacy

Recordings stay in your Twilio account; Cooks stores the recording SID and streams audio through
the API with your credentials. Delete the recording in Twilio (or disable recording in Settings)
to stop retaining it. Check call-recording consent rules for the regions you call.
