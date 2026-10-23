/**
 * One Media Streams socket = one prospect leg. The handler is transport-agnostic (fed JSON
 * strings, told how to close) so tests drive it without a WebSocket. Nothing is processed until
 * the `start` message carries a valid token for the workspace, session and line it names.
 */
import type { Db } from '@cooks/db';
import type { Clock, Ctx } from '../context.js';
import type { JobsPort } from '../jobs.js';
import { systemPrincipal } from '../principal.js';
import { getParallelSettings } from './connection.js';
import type { DialerDeps } from './dialer.js';
import { parallelSpeechVerdict } from './parallel.js';
import { SpeechGate } from './speech/gate.js';
import { JevJudge } from './speech/jev.js';
import { speechProviderFrom, type SpeechProvider } from './speech/providers/index.js';
import { verifyStreamToken } from './speech/token.js';

export interface GateSocketDeps {
  db: Db;
  jobs: JobsPort;
  clock: Clock;
  publicUrl: string;
  dialer: DialerDeps;
  /** Close the underlying socket (after a verdict, on bad auth, on give-up). */
  close: () => void;
  /** Reuse one provider instance per process (native models load once). */
  provider?: SpeechProvider | null;
  fetchImpl?: typeof fetch;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface StartMsg {
  event: 'start';
  streamSid?: string;
  start?: { callSid?: string; customParameters?: Record<string, string>; mediaFormat?: { encoding?: string; sampleRate?: number } };
}
interface MediaMsg {
  event: 'media';
  media?: { track?: string; payload?: string };
}

/** Sockets that have not authenticated within this long are dropped. */
export const GATE_AUTH_GRACE_MS = 5000;

export function createGateSocket(deps: GateSocketDeps) {
  let gate: SpeechGate | null = null;
  let authed = false;
  let closed = false;
  let socketClosed = false;
  let resolveDone: (why: string) => void = () => undefined;
  /** Resolves with the reason once the socket is finished and any verdict has been applied. */
  const done = new Promise<string>((r) => (resolveDone = r));
  const log = deps.log ?? (() => undefined);
  const authTimer = setTimeout(() => {
    if (!authed) finish('auth_timeout');
  }, GATE_AUTH_GRACE_MS);
  // Stop the carrier's fork as soon as we no longer need audio; the verdict's DB work may still be running.
  const closeSocket = () => {
    if (socketClosed) return;
    socketClosed = true;
    deps.close();
  };
  let verdictPending = false;
  const finish = (why: string) => {
    // The carrier closing the socket after we asked it to is not news; the verdict's finish will log.
    if (verdictPending && why !== 'verdict') return;
    if (closed) return;
    closed = true;
    clearTimeout(authTimer);
    gate?.stop();
    closeSocket();
    log(`gate socket closed: ${why}`);
    resolveDone(why);
  };

  const start = async (m: StartMsg) => {
    const p = m.start?.customParameters ?? {};
    const claims = verifyStreamToken(deps.dialer.kek ?? 'cooks-dev', p.token, { ws: p.ws ?? '', session: p.session ?? '', line: p.line ?? '' }, Math.floor(deps.clock.now().getTime() / 1000));
    if (!claims) return finish('bad_token');
    const provider = deps.provider ?? speechProviderFrom(deps.dialer.speech);
    if (!provider) return finish('no_provider');
    const ctx: Ctx = { db: deps.db, principal: systemPrincipal(claims.ws), jobs: deps.jobs, clock: deps.clock, traceId: `gate:${claims.line}`, publicUrl: deps.publicUrl };
    const settings = await getParallelSettings(ctx).catch(() => null);
    if (!settings || settings.speechGate.enabled === false) return finish('gate_disabled');
    const jevKey = deps.dialer.speech?.jev?.apiKey;
    const jev = settings.speechGate.judge === 'jev' && jevKey ? new JevJudge({ apiKey: jevKey, model: deps.dialer.speech?.jev?.model, baseUrl: deps.dialer.speech?.jev?.baseUrl, fetchImpl: deps.fetchImpl }) : null;
    authed = true;
    const hints: Record<string, string> = {};
    for (const [k, v] of Object.entries(p)) if (k !== 'token') hints[k] = v;
    gate = new SpeechGate({
      provider,
      jev,
      judge: { maxMs: settings.speechGate.maxMs },
      hints,
      sampleRate: m.start?.mediaFormat?.sampleRate ?? 8000,
      onVerdict: async (v) => {
        verdictPending = true;
        closeSocket();
        try {
          const r = await parallelSpeechVerdict(ctx, claims.session, claims.line, v, deps.dialer);
          log(`gate verdict ${v.verdict} (${v.reason}, ${v.latencyMs} ms)`, { line: claims.line, result: r });
        } catch (e) {
          log(`gate verdict failed: ${e instanceof Error ? e.message : String(e)}`, { line: claims.line });
        }
        finish('verdict');
      },
      onGiveUp: (why) => finish(`give_up:${why}`),
    });
  };

  return {
    /** Feed one raw WebSocket text frame. */
    async message(raw: string | Buffer | ArrayBuffer) {
      if (closed) return;
      let m: { event?: string };
      try {
        m = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) as { event?: string };
      } catch {
        return;
      }
      switch (m.event) {
        case 'connected':
          return;
        case 'start':
          if (authed) return;
          return start(m as StartMsg);
        case 'media': {
          if (!authed || !gate) return;
          const md = (m as MediaMsg).media;
          if (md?.payload && (md.track ?? 'inbound') === 'inbound') gate.media(md.payload);
          return;
        }
        case 'stop':
          return finish('stop');
        default:
          return;
      }
    },
    /** The peer went away. */
    close() {
      finish('peer_closed');
    },
    get authenticated() {
      return authed;
    },
    done,
  };
}
