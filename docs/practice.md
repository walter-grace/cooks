# Practice calls

A rep rehearses a call against an AI prospect that listens and talks at the same time: it
interrupts when the rep rambles, hesitates, raises objections one at a time, and agrees to a meeting
only when the rep earns it. When the rep hangs up, the call gets the same transcript, talk
statistics and scorecard as a recorded call (`docs/coaching.md`).

Nothing is dialled. Practice calls never touch Twilio, Speko or a prospect's phone, so there is no
consent, recording-law or abandoned-call question to answer. The AI voice stays on the training
side of the house.

## How a call runs

1. The rep picks a built-in scenario or one of their own prospects on **Practice** in the web app.
2. `POST /v1/practice/sessions` creates a call record (`source: practice`, `mode: practice`) that
   carries the persona and standing instructions, and returns a token good for five minutes.
3. The browser opens `/practice/stream`, sends `{type: "start", ws, callId, token, sampleRate}`,
   then streams microphone audio as PCM16 frames. Cooks returns partner audio as PCM16 at 24 kHz,
   plus JSON `transcript`, `interrupt` and `ended` messages. An `interrupt` means the rep started
   talking over the partner, and the browser drops any audio it had queued.
4. `{type: "stop"}`, the time cap (`PRACTICE_MAX_SECONDS`, default 600) or a dropped socket ends the
   call. Cooks writes the transcript, computes talk stats, queues `ai.coach_call` when coaching is
   on for the workspace, and emits `call.completed`. The browser lands on the call page.

If the browser disappears before `stop`, `POST /v1/practice/sessions/{id}/actions/end` finalises
whatever transcript the socket had already saved.

Practice calls appear on the Calls page labelled "Practice", in `GET /v1/calls` with
`source: practice`, and in `cooks_call_insights` like any other call. The coaching rubric treats the
persona as the prospect.

## Partners

| `PRACTICE_PROVIDER` | What it is | Settings |
| --- | --- | --- |
| `off` (default) | Practice page shows how to turn it on | |
| `openai` | OpenAI Realtime speech-to-speech. Server-side turn detection, barge-in, both sides transcribed. | `PRACTICE_API_KEY` (falls back to `OPENAI_API_KEY`), optional `PRACTICE_MODEL` (default `gpt-realtime`), `PRACTICE_VOICE` (default `marin`), `PRACTICE_API_BASE` |
| `local` | Any full-duplex model behind a small WebSocket runner you host (below) | `PRACTICE_LOCAL_URL=ws://127.0.0.1:8765/duplex` |
| `mock` | Scripted partner for tests and demos; replies with a tone and a canned line when the rep stops talking | |

The OpenAI partner is written against the published Realtime guide and has not yet been exercised
against a live account from this repo; if OpenAI has renamed the speech-to-speech model, set
`PRACTICE_MODEL`. Rough cost in October 2026 is on the order of a few cents per minute of
conversation; the per-call cap keeps a forgotten tab from running up a bill.

### The local runner protocol

Full-duplex speech models trained on conversation (Block's Dessa, announced October 2026 as a
research preview that runs on an M4 Max MacBook Pro; NVIDIA's open VoiceChat) are the right
partner for this feature. None ships with a standard serving API, so Cooks defines the smallest
protocol a runner needs, and `PRACTICE_PROVIDER=local` speaks it:

```
client → runner  text    {"type":"start","sampleRate":16000,"instructions":"…","opening":"…","voice":"…"}
client → runner  binary  PCM16 mono rep audio at 16 kHz, 20 ms frames
runner → client  text    {"type":"ready","sampleRate":24000}
runner → client  binary  PCM16 mono partner audio at the ready sample rate
runner → client  text    {"type":"transcript","role":"rep"|"partner","text":"…","final":true}
runner → client  text    {"type":"interrupt"}            // partner yielded to the rep
runner → client  text    {"type":"error","message":"…"}
```

A runner that wraps a model is forty lines of Python around a WebSocket server. `instructions` is
plain prose (persona, situation, objections); a model that cannot take text instructions can
ignore it and use `voice` to pick a persona. Dessa itself is waitlist-only as of this writing
(block.xyz/dessa); the hook is here so it plugs in the day weights or an endpoint are available.

## Scenarios

Six built-in scenarios ship in `packages/core/src/telephony/practice/scenarios.ts`: a cold call to
a VP of Sales, a gatekeeper, a happy incumbent customer, a budget freeze, a technical skeptic, and
a renewal at risk. Each has a persona, a situation from the persona's side, and four objections
the partner raises when they fit. "Rehearse a real call" builds the same shape from a prospect's
name, title and account.

The partner's standing instructions (`partnerInstructions`) tell it to stay in character, keep
replies under three sentences, interrupt rambling, never say it is an AI, and never coach during
the call. Coaching happens afterwards, from the transcript, by the workspace's normal AI provider.

## API

| Method | Path | Scope |
| --- | --- | --- |
| GET | `/v1/practice/status` | `calls:read` |
| GET | `/v1/practice/scenarios` | `calls:read` |
| POST | `/v1/practice/sessions` `{data: {scenarioId?, prospectId?}}` | `calls:write` |
| GET | `/v1/practice/sessions/{id}` | `calls:read` |
| POST | `/v1/practice/sessions/{id}/actions/end` | `calls:write` |
| WS | `/practice/stream` (token from the session) | |

Limits: twenty open practice sockets per API process, one partner session each.
