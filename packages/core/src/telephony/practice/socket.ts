/**
 * One practice socket = one rep's microphone. Transport-agnostic like the gate socket: the handler
 * is fed frames and told how to send and close, so tests drive it without a WebSocket.
 *
 *   browser → Cooks  text   {"type":"start","ws":"…","callId":"…","token":"…","sampleRate":16000}
 *   browser → Cooks  binary PCM16 mono microphone audio at that sample rate
 *   browser → Cooks  text   {"type":"stop"}
 *   Cooks → browser  text   {"type":"ready","sampleRate":24000} then {"type":"transcript",…} | {"type":"interrupt"} | {"type":"ended",…} | {"type":"error",…}
 *   Cooks → browser  binary PCM16 mono partner audio at 24 kHz
 */
import type { Db } from '@cooks/db';
import type { Clock, Ctx } from '../../context.js';
import type { JobsPort } from '../../jobs.js';
import { systemPrincipal } from '../../principal.js';
import { float32ToPcm16Bytes, resampleToFloat32 } from '../speech/audio.js';
import { verifyStreamToken } from '../speech/token.js';
import { PRACTICE_LINE, appendPracticeTranscript, endPractice, loadPracticeCall, type PracticeTranscriptEntry } from './service.js';
import type { PartnerSession, VoicePartner } from './types.js';

export interface PracticeSocketDeps {
  db: Db;
  jobs: JobsPort;
  clock: Clock;
  publicUrl: string;
  kek?: string;
  partner: VoicePartner | null;
  maxSeconds: number;
  send: (data: string | Uint8Array) => void;
  close: () => void;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface StartMsg {
  type: 'start';
  ws?: string;
  callId?: string;
  token?: string;
  sampleRate?: number;
}

export const PRACTICE_AUTH_GRACE_MS = 5000;
export const PRACTICE_OUT_RATE = 24_000;

export function createPracticeSocket(deps: PracticeSocketDeps) {
  let session: PartnerSession | null = null;
  let authed = false;
  let closed = false;
  let inRate = 16_000;
  let callId = '';
  let ctx: Ctx | null = null;
  let startedAt = 0;
  const turnStartedAt: Record<'rep' | 'partner', number | null> = { rep: null, partner: null };
  let repStoppedAt: number | null = null;
  /** Partner speech length this turn, from the audio actually sent; providers deliver audio faster than real time. */
  let partnerAudioMs = 0;
  let partnerCutAt: number | null = null;
  const entries: PracticeTranscriptEntry[] = [];
  let resolveDone: (why: string) => void = () => undefined;
  const done = new Promise<string>((r) => (resolveDone = r));
  const log = deps.log ?? (() => undefined);
  const sendJson = (o: Record<string, unknown>) => {
    try {
      deps.send(JSON.stringify(o));
    } catch {
      /* peer gone */
    }
  };
  const authTimer = setTimeout(() => {
    if (!authed) finish('auth_timeout');
  }, PRACTICE_AUTH_GRACE_MS);
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  const finish = async (why: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    if (capTimer) clearTimeout(capTimer);
    session?.close();
    session = null;
    if (authed && ctx) {
      try {
        await endPractice(ctx, callId, { endReason: why });
      } catch (e) {
        log(`practice end failed: ${e instanceof Error ? e.message : String(e)}`, { callId });
      }
      sendJson({ type: 'ended', callId, reason: why });
    } else if (why !== 'peer_closed') sendJson({ type: 'error', message: why });
    try {
      deps.close();
    } catch {
      /* already closed */
    }
    log(`practice socket closed: ${why}`, { callId });
    resolveDone(why);
  };

  const start = async (m: StartMsg) => {
    const now = deps.clock.now();
    const claims = verifyStreamToken(deps.kek ?? 'cooks-dev', m.token, { ws: m.ws ?? '', session: m.callId ?? '', line: PRACTICE_LINE }, Math.floor(now.getTime() / 1000));
    if (!claims) return finish('bad_token');
    if (!deps.partner) return finish('no_partner');
    ctx = { db: deps.db, principal: systemPrincipal(claims.ws), jobs: deps.jobs, clock: deps.clock, traceId: `practice:${claims.session}`, publicUrl: deps.publicUrl };
    const call = await loadPracticeCall(ctx, claims.session).catch(() => null);
    if (!call || call.status !== 'in_progress') return finish('not_in_progress');
    const cfg = call.aiConfig?.practice;
    if (!cfg?.instructions) return finish('no_scenario');
    callId = call.id;
    authed = true;
    inRate = m.sampleRate && m.sampleRate >= 8000 && m.sampleRate <= 48_000 ? m.sampleRate : 16_000;
    startedAt = now.getTime();
    capTimer = setTimeout(() => void finish('time_limit'), deps.maxSeconds * 1000);
    const at = () => new Date(deps.clock.now().getTime()).toISOString();
    const partial: Record<'rep' | 'partner', string> = { rep: '', partner: '' };
    session = deps.partner.open({ instructions: cfg.instructions, opening: cfg.opening, voice: cfg.voice, sampleRate: inRate });
    session.on((e) => {
      if (closed) return;
      switch (e.type) {
        case 'ready':
          sendJson({ type: 'ready', callId, sampleRate: PRACTICE_OUT_RATE, maxSeconds: deps.maxSeconds });
          return;
        case 'audio': {
          const pcm = e.sampleRate === PRACTICE_OUT_RATE ? e.pcm : new Int16Array(float32ToPcm16Bytes(resampleToFloat32(e.pcm, e.sampleRate, PRACTICE_OUT_RATE)).buffer);
          if (turnStartedAt.partner === null) {
            turnStartedAt.partner = deps.clock.now().getTime();
            partnerAudioMs = 0;
            partnerCutAt = null;
          }
          partnerAudioMs += (e.pcm.length / e.sampleRate) * 1000;
          try {
            deps.send(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          } catch {
            /* peer gone */
          }
          return;
        }
        case 'transcript': {
          if (!e.final) {
            partial[e.role] = e.text;
            if (turnStartedAt[e.role] === null) turnStartedAt[e.role] = deps.clock.now().getTime();
            sendJson({ type: 'transcript', role: e.role, text: e.text, final: false });
            return;
          }
          const began = turnStartedAt[e.role] ?? deps.clock.now().getTime();
          const spoken = began + partnerAudioMs;
          const ended =
            e.role === 'rep'
              ? repStoppedAt !== null && repStoppedAt >= began
                ? new Date(repStoppedAt).toISOString()
                : at()
              : new Date(partnerCutAt !== null ? Math.min(spoken, partnerCutAt) : Math.max(spoken, began)).toISOString();
          const entry: PracticeTranscriptEntry = { index: entries.length, role: e.role === 'rep' ? 'rep' : 'prospect', text: e.text, startedAt: new Date(began).toISOString(), endedAt: ended };
          entries.push(entry);
          turnStartedAt[e.role] = null;
          if (e.role === 'rep') repStoppedAt = null;
          else {
            partnerAudioMs = 0;
            partnerCutAt = null;
          }
          partial[e.role] = '';
          sendJson({ type: 'transcript', role: e.role, text: e.text, final: true, at: entry.startedAt });
          void appendPracticeTranscript(deps.db, callId, entries).catch(() => undefined);
          return;
        }
        case 'turn':
          if (e.state === 'start') {
            turnStartedAt.rep = deps.clock.now().getTime();
            repStoppedAt = null;
          } else repStoppedAt = deps.clock.now().getTime();
          return;
        case 'interrupt':
          if (turnStartedAt.partner !== null) partnerCutAt = deps.clock.now().getTime();
          sendJson({ type: 'interrupt' });
          return;
        case 'error':
          log(`partner error: ${e.message}`, { callId });
          sendJson({ type: 'error', message: e.message });
          void finish('partner_error');
          return;
        default:
          return;
      }
    });
  };

  return {
    /** Feed one WebSocket frame: text frames are JSON control messages, binary frames are PCM16 audio. */
    async message(raw: string | Buffer | ArrayBuffer | Uint8Array) {
      if (closed) return;
      if (typeof raw !== 'string') {
        if (!authed || !session) return;
        const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
        const even = u8.byteLength - (u8.byteLength % 2);
        const copy = new Int16Array(even / 2);
        new Uint8Array(copy.buffer).set(u8.subarray(0, even));
        session.push(copy, inRate);
        return;
      }
      let m: { type?: string };
      try {
        m = JSON.parse(raw) as { type?: string };
      } catch {
        return;
      }
      if (m.type === 'start') {
        if (authed) return;
        return start(m as StartMsg);
      }
      if (m.type === 'stop') return finish('stop');
    },
    /** The peer went away. */
    close() {
      void finish('peer_closed');
    },
    get authenticated() {
      return authed;
    },
    get elapsedMs() {
      return authed ? deps.clock.now().getTime() - startedAt : 0;
    },
    done,
  };
}
