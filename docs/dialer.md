# Dialer

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

## Calling

- **From a task**: call steps in sequences show a Call button; logging the call completes the task
  and advances the enrollment.
- **From a prospect page** or the Calls page: pick bridge or softphone.
- **From a bot**: `cooks_dial` (bridge), then `cooks_log_call`.
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

Environment: `TWILIO_API_BASE` points the client at `scripts/qa/mock-twilio.mjs` for local QA.

## Privacy

Recordings stay in your Twilio account; Cooks stores the recording SID and streams audio through
the API with your credentials. Delete the recording in Twilio (or disable recording in Settings)
to stop retaining it. Check call-recording consent rules for the regions you call.
