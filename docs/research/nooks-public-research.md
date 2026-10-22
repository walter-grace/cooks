# Nooks reverse-engineering research (public sources, 2026-10-22)

Compiled by the project owner from public sources. Reproduced here as reference material for
contributors. See `README.md` in this folder for how it maps onto Cooks decisions.

## 1. What Nooks is

Nooks (Nooks Communications, Inc., San Francisco; app at app.nooks.in) sells an "agent workspace" for outbound sales. Its main product is an AI parallel dialer. It calls 2 to 5 prospects at once, uses a real-time audio model to spot the first live human, connects the rep, and hangs up the other lines. Around that it has a virtual salesfloor (shared rooms, listen-in, live coaching), AI coaching and roleplay "training bots", voicemail drop, number reputation management, AI Sequencing, and CRM/SEP sync.

It began in 2020 as a Stanford virtual classroom, became a virtual office in 2021, and turned into a virtual salesfloor in early 2022. The dialer came next, and AI Sequencing launched in 2026.

Key point: the moat is the human-detection model, not the telephony. They run on Twilio and have published the model design: a pretrained audio encoder plus Mamba layers, a prediction every 100 ms, about 7M auto-labeled calls, and a tunable decision layer.

## 2. Likely architecture

Components (labeled from job posts, blog, support docs, Porter case study; connections inferred):

- Rep browser: React, TS, MobX, Twilio Voice JS (WebRTC)
- Dialer orchestrator: Node/Express/TS, WebSockets, Redis, Firestore
- Twilio Voice: N outbound legs + audio stream (inferred: Conferences/Media Streams)
- Audio model: encoder + Mamba, 100 ms frames, on K8s via Porter
- Decision layer: connect / hold / hang up / drop VM
- SEP / CRM: Outreach, Salesloft, Salesforce, HubSpot
- Virtual salesfloor: rooms, listen-in, coaching

Flows: SEP/CRM → orchestrator (tasks, call lists); orchestrator → Twilio (dial 2-5 lines); Twilio → audio model (packets); model → decision layer (probabilities); decision → orchestrator (verdict); orchestrator → rep browser (bridge live human); orchestrator → SEP/CRM (log call + disposition).

Documented: Twilio carries the calls; the model buffers Twilio audio packets to predict every 100 ms; syncing call state between Twilio, backend and frontend is a core concurrency problem; signals include raw audio, transcription, silence detection, LLM embeddings, few-shot classification; one model serves parallel dialing (precision), power dialing (recall) and beep detection; moved from Fly.io and Cloud Functions to Kubernetes in their own VPC via Porter (infra cost down ~50 %); AI Sequencing runs on Temporal with Node.js workers; CD on GitHub Actions.

Inferred: each prospect leg is parked (conference or media streaming) while the model listens, then bridged to the rep's WebRTC leg on a human verdict. Adaptive/Turbo pacing is a pickup-probability model trained on cross-workspace data (requires Data Sharing opt-in).

## 3. Published numbers

- Lines per rep: 2-5 parallel; Turbo averages about 6
- Model cadence: one prediction every 100 ms on buffered Twilio audio
- Hand-labeled seed set: 40,000+ calls; auto-labeling via baseline model + multimodal LLM ensemble on 10M calls, ~80 % agreement, final ~7M calls
- Model: pretrained audio encoder + Mamba state-space layers
- Decision layer: parallel detectors (threshold, window, delay), tuned by replaying production traces with multi-objective optimization
- Connect latency (Porter): p50 < 250 ms, p75 < 500 ms, p90 < 900 ms
- In-house beep detection cut ~$7k/month from the Twilio bill
- Number rotation: auto-rotate after 60 dials/day; spam test about daily and after every 60 dials
- Network: Twilio media UDP 10,000-60,000 to 168.86.128.0/18; TURN 3478; jitter < 30 ms, RTT < 200 ms

## 4. Public docs and resources

Engineering blog: Low-Latency Human Detection at Scale (https://www.nooks.ai/blog-posts/low-latency-human-detection-at-scale); Behind AI Sequencing: Nested Parallelism (https://www.nooks.ai/blog-posts/behind-ai-sequencing-rising-above-nested-parallelism); Full-Auto CD Pipeline (https://www.nooks.ai/blog-posts/designing-a-robust-full-auto-cd-pipeline); index https://www.nooks.ai/categories/engineering-posts. Porter case study: https://www.porter.run/case-study/nooks.

API: docs https://developer.nooks.in/ ; spec https://developer.nooks.in/openapi.yml ; OAuth metadata https://oauth.nooks.in/.well-known/oauth-authorization-server ; MCP metadata https://mcp.nooks.in/.well-known/oauth-protected-resource ; OAuth app setup https://support.nooks.ai/articles/9129590393-how-to-set-up-a-nooks-oauth-app ; third-party profile https://github.com/api-evangelist/nooks.

Help center: Parallel Dialing Explained (…/2435906474-parallel-dialing-explained); Adaptive and Turbo Dialing (…/3845888418-adaptive-and-turbo-dialing); Skipping Voicemail Connects (…/6949493085-automatically-skipping-voicemail-connects); Setting Up Your Dialer (…/6080857206-setting-up-your-nooks-dialer); Network and System Requirements (…/4611049930-nooks-system-requirements-and-audio-recommendations); How Nooks Protects Calls from Spam (…/7296554284-how-nooks-protects-your-calls-from-spam); Nooks UX Explained (…/7656832803-nooks-ux-explained); AI Training Bots (…/2964870244-how-to-set-up-ai-training-bots); Outreach (…/3270655464-outreach-integration-technical-doc); Salesloft (…/9673279572-salesloft-integration); Salesforce (…/4380726622-getting-started-with-salesforce-sfdc); HubSpot (…/5988396964-getting-started-with-hubspot); Sequencing getting started (…/7242017912-getting-started-with-nooks-sequencing). All under https://support.nooks.ai/articles/.

Other: Chrome extension v1.4.4 (https://chromewebstore.google.com/detail/nooks/kbbdibmbjngifdgbmlleelghocpeimhe); product releases https://www.nooks.ai/categories/product-releases; status https://status.nooks.in/; jobs https://jobs.ashbyhq.com/nooks; HN hiring https://news.ycombinator.com/item?id=40227127; GTMnow podcast https://gtmnow.com/gtm-180-ai-native-sales-tools-nooks-dan-lee/; Forbes Oct 2024; Kleiner Perkins perspective; Unite.AI interview.

## 5. Open-source building blocks (stars / last push as of 2026-10-22)

Telephony: signalwire/freeswitch (mod_avmd beep detection), asterisk/asterisk (app_amd), kamailio/kamailio, drachtio/drachtio-server, jambonz/jambonz-feature-server + jambonz-api-server (self-hosted Twilio-style CPaaS with AMD), livekit/sip, twilio/twilio-voice.js.

Dialers: goautodial/v4.0 (VICIdial-based), inktel/Vicidial mirror, TwilioDevEd/browser-dialer-react, moazzam-07/DialerJazz, GetUp/Kooragang (predictive pacing), kofiowusuai-lab/open-dialer, kaiquelupo/twilio-power-dialer-with-async-amd, KushinP/callsheet.

AMD / voicemail: vonage-garage-rip/AnsweringMachineDetection, RobWelbourn/Twilio-AMD, sptmru/beep-detection-dataset, vicigeek/amdMODELs, wachawo/test-eagi-amd-audio, jambonz/anwering-machine-detection-example.

Audio ML: openai/whisper, ggml-org/whisper.cpp, SYSTRAN/faster-whisper, state-spaces/mamba, pyannote/pyannote-audio, snakers4/silero-vad, wiseman/py-webrtcvad.

Voice agents / roleplay: pipecat-ai/pipecat, livekit/agents, livekit/agents-js, openai/openai-realtime-agents, dograh-hq/dograh, fixie-ai/ultravox, vocodedev/vocode-core, pipecat-ai/pipecat-flows, openai/openai-realtime-twilio-demo, twilio-labs/call-gpt, twilio-samples/speech-assistant-openai-realtime-api-python, Tanush1912/sales-forge-backend.

Salesfloor: jitsi/jitsi-meet, livekit/livekit, coturn/coturn, versatica/mediasoup, workadventure/workadventure, kevinshen56714/SkyOffice, livekit-examples/meet, pyanderson/gather-client-ws.

Workflows: temporalio/temporal, temporalio/sdk-typescript.

## 6. Comparable products

Orum (up to 5 lines, live-human detection, number rotation), Koncert (agent-assisted + AI parallel), ConnectAndSell, PhoneBurner (public REST API with dialsession), Kixie, Aircall, Dialpad, PowerDialer AI (YC), Gather (WebSocket API), Kumospace. Building blocks: Twilio AMD, Media Streams, Conference Participants, Voice JS SDK; jambonz; LiveKit Agents; Pipecat.

## 7. Community threads

r/salesdevelopment and r/sales threads on Orum vs Nooks, connect delay ("hello? hello?" latency), spam labels and data quality, volume backlash. HN: Nooks hiring post, Orum hiring post, Dograh Show HN, OpenAI + Twilio sales agents Show HN. No HN thread explains Nooks' internals.

## 8. Suggested open-source build stack

- Parallel dialing: SIP trunk + FreeSWITCH/Asterisk (or jambonz) behind Kamailio; Node orchestrator via drachtio or ESL; Redis for live call state; WebSockets to the UI. (Cooks v-next starts on Twilio instead, see README.)
- Human vs voicemail vs IVR: stream 8 kHz audio per leg; silero-vad + Whisper features + beep dataset; small streaming classifier (Mamba layers); per-workflow threshold/window/delay detectors; Twilio/jambonz AMD as baseline.
- Fast bridge: rep on an open WebRTC leg; model in the same VPC as media; bridge without re-INVITE.
- Voicemail drop: mod_avmd or own beep model, then play the recording.
- Adaptive pacing: pickup model on time of day, number type, past attempts; VICIdial-style adaptive mode; abandon-rate cap.
- First-words transcript: faster-whisper / whisper.cpp streaming.
- Salesfloor + listen-in: LiveKit or mediasoup + coturn; WorkAdventure/SkyOffice UI; listen-in as muted participant; whisper coaching as one-way track.
- Roleplay bots: Pipecat or LiveKit Agents with LLM + TTS; persona prompts from own transcripts.
- Coaching: Whisper + pyannote, then LLM scorecards; Postgres + pgvector.
- SEP/CRM sync: per-vendor OAuth apps; mirror the Nooks API shape (tasks, calls, dispositions, signed call.logged webhook).
- Sequencing: Temporal TS SDK with bounded activities (Nooks caps 100 accounts per activity).
- Number reputation: Free Caller Registry; number pool with rotation and daily spam checks; A-level STIR/SHAKEN.
- Chrome extension: MV3 side panel; content scripts for CRM pages.

## 9. Compliance notes (not legal advice)

- TSR call abandonment: abandoned if no rep connects within 2 s after the greeting ends; safe harbor ≤ 3 % abandoned per campaign per 30 days, 15 s or 4 rings before hang-up, recorded ID message.
- B2B exemption: most B2B calls exempt from the TSR (16 CFR 310.6(b)(7)) with exceptions.
- TCPA artificial voice: FCC-24-17 (Feb 2024) holds AI-generated voices are artificial voice and need prior express consent.
- Ringless voicemail: FCC-22-85 (2022) treats ringless voicemail to wireless numbers as a TCPA call with a prerecorded voice.
- Autodialer definition: Facebook v. Duguid (2021) narrowed the TCPA autodialer definition; state mini-TCPAs can be broader.
- Caller ID: STIR/SHAKEN (47 CFR Part 64 Subpart HH); get A-level attestation; register with analytics engines (Free Caller Registry; First Orion, Hiya, TNS).
- Also: DNC scrubbing for consumer numbers, calling-hour limits, state call-recording consent rules.

Sources: federalregister.gov TSR amendments 2008; ftc.gov TSR compliance guide; ecfr.gov 16 CFR 310.6; fcc.gov FCC-24-17; FCC-22-85 PDF; supremecourt.gov 19-511; ecfr.gov 47 CFR 64 Subpart HH; freecallerregistry.com; numeracle.com STIR/SHAKEN explainer.

## 10. Gaps

No Nooks patents found; no public Nooks GitHub repos; call-leg topology not published (inferred); some links dropped as unreachable (Kixie API section 403, Nooks trust portal 403, docs.orum.io is a different company).
