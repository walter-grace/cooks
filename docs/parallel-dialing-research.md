# Parallel dialing: research notes

Written 2026-10-22 before building the Cooks power dialer. Two surveys were run: one over Twilio-based
projects and Twilio's own documentation, one over everything else (Asterisk and FreeSWITCH dialers, Telnyx,
Jambonz, LiveKit, voice-AI platforms). Facts below that we could not confirm against a primary source are
marked UNVERIFIED. Nothing here is legal advice.

## What we were looking for

A Nooks-style dialer: the rep joins first and waits; the system dials three or four prospects at once; the
first person who says hello is connected to the rep with no beep, no announcement and no AI voice; every
other line hangs up at once; a second human who answers in the same moment is dropped and turned into a
callback; answering machines are detected and hung up, never connected.

The hard parts are (1) the race between two simultaneous human answers, (2) answering-machine detection
(AMD) latency, (3) getting the winner to the rep quickly, (4) hanging up siblings before another person
picks up, and (5) the abandoned-call rules that silently dropping a person runs into.

## Open-source landscape

There is no credible open-source parallel dialer. Every GitHub hit for "parallel dialer", "power dialer",
"first answer wins" and friends is a 0–3 star project, and most are sequential auto-dialers. We read the
code of the ones closest to our design and borrowed ideas, never code, where licenses were unclear.

| Project | License | What it is | What we took |
| --- | --- | --- | --- |
| [kaiquelupo/twilio-power-dialer-with-async-amd](https://github.com/kaiquelupo/twilio-power-dialer-with-async-amd) | MIT | Twilio Functions + TaskRouter power dialer (2020). `make-call` places `calls.create` with `machineDetection: 'Enable'`, `asyncAmd: 'true'`, `machineDetectionTimeout: 5`, `machineDetectionSilenceTimeout: 3000`; `evaluate-call` receives `AnsweredBy` and either enqueues the human to an agent or updates the call with hangup TwiML. One line per agent, so no race handling. | The async-AMD parameter set and the "update the live call with new TwiML on the verdict" move. |
| [kaiquelupo/twilio-power-dialer](https://github.com/kaiquelupo/twilio-power-dialer) | MIT | Synchronous-AMD predecessor of the above. | Nothing new. |
| [kofiowusuai-lab/open-dialer](https://github.com/kofiowusuai-lab/open-dialer) | MIT | Chrome-extension power dialer on the Voice SDK, one call at a time, dispositions to Google Sheets. Carries a TCPA/DNC warning in its README. | The reminder that a self-hosted dialer still owes its users a compliance gate. |
| [revenue007/S9N-Dialer-Telnyx](https://github.com/revenue007/S9N-Dialer-Telnyx) | none (all rights reserved) | Telnyx TeXML port of a Twilio dialer: the browser sits in a persistent conference, `dial_out` creates one outbound leg with synchronous AMD and a `voice_join` URL that returns conference TwiML for humans and hangup for machines. One line at a time. | Confirmed the "persistent conference, promote the winner in" shape. No code read beyond design; nothing copied. |
| [Girihanbudi/salesdoc-assignment](https://github.com/Girihanbudi/salesdoc-assignment) | none | Two-line toy with a mock CRM; "first lead to answer takes the agent; the other line is dropped". | Nothing. |
| [TwilioDevEd/browser-calls-node](https://github.com/TwilioDevEd/browser-calls-node) and browser-dialer-* | MIT (archived) | Voice SDK token + TwiML App wiring. | The TwiML App voice-URL pattern we already used for the softphone. |
| VICIdial, GoAutoDial, OSDial, vTdialer, ICTDialer, Newfies-Dialer | AGPL / GPL / LGPL / unstated | Asterisk and FreeSWITCH predictive dialers. | Ideas only (see below). No code. |

Ideas worth keeping from the Asterisk and FreeSWITCH world, from a
[2026 Asterisk forum write-up on VICIdial AMD](https://community.asterisk.org/t/vicidial-and-amd-in-2026-what-they-are-how-they-work-what-changed/112393)
(the author sells VICIdial consulting; numbers UNVERIFIED):

- Classic AMD decides 70–80% of calls in 600–800 ms; the rest take up to the 5 s analysis cap and come back
  as NOTSURE. Accuracy is 75–82% at defaults, 85–92% after per-carrier tuning, 92–96% with an AI classifier
  that adds another 0.5–1 s.
- Never route NOTSURE or NOAUDIODATA to an agent. Cooks follows this: `unknown` hangs up by default
  (`onUnknown: 'hangup'`), with an admin switch to connect instead.
- iOS call screening plays a synthetic greeting that AMD can classify as a machine (UNVERIFIED).

Creative designs we considered from outside Twilio:

- **Switch-side simultaneous ring.** FreeSWITCH `originate` with comma-separated endpoints and Jambonz's
  `dial` verb ("all targets are outdialed at the same time … connected to the first endpoint that answers",
  up to 10 targets) do first-answer-wins in the switch, so there is no app-level race and no sibling
  cleanup code. The catch: the switch races on SIP 200 OK, and a voicemail answers with 200 OK too, so it is
  a fast race, not a human race. You still need AMD or a confirm step before bridging.
- **Confirm before candidate.** Jambonz's `confirmHook` only lets a target win after it completes a screening
  step. This is the idea Cooks uses: a prospect leg is held in silence and only becomes a *candidate* when
  AMD says human; then one atomic claim decides the winner.
- **WebRTC room instead of a conference.** LiveKit SIP (`CreateSIPParticipant` with `wait_until_answered`)
  and Daily put the rep in a room and move answered legs in. Same shape as a conference with a different
  media server; LiveKit's docs also say voicemail answers normally and needs AMD.
- **Telnyx Call Control** has `answering_machine_detection: premium` with explicit human / machine /
  silence / fax results and a `conference_config` to dial straight into a conference. It is the natural
  second carrier for Cooks (REST shape close to Twilio's, fetch-friendly, good AMD). SignalWire, Plivo,
  Vonage, Bandwidth, Vapi, Retell and Bland were not researched in depth.

## Twilio facts we rely on

All verified against Twilio's documentation on 2026-10-22 unless marked.

- Answering Machine Detection ([docs](https://www.twilio.com/docs/voice/answering-machine-detection),
  [FAQ](https://www.twilio.com/docs/voice/answering-machine-detection-faq-best-practices)):
  `MachineDetection=Enable|DetectMessageEnd`, `AsyncAmd=true`, `AsyncAmdStatusCallback(+Method)`,
  `MachineDetectionTimeout` 3–59 s (default 30), `MachineDetectionSpeechThreshold` 1000–6000 ms (default
  2400), `MachineDetectionSpeechEndThreshold` 500–5000 ms (default 1200), `MachineDetectionSilenceTimeout`
  2000–10000 ms (default 5000). `AnsweredBy` is `human`, `machine_start`, `fax` or `unknown` with `Enable`
  (`machine_end_beep|silence|other` with `DetectMessageEnd`). With `AsyncAmd=true` the call connects to its
  TwiML immediately and the verdict is posted later with `CallSid`, `AccountSid`, `AnsweredBy`,
  `MachineDetectionDuration`. Results typically arrive about 4 s after answer at defaults; for minimal agent
  idle time Twilio suggests `Enable` with a speech threshold of 1800–3000 ms and a speech-end threshold of
  1400–1500 ms. AMD cannot run on `<Dial><Conference>` legs, which is why Cooks dials with `calls.create`
  and redirects the winner into the conference afterwards. Cooks defaults: timeout 5 s, speech 2400,
  speech-end 1200, silence 3000, all adjustable under Settings → Dialer.
- Calls API ([docs](https://www.twilio.com/docs/voice/api/call-resource)): update with `Twiml` or `Url`
  redirects a live call; `Status=canceled` ends a queued or ringing call, `Status=completed` ends an
  answered one. A call canceled while still queued sends no status callbacks. Cooks tries the likely one
  first and treats a 404 / 20404 as already gone. Redirecting a *ringing* call is not documented, so Cooks
  only redirects after the AMD verdict (the leg is answered by then).
- Conference ([TwiML](https://www.twilio.com/docs/voice/twiml/conference),
  [Participants](https://www.twilio.com/docs/voice/api/conference-participant-resource)): `beep=false`,
  `startConferenceOnEnter`, `endConferenceOnExit`, `waitUrl`, `statusCallback` +
  `statusCallbackEvent="start end join leave"`, `participantLabel`. Only the rep's leg starts and ends the
  room; prospect legs join with both flags false. The Participants API can also dial a participant straight
  into a conference with AMD (`AmdStatusCallback`), but that joins every leg to the room first and removes
  losers later, which is the wrong order for us. `waitUrl=""` for silence is the documented way to disable
  hold music; the rep starts the room so no wait music would play anyway (UNVERIFIED in a live account).
- Call recording controls: `POST /Calls/{sid}/Recordings.json` starts a recording on a live leg
  (`RecordingChannels=dual`), `POST /Calls/{sid}/Recordings/{RecordingSid}.json` with `Status=stopped`
  ends it. Cooks records the rep's leg from the moment a prospect joins until that prospect leaves, so each
  conversation is its own dual-channel file that the existing transcription and coaching pipeline accepts.
- Webhook signatures ([docs](https://www.twilio.com/docs/usage/security)): base64 HMAC-SHA1 over the full
  URL (query included) plus the sorted POST parameters, compared with `X-Twilio-Signature`. HTTPS voice
  callbacks drop the port from the URL. Cooks rebuilds the URL from `COOKS_PUBLIC_URL` before validating.
- Voice JS SDK: `@twilio/voice-sdk` 2.x, Access Token with a Voice grant (`outgoingApplicationSid`,
  `incomingAllow`), `device.connect({ params })` posts the params to the TwiML App's Voice URL. Cooks passes
  `kind=parallel&sessionId=…` and answers with the rep's conference TwiML.

## Compliance

Dropping a second live answer is exactly what the FTC Telemarketing Sales Rule calls an abandoned call:
16 CFR 310.4(b)(1)(iv) prohibits abandoning an outbound call, defined as a person answering and no sales
representative being connected within two seconds of the person's completed greeting. The safe harbor in
310.4(b)(4) requires: no more than 3% of calls answered by a person abandoned per campaign or per 30-day
period; at least 15 seconds or four rings before disconnecting an unanswered call; a prompt recorded message
with the seller's name and telephone number whenever no representative is available within two seconds;
and records under 310.5. Calls between a telemarketer and a business are largely exempt (310.6(b)(7)).
The TCPA (47 U.S.C. 227, 47 CFR 64.1200) and state rules apply separately.
Sources: [16 CFR 310.4](https://www.law.cornell.edu/cfr/text/16/310.4),
[16 CFR 310.6](https://www.law.cornell.edu/cfr/text/16/310.6).

What Cooks does with that:

- An admin must choose **B2B** or **consumer** mode and confirm it before any session can start.
- Consumer mode caps batches at two lines, requires an abandoned-call message (seller name and number) that
  is played to a dropped person before the hangup, tracks the 30-day abandonment rate (dropped lines over
  lines a person answered) and falls back to one line per batch while that rate is at or above 3%.
- Every dropped person becomes a high-priority callback task for the rep.
- Prospects flagged do-not-contact or ever logged with a Do-not-call disposition are skipped before dialing,
  as are prospects outside 08:00–21:00 in their own time zone. Ring timeout defaults to 25 s (minimum 15).
- Each line has its own call row, so dials, drops and connects are all on record.

## Design that came out of this

1. Rep joins a silent Twilio conference first (browser leg via the TwiML App, or Twilio rings their phone).
2. Cooks dials N prospects with `calls.create` + async AMD. Each answered leg gets `<Pause>` TwiML: silence
   while AMD runs, hangup if nothing happens.
3. On `AnsweredBy=human` the leg tries to claim the session with one SQL statement:
   `UPDATE dial_sessions SET connected_line_id=… WHERE id=… AND connected_line_id IS NULL AND status='dialing' AND batch=…`.
   Exactly one such statement returns a row under Postgres row locking. The winner is redirected into the
   conference (`beep=false`), the rep's leg starts recording, and every sibling is dealt with at the same
   time: still ringing → `canceled`; already answered → treated as a dropped person (consumer message if
   configured, callback task).
4. A human that loses the claim is dropped with a callback task. Machines, faxes and unknowns are hung up and
   logged. Every carrier receipt is written to `dial_events` with a unique key first, so redelivered
   webhooks are no-ops.
5. The winner leaving the conference puts the session in `wrapping`; the rep logs the call and dials the
   next batch, or auto-dial does it when a batch ends with nobody connected.

The carrier is behind `ParallelCarrier` (`packages/core/src/dialer/providers/types.ts`): dial rep, dial
prospect with AMD, join conference, hang up leg, say-and-hangup, start/stop recording, end conference, and
the two instruction documents. Telnyx or Jambonz would implement that interface; the engine in
`packages/core/src/telephony/parallel.ts` would not change.

## Round two: hearing the pickup (2026-10-22)

The question this time was whether we could pick up the words ourselves and beat carrier AMD to the
"human" verdict, since every second between "Hello?" and the bridge is a second in which the person hangs
up. Three leads were checked.

**MacParakeet** ([macparakeet.com](https://macparakeet.com/), [moona3k/macparakeet](https://github.com/moona3k/macparakeet),
GPL-3.0). A free Mac app plus `macparakeet-cli` that runs NVIDIA's Parakeet on Apple Silicon through
FluidAudio CoreML, with WhisperKit, Cohere Transcribe and NVIDIA Nemotron as alternative engines. It is a
very good local file transcriber (dictation, meeting capture, diarization, JSON output) but it exposes no
HTTP or streaming API, and GPL-3.0 code cannot be vendored into this MIT repo. What we took: the engine
shortlist (Parakeet for batch, Nemotron Speech for streaming), the habit of keeping audio on the box, and
the CLI's "spec --json" idea for machine-readable automation. The CLI could still transcribe call
recordings for coaching on a Mac self-host; that is a separate, optional provider and was not built here.

**NVIDIA Nemotron Speech streaming** ([nvidia/nemotron-speech-streaming-en-0.6b](https://huggingface.co/nvidia/nemotron-speech-streaming-en-0.6b)).
A cache-aware streaming FastConformer transducer with 80 / 160 / 560 / 1120 ms chunk sizes chosen at
inference time, roughly 2.3% WER on LibriSpeech clean at the slow setting. sherpa-onnx (Apache-2.0) ships
Node bindings (`sherpa-onnx-node`) with an `OnlineRecognizer` for NeMo streaming transducers and an int8
Nemotron export, so a fully local, on-prem recognizer is possible from Node without Python. The
`sherpa` provider in `packages/core/src/telephony/speech/providers/sherpa.ts` targets that API; it has
not yet been run against a downloaded model from this repo.

**Jev on OpenRouter** ([docs](https://openrouter.ai/docs/guides/community/jev), model `typesafe/jev-1.14`,
alias `~typesafe/jev-latest`). TypeSafe's "System One" decision model: state in, typed Choice / Noul /
Score / Box question in, a decision with probabilities out. Launch claims put it at 70 to 500 ms end to end;
output tokens are free and input is about $0.042 per million, so a verdict costs about $0.00002. It
reads text and images, not audio, so it is the judge, not the ears. Separately, `typesafe/jev-router`
is a hosted router that picks a generative model per request; not relevant here.

**Twilio Media Streams** ([TwiML `<Stream>`](https://www.twilio.com/docs/voice/twiml/stream),
[message protocol](https://www.twilio.com/docs/voice/media-streams/websocket-messages)). `<Start><Stream>`
forks a call's audio to a `wss://` endpoint and continues with the next verb at once, so it drops into
our existing `<Pause>` hold without changing the hold. Frames are 8 kHz μ-law, 20 ms, base64 in JSON,
with a `start` message that carries `<Parameter>` values as `customParameters` (query strings are not
allowed on the URL). The upgrade itself is not signed, hence the HMAC token parameter. Async AMD and a
`<Start><Stream>` each take one of the four forks a call allows.

Prior art for speech-based machine detection is thin: Asterisk's `app_amd` and FreeSWITCH's `mod_amd`
are the same energy / silence heuristics the carriers run; a 2024 paper
([arXiv 2410.08235](https://arxiv.org/html/2410.08235v1)) trains a YAMNet-plus-RNN classifier on live
audio to 96–98% accuracy but reports no latency against AMD. Nothing open-source combines words,
timing and a decision model the way the gate here does.

### What was built

`packages/core/src/telephony/speech/`: μ-law decode, resampling and a Goertzel beep detector
(`audio.ts`); an adaptive energy VAD that produces a timeline rather than word boundaries (`vad.ts`); a
rule judge with 40-odd voicemail / IVR phrases and a greeting list (`judge.ts`); the Jev client
(`jev.ts`); recognizer adapters for OpenAI Realtime transcription, sherpa-onnx and a scripted mock; the
`SpeechGate` that ties them together and emits one verdict; and the signed stream token. The engine
settles a line on its first verdict with a conditional `UPDATE … WHERE answered_by IS NULL`, so the gate
and AMD can race safely. Measured on the mock: "Hello?" connects at about 1.1 s of audio; a voicemail
greeting is dropped at the first phrase (about 1.0 s); the mock's AMD verdict lands at 3.0 s.
