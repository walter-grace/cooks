# Orum public research (2026-10-23)

Compiled from Orum's help center, blog, product updates and legal pages. Nothing here is Orum code
or proprietary material. Every fact carries its source. Where a page was only seen through a search
snippet or an aggregator, the line says so; treat those as leads, not facts.

Trap: `docs.orum.io` belongs to a different company also called Orum (payments). Ignore anything
from there. The dialer is `orum.com` and `support.orum.com`.

## 1. Developer surface

Orum publishes no API reference, OpenAPI document, SDK or developer portal that we could find
(absence only; the help-center index was not crawled in full). Its one developer feature is
outbound webhooks, sold as an add-on to the subscription. Data flows out of Orum. Nothing public
lets you push leads in.

Webhooks ([ART-463](https://support.orum.com/en-US/orum/article/ART-463-webhooks),
[launch post](https://www.orum.com/blog/introducing-orum-webhooks-real-time-sales-data-for-any-crm-or-workflow)):

- Event: `call-disposition-added`. The article calls it an example event; the launch post names no
  other.
- Payload: datetime, call duration, disposition, list name, notes, objections, recording URL, user
  (rep) email, recording type, inbound/outbound, call transcript, prospect name, prospect phone
  number, plus the fields imported with the prospect's CSV (not enumerated).
- Signature: header `x-webhook-signature: t={timestamp},s={signature}`, HMAC-SHA256, base64. The
  article's prose says a five-minute tolerance and its sample code checks 60 000 ms; pick one when
  verifying.
- Delivery: requests time out in about 15 seconds; up to 8 retries over a 30-minute window with
  exponential back-off and jitter.

This is the same shape as the `call.logged` signature Cooks verifies and emits (`packages/webhooks`).
A receiver that turns `call-disposition-added` into Cooks call and disposition records would be
small. It is not built.

## 2. Telephony and stack

- Orum launched in 2018 on third-party tech, saw latency and weak voicemail detection, and built its
  own dialer ([Behind the dial](https://www.orum.com/blog/behind-the-dial-orums-new-ai-dialer)).
  The post says "third-party tech", not "telephony", and gives no date for the switch.
- Stack per engineering job posts seen on aggregators (Built In NYC, Weekday; the official careers
  page was not fetched): Node.js with TypeScript, Ruby, Postgres, Google Cloud Platform, FreeSWITCH.
- Orum positions itself against dialers built on Twilio's API: "It's not a wrapper over another
  platform—it is the platform" ([Orum vs Twilio](https://www.orum.com/reports-and-guides/orum-vs-twilio)).
  Its [Nooks alternative](https://www.orum.com/reports-and-guides/nooks-alternative) page says Nooks is
  built on Twilio (snippet).
- Subprocessors ([DPA](https://orum.com/data_processing_addendum), Annex III, seen through a search
  summary only): Deepgram (transcription), Vonage (telephony and video), Anthropic, Google, OpenAI,
  Twilio (SendGrid, email). Cloudflare is not listed. "Vonage, not Twilio" is therefore half right:
  Vonage carries voice, Twilio appears only for email.
- Audio path ([Networking recommendations](https://support.orum.com/en-US/orum/article/S5hQ0SdQ-networking-recommendations-and-whitelisting)):
  the browser sends audio over WebRTC to Orum's telephony server; customers allow outbound UDP and
  TCP to Cloudflare's public servers, and traffic "may be routed through the TURN server" when
  direct routing fails. TURN is the fallback, not the default. Nothing public says the rep's line
  stays open for the whole session. Vonage also drives parts of the SalesFloor product.

## 3. How the parallel dialer behaves

- "Law of firsts": the first detected human is connected and the other calls are cancelled. The rep
  does not hear ringing or the prospect's opening greeting; a beep and a screen change announce the
  connect ([ART-355](https://support.orum.com/en-US/orum/article/ART-355-parallel-dialer)). Admins
  set the line maximum; the article's example team dials 4 to 5 numbers at once. "Up to 5 lines" as
  a hard cap is not stated there.
- Marketing claims a median connect time of 0.7 seconds ([platform/dialer](https://www.orum.com/platform/dialer),
  snippet only).
- The help article says the AI "scans for a real human". Screener and phone-tree detection as
  separate classes was not found in the help center.
- Cancelled calls drop to the bottom of the list, stay visible in call history, do not count toward
  dials in analytics, and do not complete call tasks
  ([ART-245](https://support.orum.com/en-US/orum/article/ART-245-canceled-calls-)).

## 4. Number reputation

- Hiya partnership: Orum registers customers' businesses and numbers with AT&T, Verizon and T-Mobile
  ([product update](https://www.orum.com/product-updates/orum-partners-with-hiya-to-protect-your-number-reputation)).
- Boost Connect picks a Call From Number "that has a high propensity to lead to a connect"
  ([ART-452](https://support.orum.com/en-US/orum/article/ART-452-call-from-number-fallback-number))
  from a pool of 10,000+ Orum-owned numbers, rotating when a prospect is called more than once a day
  ([ART-464](https://support.orum.com/en-US/orum/article/ART-464-rep-best-practices), snippet only).
- "Rotate every 20 dials": not found on any Orum page. Do not repeat it.

## 5. What Orum does not say

Nothing Orum-authored was found on abandoned calls, the FTC Telemarketing Sales Rule, the 3 %
abandonment cap, or what a dropped second answerer hears. Searches covered orum.com and the help
center for abandoned call, FTC, TCPA, drop rate and parallel dialer compliance. Cooks documents and
enforces this in `docs/dialer.md` (consumer mode, abandoned-call message, 30-day abandonment rate),
which is a real point of difference, stated carefully: "we publish how we handle it", not "they
don't handle it".

## 6. What this changes for Cooks

| Fact | Cooks decision |
| --- | --- |
| Webhook-only developer surface, one event | Nothing to be wire-compatible with. An inbound receiver for `call-disposition-added` is a small, optional addition; see `docs/api-compat.md`. |
| Rep hears a beep, never ringing | Cooks already connects with no beep or announcement (`docs/dialer.md`). Keep the beep as an optional per-rep cue, off by default. |
| Cancelled calls do not count as dials and return to the bottom of the list | Match: cancelled legs are excluded from dial counts in analytics and requeued at the tail. |
| Best-number selection from a large pool, carrier registration via Hiya | Number pool with per-number connect rate and daily counters; document Free Caller Registry and the carrier registration paths. Do not claim a rotation cadence we did not measure. |
| Own switch (FreeSWITCH) on Vonage, WebRTC through Cloudflare | Confirms the Twilio-free path in the Nooks notes: jambonz or FreeSWITCH behind a SIP trunk, coturn for relay. Later. |
| No public word on abandoned calls | Keep publishing the compliance page; it is a differentiator in writing, not in a claim about Orum. |

Not checked: Orum's official careers page, trust.orum.com, platform/security, the Wayback Machine,
G2 and other review sites. Several items above were seen only through search snippets, as marked.
