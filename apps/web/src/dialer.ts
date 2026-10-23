/** Browser side of the dialer: bridge calls via the API, softphone calls via the Twilio Voice SDK. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

export interface DialRequest {
  prospectId?: string;
  to?: string;
  taskId?: string;
  mode: 'bridge' | 'softphone';
  repPhone?: string;
  fromNumber?: string;
}

export interface ActiveCall {
  callId: string;
  mode: 'bridge' | 'softphone';
  to: string;
  status: string;
  startedAt: number;
}

type SdkDevice = import('@twilio/voice-sdk').Device;
type SdkCall = import('@twilio/voice-sdk').Call;

const REP_PHONE_KEY = 'cooks.repPhone';
export const loadRepPhone = () => {
  try {
    return localStorage.getItem(REP_PHONE_KEY) ?? '';
  } catch {
    return '';
  }
};
export const saveRepPhone = (v: string) => {
  try {
    localStorage.setItem(REP_PHONE_KEY, v);
  } catch {}
};

/** Live audio levels (0–1) and link quality from the Voice SDK, read by canvas meters without re-rendering React. */
export interface AudioLevels {
  input: number;
  output: number;
  at: number;
}
export interface LinkQuality {
  mos: number | null;
  rtt: number | null;
  jitter: number | null;
  packetsLost: number | null;
  at: number;
}

export function useDialer() {
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [softphoneReady, setSoftphoneReady] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [muted, setMuted] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);
  const [onLine, setOnLine] = useState(false);
  const levels = useRef<AudioLevels>({ input: 0, output: 0, at: 0 });
  const quality = useRef<LinkQuality>({ mos: null, rtt: null, jitter: null, packetsLost: null, at: 0 });
  const device = useRef<SdkDevice | null>(null);
  const sdkCall = useRef<SdkCall | null>(null);
  const timer = useRef<number | null>(null);
  /** Wire the SDK events every call needs: levels for the scope, samples for signal bars, mute, warnings. */
  const instrument = useCallback((c: SdkCall) => {
    c.on('volume', (input: number, output: number) => {
      levels.current = { input, output, at: performance.now() };
    });
    c.on('sample', (s: { mos?: number | null; rtt?: number | null; jitter?: number | null; packetsLostFraction?: number | null }) => {
      quality.current = { mos: s.mos ?? null, rtt: s.rtt ?? null, jitter: s.jitter ?? null, packetsLost: s.packetsLostFraction ?? null, at: performance.now() };
    });
    c.on('mute', (m: boolean) => setMuted(m));
    c.on('warning', (name: string) => setWarning(name));
    c.on('warning-cleared', () => setWarning(null));
    c.on('accept', () => setOnLine(true));
    setOnLine(c.status() === 'open');
  }, []);

  const poll = useCallback((callId: string) => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      try {
        const r = await api(`/v1/calls/${callId}`);
        const st = r.data.status as string;
        setActive((a) => (a && a.callId === callId ? { ...a, status: st } : a));
        if (['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(st) || st.startsWith('rep_')) {
          if (timer.current) window.clearInterval(timer.current);
          timer.current = null;
        }
      } catch {}
    }, 2000);
  }, []);
  useEffect(() => () => {
    if (timer.current) window.clearInterval(timer.current);
    device.current?.destroy();
  }, []);

  const ensureDevice = useCallback(async () => {
    if (device.current) return device.current;
    setSoftphoneReady('loading');
    try {
      const { Device } = await import('@twilio/voice-sdk');
      const tok = await api('/v1/telephony/token', { method: 'POST', json: { data: { ttlSeconds: 3600 } } });
      const d = new Device(tok.data.token, { codecPreferences: ['opus', 'pcmu'] as never, logLevel: 'error' as never });
      d.on('tokenWillExpire', async () => {
        const t = await api('/v1/telephony/token', { method: 'POST' });
        d.updateToken(t.data.token);
      });
      await d.register();
      device.current = d;
      setSoftphoneReady('ready');
      return d;
    } catch (e) {
      setSoftphoneReady('error');
      throw e;
    }
  }, []);

  const dial = useCallback(
    async (req: DialRequest) => {
      const r = await api('/v1/calls/actions/dial', { method: 'POST', json: { data: req } });
      const call = r.data.call;
      setActive({ callId: call.id, mode: r.data.mode, to: call.to, status: call.status, startedAt: Date.now() });
      if (r.data.mode === 'softphone') {
        const d = await ensureDevice();
        const c = await d.connect({ params: r.data.connectParams });
        sdkCall.current = c;
        instrument(c);
        c.on('disconnect', () => {
          sdkCall.current = null;
        });
        c.on('error', () => {
          sdkCall.current = null;
        });
      }
      poll(call.id);
      return r.data;
    },
    [ensureDevice, instrument, poll],
  );

  /** Parallel dialer: join the session conference from the browser. Resolves once the SDK call is accepted. */
  const joinConference = useCallback(
    async (params: Record<string, string>, onDisconnect?: () => void) => {
      const d = await ensureDevice();
      const c = await d.connect({ params });
      sdkCall.current = c;
      instrument(c);
      const gone = () => {
        sdkCall.current = null;
        setOnLine(false);
        setMuted(false);
        levels.current = { input: 0, output: 0, at: 0 };
        onDisconnect?.();
      };
      c.on('disconnect', gone);
      c.on('error', gone);
      return c;
    },
    [ensureDevice, instrument],
  );

  const hangup = useCallback(() => {
    sdkCall.current?.disconnect();
    sdkCall.current = null;
  }, []);

  const clear = useCallback(() => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    setActive(null);
  }, []);

  return {
    active,
    dial,
    joinConference,
    hangup,
    clear,
    softphoneReady,
    /** True while the browser leg is up. */
    onLine,
    muted,
    warning,
    levels,
    quality,
    connected: () => !!sdkCall.current,
    mute: (m: boolean) => sdkCall.current?.mute(m),
    sendDigits: (d: string) => sdkCall.current?.sendDigits(d),
  };
}

export const OUTCOMES = [
  ['connected', 'Connected'],
  ['meeting_booked', 'Meeting booked'],
  ['left_voicemail', 'Left voicemail'],
  ['no_answer', 'No answer'],
  ['busy', 'Busy'],
  ['wrong_number', 'Wrong number'],
  ['not_connected', 'Not connected'],
  ['do_not_call', 'Do not call'],
  ['other', 'Other'],
] as const;

export const fmtDuration = (s: number | null | undefined) => {
  const n = Math.max(0, Math.round(s ?? 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

export const LINE_LABEL: Record<string, string> = {
  queued: 'Queued',
  skipped: 'Skipped',
  dialing: 'Dialing',
  ringing: 'Ringing',
  answered: 'Answered, screening',
  connected: 'Connected to you',
  dropped: 'Dropped (callback made)',
  voicemail: 'Voicemail',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
  canceled: 'Canceled',
  completed: 'Done',
};
export const SESSION_LABEL: Record<string, string> = {
  waiting_rep: 'Waiting for you to join',
  ready: 'Ready to dial',
  dialing: 'Dialing',
  connected: 'Live',
  wrapping: 'Log the call, then dial again',
  ended: 'Ended',
};

export const STATUS_LABEL: Record<string, string> = {
  initiated: 'Starting',
  queued: 'Queued at Speko',
  ringing_rep: 'Ringing your phone',
  ringing: 'Ringing prospect',
  in_progress: 'In progress',
  completed: 'Completed',
  busy: 'Busy',
  no_answer: 'No answer',
  failed: 'Failed',
  canceled: 'Canceled',
  rep_no_answer: 'You did not answer',
  rep_busy: 'Your line was busy',
  rep_failed: 'Could not reach you',
  rep_canceled: 'Canceled',
};
