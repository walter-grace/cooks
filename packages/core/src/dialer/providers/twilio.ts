/** Twilio behind the DialerProvider interface: human calls in bridge mode (rep first, then prospect). */
import { TwilioClient, TwilioError, conferenceTwiml, hangupTwiml, holdWithStreamTwiml, pauseTwiml, type AmdOptions } from '../../telephony/twilio.js';
import { DialerError, type DialLegInput, type DialerProvider, type ParallelCarrier, type PlaceCallInput, type PlaceCallResult, type ProviderCallState, type RecordingRef, type RepLegInput } from './types.js';

const TERMINAL: Record<string, ProviderCallState['outcome']> = { completed: 'answered', busy: 'failed', 'no-answer': 'no_answer', failed: 'failed', canceled: 'failed' };

export class TwilioProvider implements DialerProvider, ParallelCarrier {
  readonly kind = 'twilio' as const;
  constructor(public client: TwilioClient) {}

  /** Places the rep leg; Twilio fetches TwiML from `callbacks.voiceUrl` when the rep answers and dials the prospect from there. */
  async placeCall(i: PlaceCallInput): Promise<PlaceCallResult> {
    if (!i.repPhone || !i.callbacks) throw new DialerError('twilio', 'BRIDGE_PARAMS', 'Twilio bridge calls need repPhone and callback URLs', 422);
    if (!i.from) throw new DialerError('twilio', 'NO_CALLER_ID', 'No caller id: add a Twilio number under Settings → Dialer', 422);
    try {
      const leg = await this.client.createCall({ to: i.repPhone, from: i.from, url: i.callbacks.voiceUrl, statusCallback: i.callbacks.statusUrl, machineDetection: false });
      return { providerCallId: leg.sid, status: 'queued', raw: leg };
    } catch (e) {
      const err = e as { status?: number; code?: number | null; message: string };
      throw new DialerError('twilio', String(err.code ?? 'TWILIO'), `Twilio could not place the call: ${err.message}`, err.status ?? 502, (err.status ?? 500) >= 500);
    }
  }
  async getCall(sid: string): Promise<ProviderCallState> {
    const c = await this.client.call(sid);
    const st = c.status;
    const outcome = TERMINAL[st];
    return {
      status: outcome !== undefined ? 'ended' : st === 'in-progress' ? 'in_progress' : st === 'ringing' ? 'ringing' : 'queued',
      outcome: outcome ?? null,
      durationSeconds: c.duration,
      endReason: outcome !== undefined ? st : null,
      raw: c,
    };
  }
  /** Twilio recordings are keyed by RecordingSid and streamed by `recordingResponse`; nothing to resolve per call here. */
  async getRecording(): Promise<RecordingRef | null> {
    return null;
  }
  async hangup(sid: string): Promise<void> {
    await this.client.hangup(sid);
  }

  /* ---------- ParallelCarrier ---------- */

  async dialRep(i: RepLegInput) {
    const leg = await this.client.createCall({ to: i.to, from: i.from, url: i.callbacks.voiceUrl, statusCallback: i.callbacks.statusUrl, machineDetection: false, timeoutSeconds: 30 }).catch(rethrow);
    return { providerCallId: leg.sid };
  }
  async dialProspect(i: DialLegInput) {
    const leg = await this.client.createAmdCall({ to: i.to, from: i.from, url: i.callbacks.voiceUrl, statusCallback: i.callbacks.statusUrl, amdCallback: i.callbacks.amdUrl, timeoutSeconds: i.ringTimeoutSeconds, amd: i.amd as AmdOptions }).catch(rethrow);
    return { providerCallId: leg.sid };
  }
  async joinConference(sid: string, conference: string, opts: { statusCallback?: string; label?: string }) {
    await this.client.redirect(sid, { twiml: conferenceTwiml({ name: conference, role: 'prospect', statusCallback: opts.statusCallback, label: opts.label }) }).catch(rethrow);
  }
  /** `canceled` only works while ringing and `completed` only once answered, so try the likely one first and treat "already ended" as success. */
  async hangupLeg(sid: string, phase: 'ringing' | 'answered' | 'unknown') {
    const order = phase === 'answered' ? ['completed', 'canceled'] : ['canceled', 'completed'];
    let last: unknown = null;
    for (const st of order) {
      try {
        if (st === 'canceled') await this.client.cancel(sid);
        else await this.client.hangup(sid);
        return;
      } catch (e) {
        last = e;
        if (e instanceof TwilioError && (e.status === 404 || e.code === 20404)) return; // already gone
      }
    }
    rethrow(last);
  }
  async sayAndHangup(sid: string, message: string) {
    await this.client.redirect(sid, { twiml: hangupTwiml(message) }).catch(rethrow);
  }
  async startRecording(repSid: string, statusCallback: string) {
    try {
      const r = await this.client.startRecording(repSid, { statusCallback });
      return r.sid;
    } catch (e) {
      // A recording that cannot start must never block the connect.
      if (e instanceof TwilioError) return null;
      throw e;
    }
  }
  async stopRecording(repSid: string, recordingSid: string | null) {
    await this.client.stopRecording(repSid, recordingSid ?? undefined).catch(() => undefined);
  }
  async endConference(conferenceSid: string) {
    await this.client.endConference(conferenceSid).catch((e) => {
      if (e instanceof TwilioError && (e.status === 404 || e.code === 20404)) return;
      rethrow(e);
    });
  }
  repJoinDocument(conference: string, opts: { statusCallback: string; label: string }) {
    return conferenceTwiml({ name: conference, role: 'rep', statusCallback: opts.statusCallback, label: opts.label });
  }
  prospectHoldDocument(seconds: number, stream?: { url: string; params: Record<string, string> }) {
    return stream ? holdWithStreamTwiml(seconds, stream) : pauseTwiml(seconds);
  }
}

function rethrow(e: unknown): never {
  if (e instanceof DialerError) throw e;
  const err = e as { status?: number; code?: number | null; message: string };
  throw new DialerError('twilio', String(err.code ?? 'TWILIO'), `Twilio: ${err.message}`, err.status ?? 502, (err.status ?? 500) >= 500);
}
