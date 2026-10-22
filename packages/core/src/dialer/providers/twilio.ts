/** Twilio behind the DialerProvider interface: human calls in bridge mode (rep first, then prospect). */
import { TwilioClient } from '../../telephony/twilio.js';
import { DialerError, type DialerProvider, type PlaceCallInput, type PlaceCallResult, type ProviderCallState, type RecordingRef } from './types.js';

const TERMINAL: Record<string, ProviderCallState['outcome']> = { completed: 'answered', busy: 'failed', 'no-answer': 'no_answer', failed: 'failed', canceled: 'failed' };

export class TwilioProvider implements DialerProvider {
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
}
