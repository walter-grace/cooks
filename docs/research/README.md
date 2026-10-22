# Research notes

Public-source research used to design Cooks. Nothing here is Nooks code or proprietary material;
these are notes compiled from marketing pages, help-center articles, engineering blog posts, job
postings and public API documents.

- `nooks-public-research.md`: architecture, published numbers, public docs index, open-source
  building blocks, comparable products, compliance notes (compiled 2026-10-22).
- Upstream API contract: `spec/nooks-upstream.openapi.yml` (vendored from developer.nooks.in with
  `spec/upstream.lock.json` recording the hash and fetch time).

## What this research changes for Cooks

| Area | Fact from research | Cooks decision |
| --- | --- | --- |
| Sequencing engine | Nooks runs AI Sequencing on Temporal with Node workers; activities capped at 100 accounts | Cooks uses pg-boss (Postgres only, simpler self-host). Keep job payloads small and idempotent; Temporal stays an option behind the `JobsPort`. |
| Dialer core | Twilio Voice JS (browser WebRTC) + Node orchestrator; legs likely parked in conferences / Media Streams; connect p50 < 250 ms | Dialer phase: Twilio Voice JS softphone, Conference-per-rep with parked prospect legs, Media Streams to a detection service. jambonz/FreeSWITCH as a later Twilio-free option. |
| Human detection | Custom audio encoder + Mamba, 100 ms cadence, ~7M auto-labeled calls, tunable decision layer | Out of scope for v1. Start with Twilio AMD (`MachineDetection`, `AsyncAmd`) and silero-vad + beep dataset; design the decision layer (threshold/window/delay) as a pluggable module. |
| Number reputation | Rotate after 60 dials/day; spam tests daily and every 60 dials; First Orion / Hiya / TNS registration | Dialer phase: number pool table with per-day dial counters, rotation at 60, spam-check job; document Free Caller Registry + STIR/SHAKEN A-attestation. |
| Pacing | Adaptive/Turbo adjusts line count per second from pickup likelihood (needs cross-workspace data opt-in) | Later: pickup-probability model per workspace only; cap abandon rate to the TSR 3 % safe harbor. |
| Compliance | TSR 2-second connect rule, 3 % abandon cap, FCC-24-17 (AI voice = artificial voice), FCC-22-85 (ringless VM = call), STIR/SHAKEN | Dialer phase ships with abandon-rate guardrails, consent flags on prospects, calling-hour limits, DNC scrub hook, recording-consent setting per state. |
| Salesfloor | Rooms, listen-in, whisper coaching (Vonage/TokBox today) | Later: LiveKit SFU + coturn; listen-in as muted participant; whisper as one-way track. |
| Extension | Chrome MV3 side panel for Gmail / CRM / LinkedIn | Later: MV3 extension that talks to the Cooks API with an OAuth token. |
