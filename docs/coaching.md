# Call coaching

Every recorded dialer call can get a transcript, talk statistics and an AI scorecard.

## Pipeline

1. Twilio finishes the recording and calls `/telephony/recording`.
2. The worker downloads the dual-channel WAV, splits it in pure Node (rep = left, prospect = right)
   and transcribes each channel through an OpenAI-compatible `/audio/transcriptions` endpoint.
3. Segments are merged by time into a speaker-labelled transcript with stats: talk ratio,
   longest monologue per side, questions asked, words per minute, interruptions, turn switches.
4. The workspace model scores the call against a fixed rubric (`contracts/coach-call`): opener,
   discovery, listening, value articulation, objection handling, next-step clarity, each 1 to 5,
   plus objections raised and whether they were handled, next steps, strengths, up to three concrete
   improvements, one coaching tip and timestamped highlights.

Results: `GET /v1/calls/{id}/insights`, the Calls page, or `cooks_call_insights`. Re-run with
`POST /v1/calls/{id}/actions/coach` / `cooks_coach_call`.

## Speech to text

Pick one:

| Option | Settings |
| --- | --- |
| OpenAI Whisper | Workspace AI provider `openai` with a key, or server `OPENAI_API_KEY` |
| Any whisper server with the OpenAI API (faster-whisper-server, whisper.cpp server, Speaches, Groq-compatible hosts) | `TRANSCRIBE_API_BASE=http://host:8000/v1`, optional `TRANSCRIBE_API_KEY`, `TRANSCRIBE_MODEL` |

Without a provider the call is marked `transcriptStatus: skipped` and nothing else happens.
Coaching uses the workspace's normal AI provider (Anthropic, xAI, OpenAI, OpenRouter, Ollama).

## Controls

Settings → Dialer toggles recording, transcription and coaching per workspace. Every coaching run
is an entry in the AI ledger (`/v1/agentRuns`) with tokens and cost, and low-confidence results are
flagged `needsReview` in the scorecard.
