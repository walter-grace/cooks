import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import { AlertTriangle, Grid3x3, Mic, MicOff, PhoneCall, PhoneForwarded, PhoneOff, Square, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { api, q } from '../api.js';
import { fmtFixed } from '../lib/format.js';
import { toast, useApi } from '../hooks.js';
import { Link } from '../router.js';
import { Empty, PageHeader } from '../components/layout.js';
import { CallerId, Kbd, Keypad, Led, Scope, SignalBars, Ticker, Timer, toneFor, useHotkeys, type TickerEvent } from '../components/cockpit.js';
import { LINE_LABEL, OUTCOMES, SESSION_LABEL, loadRepPhone, saveRepPhone, useDialer } from '../dialer.js';
import { localHour, localTime, phoneInfo } from '../lib/phone.js';

type Prospect = { id: string; name: string | null; title: string | null; phone: string | null; email: string | null; linkedInUrl: string | null; account: string | null; accountId: string | null; timezone: string | null; city: string | null; state: string | null; country: string | null };
type Line = { id: string; batch: number; status: string; to: string | null; prospect: Prospect | null; callId: string | null; taskId: string | null; callbackTaskId: string | null; answeredBy: string | null; skipReason: string | null; endReason: string | null; answeredAt: string | null; amdAt: string | null; connectedAt: string | null; endedAt: string | null; durationSeconds: number | null; verdictSource: string | null; speech: { text?: string; reason?: string; confidence?: number; latencyMs?: number; provider?: string; judge?: string } | null };
type Session = { id: string; status: string; repMode: string; repPhone: string | null; fromNumber: string; maxLines: number; batch: number; complianceMode: string; autoDial: boolean; connectedLineId: string | null; connectedAt: string | null; endReason: string | null; createdAt: string; stats: Record<string, number>; lines: Line[]; connectParams?: Record<string, string> };

const LIVE = new Set(['dialing', 'ringing', 'answered', 'connected']);
const SKIP_LABEL: Record<string, string> = { no_phone: 'no phone number', do_not_call: 'do-not-call list', quiet_hours: 'quiet hours there', duplicate: 'already queued', session_ended: 'session ended' };

/**
 * Power dialer cockpit. The rep's own line sits in a rail at the top with a live scope and link
 * quality; prospect lines are instrument channels below it; the first human answer expands into a
 * caller-ID dossier with the log form beside it.
 */
export function PowerDialer() {
  const dialerCfg = useApi<{ data: any }>('/v1/workspace/dialer');
  const current = useApi<{ data: Session | null }>('/v1/dialSessions/current');
  const [session, setSession] = useState<Session | null>(null);
  const dialer = useDialer();
  const [busy, setBusy] = useState(false);
  const [keypad, setKeypad] = useState(false);
  const poll = useRef<number | null>(null);
  const cfg = dialerCfg.data?.data;
  const tw = cfg?.twilio;
  const parallel = cfg?.parallel;

  useEffect(() => {
    if (current.data) setSession(current.data.data);
  }, [current.data]);
  useEffect(() => {
    if (poll.current) window.clearInterval(poll.current);
    poll.current = null;
    if (!session || session.status === 'ended') return;
    poll.current = window.setInterval(async () => {
      try {
        const r = await api<{ data: Session }>(`/v1/dialSessions/${session.id}`);
        setSession((s) => (s && s.id === r.data.id ? { ...r.data, connectParams: s.connectParams } : r.data));
      } catch {}
    }, 1000);
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, [session?.id, session?.status === 'ended']);

  const refresh = useCallback(async () => {
    if (!session) return;
    const r = await api<{ data: Session }>(`/v1/dialSessions/${session.id}`);
    setSession((s) => ({ ...r.data, connectParams: s?.connectParams }));
  }, [session?.id]);

  const start = async (input: { repMode: 'browser' | 'phone'; repPhone?: string; fromNumber?: string; maxLines: number; autoDial: boolean; prospectIds: string[]; taskIds: string[] }) => {
    setBusy(true);
    try {
      const r = await api<{ data: Session }>('/v1/dialSessions', { method: 'POST', json: { data: input } });
      setSession(r.data);
      if (input.repMode === 'browser' && r.data.connectParams) await dialer.joinConference(r.data.connectParams);
      toast(input.repMode === 'browser' ? 'You are on the line. Dial when ready.' : 'Ringing your phone. Pick up to join.', 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const rejoin = async () => {
    if (!session) return;
    try {
      await dialer.joinConference({ kind: 'parallel', sessionId: session.id, ws: session.connectParams?.ws ?? '' });
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const act = useCallback(
    async (path: string, body?: unknown) => {
      if (!session || busy) return;
      setBusy(true);
      try {
        const r = await api<{ data: Session }>(`/v1/dialSessions/${session.id}${path}`, { method: 'POST', json: body === undefined ? undefined : { data: body } });
        if (r?.data?.lines) setSession((s) => ({ ...r.data, connectParams: s?.connectParams }));
        else await refresh();
      } catch (e: any) {
        toast(e.message, 'error');
        await refresh().catch(() => undefined);
      } finally {
        setBusy(false);
      }
    },
    [session?.id, busy, refresh],
  );
  const end = useCallback(async () => {
    await act('/actions/end');
    dialer.hangup();
  }, [act, dialer]);

  const queued = session?.lines.filter((l) => l.status === 'queued') ?? [];
  const connected = session?.connectedLineId ? session.lines.find((l) => l.id === session.connectedLineId) : null;
  const canDial = !!session && (session.status === 'ready' || session.status === 'wrapping') && queued.length > 0 && !busy;
  const canHangup = !!connected && connected.status === 'connected' && !busy;
  const live = !!session && session.status !== 'ended';

  useHotkeys(
    useMemo(
      () => ({
        d: canDial ? () => void act('/actions/dial', {}) : undefined,
        h: canHangup ? () => void act('/actions/hangup') : undefined,
        m: live && dialer.onLine ? () => dialer.mute(!dialer.muted) : undefined,
        k: live ? () => setKeypad((k) => !k) : undefined,
        escape: keypad ? () => setKeypad(false) : undefined,
      }),
      [canDial, canHangup, live, dialer.onLine, dialer.muted, keypad, act],
    ),
  );

  if (!cfg) return null;
  if (tw?.status !== 'connected') {
    return (
      <>
        <PageHeader title="Power dialer" description="Several lines ring at once; the first person who answers is on with you instantly." />
        <Empty>
          Connect Twilio under <Link to="/settings?tab=dialer" className="underline">Settings → Dialer</Link> to use the power dialer.
        </Empty>
      </>
    );
  }
  if (!parallel?.confirmed) {
    return (
      <>
        <PageHeader title="Power dialer" description="Several lines ring at once; the first person who answers is on with you instantly." />
        <div className="rounded-lg border p-4" data-testid="compliance-gate">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4 text-muted-foreground" /> An admin needs to confirm the compliance mode
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            When two people answer at once, the second one is dropped. For calls to consumers in the US that counts as an abandoned call under the FTC Telemarketing Sales Rule, so an admin chooses B2B or consumer mode and confirms it under <Link to="/settings?tab=dialer" className="underline">Settings → Dialer</Link> first.
          </p>
        </div>
      </>
    );
  }

  return (
    <div className="cockpit -m-4 min-h-screen p-4 md:-m-6 md:p-6" data-testid="cockpit">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Led tone={!live ? 'off' : session.status === 'connected' ? 'live' : session.status === 'dialing' ? 'ring' : 'idle'} pulse={live && session.status === 'dialing'} />
          <div>
            <div className="ck-label">Power dialer</div>
            <h1 className="text-lg font-semibold tracking-tight" data-testid="pd-status">
              {live ? (SESSION_LABEL[session.status] ?? session.status) : 'Standby'}
            </h1>
          </div>
        </div>
        {live && (
          <div className="flex flex-wrap items-center gap-2">
            <Stat label="Caller id" value={phoneInfo(session.fromNumber)?.national ?? session.fromNumber} />
            <Stat label="Lines" value={String(session.maxLines)} />
            <Stat label="Batch" value={String(session.batch)} />
            <Stat label="Mode" value={session.complianceMode === 'consumer' ? 'Consumer' : 'B2B'} />
            <button className="ck-btn" data-tone="drop" onClick={end} disabled={busy} data-testid="pd-end">
              <Square className="size-3.5" /> End session
            </button>
          </div>
        )}
      </div>

      {!live ? (
        <Setup softphone={!!tw.softphone} fromNumbers={tw.fromNumbers ?? []} maxLines={parallel.maxLines} maxAllowed={parallel.maxAllowedLines} busy={busy} onStart={start} last={session} />
      ) : (
        <>
          <RepRail session={session} dialer={dialer} keypadOpen={keypad} onKeypad={() => setKeypad((k) => !k)} onRejoin={rejoin} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button className="ck-btn" data-tone={canDial ? 'live' : undefined} onClick={() => act('/actions/dial', {})} disabled={!canDial} data-testid="pd-dial">
              <PhoneCall className="size-4" /> {session.status === 'dialing' ? 'Dialing' : `Dial next ${Math.min(session.maxLines, queued.length) || ''}`} <Kbd>D</Kbd>
            </button>
            <button className="ck-btn" data-tone={canHangup ? 'drop' : undefined} onClick={() => act('/actions/hangup')} disabled={!canHangup} data-testid="pd-hangup">
              <PhoneOff className="size-4" /> Hang up <Kbd>H</Kbd>
            </button>
            <label className="ml-auto flex items-center gap-2 text-sm" style={{ color: 'var(--ck-dim)' }}>
              Auto-dial
              <Switch
                checked={session.autoDial}
                onCheckedChange={async (v) => {
                  await api(`/v1/dialSessions/${session.id}`, { method: 'PATCH', json: { data: { autoDial: v } } });
                  await refresh();
                }}
                data-testid="pd-auto"
              />
            </label>
          </div>
          <AnimatePresence>
            {keypad && (
              <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }} className="ck-cell mt-3 max-w-xs p-3">
                <div className="mb-2 flex items-center justify-between">
                  <span className="ck-label">Keypad</span>
                  <button className="ck-btn h-7 px-2" onClick={() => setKeypad(false)}>
                    <X className="size-3.5" />
                  </button>
                </div>
                <Keypad onDigit={(d) => dialer.sendDigits(d)} enabled={dialer.onLine && !!connected} />
              </motion.div>
            )}
          </AnimatePresence>
          <Board session={session} connected={connected ?? null} onLogged={refresh} onQueue={(ids) => act('/actions/queue', { prospectIds: ids })} />
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="ck-cell px-3 py-1.5">
      <div className="ck-label">{label}</div>
      <div className="ck-mono text-sm">{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------- rep rail */

/** Every timestamp a line carries becomes a console line; the ticker shows the latest few. */
/** "person (heard)" / "machine (AMD)": who answered and which detector said so. */
const verdictLabel = (l: Line) => {
  const who = l.answeredBy === 'human' ? 'person' : l.answeredBy?.startsWith('machine') ? 'machine' : (l.answeredBy ?? '').replace(/_/g, ' ');
  return l.verdictSource === 'speech' ? `${who} (heard)` : `${who} (AMD)`;
};
/** Seconds from pickup to verdict; the speech gate reports its own audio latency, which is the honest number. */
const verdictSeconds = (l: Line) => {
  if (l.verdictSource === 'speech' && typeof l.speech?.latencyMs === 'number') return fmtFixed(l.speech.latencyMs / 1000, 1);
  return l.answeredAt && l.amdAt ? fmtFixed((new Date(l.amdAt).getTime() - new Date(l.answeredAt).getTime()) / 1000, 1) : '?';
};

function tickerEvents(s: Session): TickerEvent[] {
  const batch = s.lines.filter((l) => l.batch === s.batch && l.batch > 0);
  const ev: TickerEvent[] = [];
  batch.forEach((l, i) => {
    const who = l.prospect?.name ?? l.to ?? 'line';
    const n = i + 1;
    if (l.answeredAt) ev.push({ at: l.answeredAt, line: n, text: `${who} picked up, screening`, tone: 'ring' });
    if (l.amdAt && l.answeredBy) ev.push({ at: l.amdAt, line: n, text: `${verdictLabel(l)}${l.answeredAt ? ` in ${verdictSeconds(l)}s` : ''}${l.speech?.text ? ` · “${l.speech.text.slice(0, 48)}”` : ''}`, tone: l.answeredBy === 'human' ? 'live' : l.answeredBy.startsWith('machine') ? 'vm' : 'off' });
    if (l.connectedAt) ev.push({ at: l.connectedAt, line: n, text: `${who} on with you`, tone: 'live' });
    if (l.endedAt) ev.push({ at: l.endedAt, line: n, text: `${LINE_LABEL[l.status]?.toLowerCase() ?? l.status}${l.endReason && l.endReason !== l.status && l.endReason !== l.answeredBy ? ` · ${l.endReason.replace(/_/g, ' ')}` : ''}`, tone: toneFor(l.status) === 'live' ? 'off' : toneFor(l.status) });
  });
  return ev.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function RepRail({ session: s, dialer, keypadOpen, onKeypad, onRejoin }: { session: Session; dialer: ReturnType<typeof useDialer>; keypadOpen: boolean; onKeypad: () => void; onRejoin: () => void }) {
  const browser = s.repMode === 'browser';
  const joined = browser ? dialer.onLine : s.status !== 'waiting_rep';
  const rep = phoneInfo(s.repPhone);
  const events = useMemo(() => tickerEvents(s), [s]);
  return (
    <div className="ck-cell grid gap-3 p-3 md:grid-cols-[220px_minmax(0,1fr)_auto] md:items-center" data-testid="pd-rail" data-live={s.status === 'connected' ? 'true' : undefined}>
      <div className="flex items-center gap-3">
        <Led tone={joined ? (s.status === 'connected' ? 'live' : 'idle') : 'ring'} pulse={!joined} />
        <div>
          <div className="ck-label">Your line</div>
          <div className="text-sm font-medium" data-testid="pd-rail-status">
            {joined ? (browser ? 'Browser, on the line' : `Phone ${rep?.national ?? s.repPhone ?? ''}`) : browser ? 'Not on the line' : `Ringing ${rep?.national ?? s.repPhone ?? 'your phone'}`}
          </div>
          <div className="ck-mono text-xs" style={{ color: 'var(--ck-faint)' }}>
            session <Timer from={s.createdAt} animated={false} />
          </div>
        </div>
      </div>
      <div className="min-w-0">
        {browser ? (
          <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Scope levels={dialer.levels} active={dialer.onLine} />
            <Ticker events={events} sessionStart={s.createdAt} />
          </div>
        ) : (
          <Ticker events={events} sessionStart={s.createdAt} className="min-h-14" />
        )}
        {dialer.warning && (
          <div className="ck-label mt-1" style={{ color: 'var(--ck-ring)' }}>
            link warning: {dialer.warning.replace(/-/g, ' ')}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <SignalBars quality={dialer.quality} active={dialer.onLine} />
        {browser && !joined && (
          <button className="ck-btn" data-tone="live" onClick={onRejoin} data-testid="pd-join">
            <PhoneForwarded className="size-4" /> Join from this browser
          </button>
        )}
        {browser && joined && (
          <button className="ck-btn" onClick={() => dialer.mute(!dialer.muted)} data-testid="pd-mute" aria-pressed={dialer.muted} style={dialer.muted ? { borderColor: 'var(--ck-ring)', color: 'var(--ck-ring)' } : undefined}>
            {dialer.muted ? <MicOff className="size-4" /> : <Mic className="size-4" />} {dialer.muted ? 'Muted' : 'Mute'} <Kbd>M</Kbd>
          </button>
        )}
        <button className="ck-btn" onClick={onKeypad} aria-pressed={keypadOpen} data-testid="pd-keypad">
          <Grid3x3 className="size-4" /> <Kbd>K</Kbd>
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- board */

function Board({ session: s, connected, onLogged, onQueue }: { session: Session; connected: Line | null; onLogged: () => void; onQueue: (ids: string[]) => void }) {
  const batch = s.lines.filter((l) => l.batch === s.batch && l.batch > 0);
  const siblings = batch.filter((l) => l.id !== connected?.id);
  const queued = s.lines.filter((l) => l.status === 'queued');
  const skipped = s.lines.filter((l) => l.status === 'skipped');
  const history = s.lines.filter((l) => l.batch > 0 && l.batch < s.batch && !LIVE.has(l.status));
  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="grid gap-4">
        <LayoutGroup>
          <div className="grid gap-3" data-testid="pd-lines">
            {batch.length === 0 && (
              <div className="ck-cell flex h-28 items-center justify-center text-sm" style={{ color: 'var(--ck-faint)' }}>
                {queued.length ? `${queued.length} queued. Press D to ring the next ${Math.min(s.maxLines, queued.length)}.` : 'Queue is empty. Add prospects on the right.'}
              </div>
            )}
            {connected ? (
              <>
                <ConnectedCell key={connected.id} line={connected} session={s} onLogged={onLogged} />
                {siblings.length > 0 && (
                  <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.min(4, siblings.length)}, minmax(0, 1fr))` }}>
                    {siblings.map((l) => (
                      <LineStrip key={l.id} line={l} index={batch.indexOf(l) + 1} />
                    ))}
                  </div>
                )}
              </>
            ) : (
              batch.length > 0 && (
                <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${Math.min(4, batch.length)}, minmax(0, 1fr))` }}>
                  {batch.map((l, i) => (
                    <LineCell key={l.id} line={l} index={i + 1} />
                  ))}
                </div>
              )
            )}
          </div>
        </LayoutGroup>
        <Tally session={s} history={history} />
      </div>
      <Queue queued={queued} skipped={skipped} onQueue={onQueue} />
    </div>
  );
}

/** One instrument channel while a batch is ringing. */
function LineCell({ line: l, index }: { line: Line; index: number }) {
  const tone = toneFor(l.status);
  const racing = l.status === 'dialing' || l.status === 'ringing' || l.status === 'answered';
  const verdictMs = l.answeredAt && l.amdAt ? new Date(l.amdAt).getTime() - new Date(l.answeredAt).getTime() : null;
  const color = tone === 'live' ? 'var(--ck-live)' : tone === 'ring' ? 'var(--ck-ring)' : tone === 'drop' ? 'var(--ck-drop)' : tone === 'vm' ? 'var(--ck-vm)' : 'var(--ck-dim)';
  return (
    <motion.div layout layoutId={`line-${l.id}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 36 }} className={cn('ck-cell min-w-0 p-3', l.status === 'answered' && 'ck-scan')} data-testid="pd-line" data-status={l.status} data-ringing={racing ? 'true' : undefined}>
      <div className="mb-2 flex items-center justify-between">
        <span className="ck-label">Line {index}</span>
        <span className="flex items-center gap-2 text-xs" style={{ color }}>
          <Led tone={tone} pulse={racing} />
          {LINE_LABEL[l.status] ?? l.status}
        </span>
      </div>
      <CallerId name={l.prospect?.name} title={l.prospect?.title} account={l.prospect?.account} phone={l.to ?? l.prospect?.phone} timezone={l.prospect?.timezone} city={l.prospect?.city} state={l.prospect?.state} />
      <div className="ck-mono mt-2 flex items-center justify-between text-xs" style={{ color: 'var(--ck-faint)' }}>
        <span>{racing && l.answeredAt ? <Timer from={l.answeredAt} animated={false} /> : l.durationSeconds ? <Timer from={null} fixedSeconds={l.durationSeconds} animated={false} /> : '—'}</span>
        <span>{verdictMs !== null && l.answeredBy ? `${verdictLabel(l)} in ${verdictSeconds(l)}s` : l.status === 'answered' ? 'screening' : l.endReason ? l.endReason.replace(/_/g, ' ') : ''}</span>
      </div>
      {l.speech?.text && (
        <div className="mt-1 truncate text-xs italic" style={{ color: 'var(--ck-faint)' }} title={l.speech.text} data-testid="pd-heard">
          “{l.speech.text}”
        </div>
      )}
      {l.status === 'dropped' && l.callbackTaskId && (
        <div className="mt-1 text-xs" style={{ color: 'var(--ck-drop)' }}>
          Callback task created.
        </div>
      )}
    </motion.div>
  );
}

/** Collapsed sibling while someone is connected. */
function LineStrip({ line: l, index }: { line: Line; index: number }) {
  return (
    <motion.div layout layoutId={`line-${l.id}`} className="ck-cell flex min-w-0 items-center gap-2 px-3 py-2 text-xs" data-testid="pd-line" data-status={l.status} style={{ opacity: 0.85 }}>
      <Led tone={toneFor(l.status)} pulse={l.status === 'answered'} />
      <span className="ck-label">L{index}</span>
      <span className="truncate font-medium">{l.prospect?.name ?? l.to}</span>
      {l.speech?.text && (
        <span className="truncate italic" style={{ color: 'var(--ck-faint)' }} title={l.speech.text} data-testid="pd-heard">
          “{l.speech.text}”
        </span>
      )}
      <span className="ml-auto shrink-0" style={{ color: 'var(--ck-dim)' }}>{LINE_LABEL[l.status] ?? l.status}</span>
    </motion.div>
  );
}

/* --------------------------------------------------------- connected cell */

function ConnectedCell({ line, session, onLogged }: { line: Line; session: Session; onLogged: () => void }) {
  const p = line.prospect;
  const ended = line.status !== 'connected';
  const emails = useApi<{ data: any[] }>(p ? `/v1/emails${q({ 'filter[prospect][id]': p.id, 'page[size]': 3 })}` : null, [p?.id]);
  const calls = useApi<{ data: any[] }>(p ? `/v1/calls${q({ 'filter[prospect][id]': p.id, 'page[size]': 4, include: 'callDisposition' })}` : null, [p?.id]);
  const signals = useApi<{ data: any[] }>(p ? `/v1/signals${q({ 'filter[prospect][id]': p.id, 'page[size]': 3 })}` : null, [p?.id]);
  const touches = useMemo(() => {
    const t: Array<{ at: string; kind: string; text: string }> = [];
    for (const e of emails.data?.data ?? []) t.push({ at: e.createdAt, kind: e.direction === 'inbound' ? 'reply' : 'email', text: e.subject ?? '(no subject)' });
    for (const c of calls.data?.data ?? []) if (c.id !== line.callId) t.push({ at: c.time, kind: 'call', text: c.callDisposition?.name ?? c.outcome ?? c.status });
    for (const s of signals.data?.data ?? []) t.push({ at: s.occurredAt, kind: 'signal', text: s.title ?? s.kind });
    return t.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(0, 5);
  }, [emails.data, calls.data, signals.data, line.callId]);
  return (
    <motion.div initial={{ opacity: 0, scale: 0.985 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.22, ease: 'easeOut' }} className="ck-cell grid gap-4 p-4 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]" data-live={ended ? undefined : 'true'} data-testid="pd-connected">
      <div className="min-w-0">
        <div className="mb-3 flex items-center gap-2">
          <Led tone={ended ? 'off' : 'live'} />
          <span className="ck-label" style={{ color: ended ? undefined : 'var(--ck-live)' }}>
            {ended ? 'Call ended' : 'Live'}
          </span>
          <span className="ck-mono ml-auto text-2xl" data-testid="pd-live-timer">
            <Timer from={ended ? null : line.connectedAt} fixedSeconds={line.durationSeconds ?? 0} />
          </span>
        </div>
        <CallerId size="lg" name={p?.name ?? line.to} title={p?.title} account={p?.account} phone={line.to ?? p?.phone} timezone={p?.timezone} city={p?.city} state={p?.state} />
        {line.answeredBy && (
          <div className="ck-mono mt-2 flex items-center gap-2 text-xs" style={{ color: 'var(--ck-faint)' }} data-testid="pd-verdict">
            <span>{`${verdictLabel(line)} in ${verdictSeconds(line)}s`}</span>
            {line.speech?.text && (
              <span className="truncate italic" title={line.speech.text} data-testid="pd-heard">
                “{line.speech.text}”
              </span>
            )}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          {p?.id && (
            <Link to={`/prospects/${p.id}`} className="ck-btn h-7 px-2 text-xs">
              Open prospect
            </Link>
          )}
          {p?.linkedInUrl && (
            <a href={p.linkedInUrl} target="_blank" rel="noreferrer" className="ck-btn h-7 px-2 text-xs">
              LinkedIn
            </a>
          )}
          {p?.email && (
            <span className="ck-mono self-center" style={{ color: 'var(--ck-faint)' }}>
              {p.email}
            </span>
          )}
        </div>
        <div className="mt-4">
          <div className="ck-label mb-1.5">Recent</div>
          {touches.length === 0 ? (
            <div className="text-xs" style={{ color: 'var(--ck-faint)' }}>
              First touch.
            </div>
          ) : (
            <ul className="grid gap-1 text-xs">
              {touches.map((t, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="ck-label w-10 shrink-0">{t.kind}</span>
                  <span className="truncate">{t.text}</span>
                  <span className="ck-mono ml-auto shrink-0" style={{ color: 'var(--ck-faint)' }}>
                    {new Date(t.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <LogForm line={line} wrapping={session.status === 'wrapping'} onLogged={onLogged} />
    </motion.div>
  );
}

function LogForm({ line, wrapping, onLogged }: { line: Line; wrapping: boolean; onLogged: () => void }) {
  const [outcome, setOutcome] = useState('connected');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [logged, setLogged] = useState<string | null>(null);
  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    setOutcome('connected');
    setNotes('');
    setLogged(null);
  }, [line.id]);
  useHotkeys(useMemo(() => ({ l: () => notesRef.current?.focus() }), []));
  const log = async () => {
    if (!line.callId) return;
    setBusy(true);
    try {
      await api(`/v1/calls/${line.callId}/actions/log`, { method: 'POST', json: { data: { outcome, notes: notes || undefined } } });
      setLogged(line.id);
      toast('Call logged', 'info');
      onLogged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid content-start gap-3 md:border-l md:pl-4" style={{ borderColor: 'var(--ck-line)' }}>
      <div className="flex items-center justify-between">
        <span className="ck-label">Outcome</span>
        {wrapping && (
          <span className="ck-label" style={{ color: 'var(--ck-ring)' }}>
            log, then dial
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" data-testid="pd-outcome">
        {OUTCOMES.map(([v, l]) => (
          <button key={v} type="button" role="radio" aria-checked={outcome === v} onClick={() => setOutcome(v)} className="ck-btn h-8 px-2.5 text-xs" style={outcome === v ? { borderColor: 'var(--ck-live)', color: 'var(--ck-live)', background: 'var(--ck-live-dim)' } : undefined} data-testid={`pd-outcome-${v}`}>
            {l}
          </button>
        ))}
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="ck-label">Notes</span>
          <Kbd>L</Kbd>
        </div>
        <textarea ref={notesRef} rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What happened, next step" className="ck-input h-auto resize-none py-2" data-testid="pd-notes" />
      </div>
      <button onClick={log} disabled={busy || logged === line.id || !line.callId} className="ck-btn justify-center" data-tone={logged === line.id ? undefined : 'live'} data-testid="pd-log">
        {logged === line.id ? 'Logged' : 'Log call'}
      </button>
    </div>
  );
}

/* ----------------------------------------------------------- queue, tally */

function Queue({ queued, skipped, onQueue }: { queued: Line[]; skipped: Line[]; onQueue: (ids: string[]) => void }) {
  const [search, setSearch] = useState('');
  const all = useApi<{ data: any[] }>(`/v1/prospects${q({ 'page[size]': 100 })}`);
  const found = useMemo(() => (search.length >= 2 ? (all.data?.data ?? []).filter((p) => `${p.name ?? ''} ${p.phone ?? ''}`.toLowerCase().includes(search.toLowerCase())).slice(0, 6) : []), [search, all.data]);
  return (
    <div className="ck-cell p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="ck-label">Up next</span>
        <span className="ck-mono text-xs" style={{ color: 'var(--ck-dim)' }}>
          {queued.length}
        </span>
      </div>
      <ul className="grid gap-1.5">
        {queued.slice(0, 10).map((l) => (
          <li key={l.id} className="ck-row flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs">
            <span className="truncate font-medium">{l.prospect?.name ?? l.to}</span>
            <span className="ck-mono shrink-0" style={{ color: 'var(--ck-faint)' }}>
              {phoneInfo(l.to)?.region ?? ''}
            </span>
          </li>
        ))}
        {queued.length > 10 && <li className="ck-label">and {queued.length - 10} more</li>}
      </ul>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Add a prospect" className="ck-input mt-3" data-testid="pd-live-search" />
      {found.length > 0 && (
        <ul className="mt-1.5 grid gap-1">
          {found.map((p: any) => (
            <li key={p.id}>
              <button type="button" className="ck-row flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs" onClick={() => (onQueue([p.id]), setSearch(''))}>
                <span className="truncate">{p.name}</span>
                <span className="ck-mono shrink-0" style={{ color: 'var(--ck-faint)' }}>
                  {phoneInfo(p.phone)?.national ?? 'no phone'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {skipped.length > 0 && (
        <details className="mt-3 text-xs" style={{ color: 'var(--ck-faint)' }}>
          <summary className="ck-label cursor-pointer">{skipped.length} skipped</summary>
          <ul className="mt-1 grid gap-1">
            {skipped.map((l) => (
              <li key={l.id} className="flex justify-between gap-2">
                <span className="truncate">{l.prospect?.name ?? l.to}</span>
                <span className="shrink-0">{SKIP_LABEL[l.skipReason ?? ''] ?? l.skipReason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Tally({ session: s, history }: { session: Session; history: Line[] }) {
  const st = s.stats;
  const cells: Array<[string, number, string]> = [
    ['Dialed', st.dialed ?? 0, 'var(--ck-text)'],
    ['Talked', st.connected ?? 0, 'var(--ck-live)'],
    ['Voicemail', st.voicemail ?? 0, 'var(--ck-vm)'],
    ['No answer', (st.noAnswer ?? 0) + (st.busy ?? 0), 'var(--ck-dim)'],
    ['Dropped', st.dropped ?? 0, 'var(--ck-drop)'],
  ];
  return (
    <div className="ck-cell p-3" data-testid="pd-tally">
      <div className="grid grid-cols-5 gap-2">
        {cells.map(([label, n, color]) => (
          <div key={label}>
            <div className="ck-label">{label}</div>
            <div className="ck-mono text-xl" style={{ color }}>
              {n}
            </div>
          </div>
        ))}
      </div>
      {history.length > 0 && (
        <ul className="mt-3 grid gap-1 border-t pt-3 text-xs" style={{ borderColor: 'var(--ck-line)' }}>
          {history
            .slice()
            .reverse()
            .slice(0, 8)
            .map((l) => (
              <li key={l.id} className="flex items-center gap-2">
                <Led tone={toneFor(l.status)} />
                <span className="truncate">{l.prospect?.name ?? l.to}</span>
                {l.callId && (l.status === 'completed' || l.status === 'dropped' || l.status === 'voicemail') && (
                  <Link to={`/calls/${l.callId}`} className="ck-label underline-offset-2 hover:underline">
                    call
                  </Link>
                )}
                <span className="ml-auto shrink-0" style={{ color: 'var(--ck-dim)' }}>
                  {LINE_LABEL[l.status] ?? l.status}
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- setup */

function Setup({ softphone, fromNumbers, maxLines, maxAllowed, busy, onStart, last }: { softphone: boolean; fromNumbers: string[]; maxLines: number; maxAllowed: number; busy: boolean; onStart: (i: { repMode: 'browser' | 'phone'; repPhone?: string; fromNumber?: string; maxLines: number; autoDial: boolean; prospectIds: string[]; taskIds: string[] }) => void; last: Session | null }) {
  const [repMode, setRepMode] = useState<'browser' | 'phone'>(softphone ? 'browser' : 'phone');
  const [repPhone, setRepPhone] = useState(loadRepPhone());
  const [from, setFrom] = useState(fromNumbers[0] ?? '');
  const [lines, setLines] = useState(maxLines);
  const [autoDial, setAutoDial] = useState(false);
  const [picked, setPicked] = useState<Map<string, { taskId?: string }>>(new Map());
  const [search, setSearch] = useState('');
  const today = useMemo(() => new Date(Date.now() + 86_400_000).toISOString(), []);
  const tasks = useApi<{ data: any[] }>(`/v1/tasks${q({ 'filter[completed]': 'false', 'filter[dueAt][lte]': today, include: 'prospect', 'page[size]': 100 })}`);
  const all = useApi<{ data: any[] }>(`/v1/prospects${q({ 'page[size]': 100 })}`);
  const found = useMemo(() => (search.length >= 2 ? (all.data?.data ?? []).filter((p) => `${p.name ?? ''} ${p.title ?? ''} ${p.phone ?? ''}`.toLowerCase().includes(search.toLowerCase())).slice(0, 20) : null), [search, all.data]);
  const callTasks = (tasks.data?.data ?? []).filter((t) => t.action === 'call' || t.action === 'manual_call');
  useEffect(() => {
    if (!from && fromNumbers[0]) setFrom(fromNumbers[0]);
  }, [fromNumbers]);
  const toggle = (id: string, v: { taskId?: string }) =>
    setPicked((m) => {
      const n = new Map(m);
      if (n.has(id)) n.delete(id);
      else n.set(id, v);
      return n;
    });
  const start = () => {
    saveRepPhone(repPhone);
    const prospectIds = [...picked.entries()].filter(([, v]) => !v.taskId).map(([id]) => id);
    const taskIds = [...picked.values()].filter((v) => v.taskId).map((v) => v.taskId!);
    onStart({ repMode, repPhone: repMode === 'phone' ? repPhone : undefined, fromNumber: from || undefined, maxLines: lines, autoDial, prospectIds, taskIds });
  };
  const fromInfo = phoneInfo(from);
  const repInfo = phoneInfo(repPhone);
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start">
      <div className="ck-cell grid content-start gap-4 p-4" data-testid="pd-setup">
        <div>
          <div className="ck-label">Your line</div>
          <div className="mt-1 text-sm" style={{ color: 'var(--ck-dim)' }}>
            You join first and wait in silence. Nothing rings until you press Dial.
          </div>
        </div>
        <div className="grid gap-1.5">
          <span className="ck-label">Join from</span>
          <div className="grid grid-cols-2 gap-1.5" role="radiogroup" data-testid="pd-rep-mode">
            <Choice on={repMode === 'browser'} disabled={!softphone} onClick={() => setRepMode('browser')} title="This browser" sub={softphone ? 'Mic, scope, keypad' : 'Needs Twilio setup'} testid="pd-mode-browser" />
            <Choice on={repMode === 'phone'} onClick={() => setRepMode('phone')} title="My phone" sub="Twilio rings you first" testid="pd-mode-phone" />
          </div>
        </div>
        {repMode === 'phone' && (
          <div className="grid gap-1.5">
            <span className="ck-label">Your phone</span>
            <input value={repPhone} onChange={(e) => setRepPhone(e.target.value)} placeholder="+1 555 999 8888" className="ck-input ck-mono" data-testid="pd-rep-phone" />
            {repInfo && (
              <span className="ck-mono text-xs" style={{ color: 'var(--ck-faint)' }}>
                {repInfo.national}
                {repInfo.region ? ` · ${repInfo.region}` : ''}
              </span>
            )}
          </div>
        )}
        <div className="grid gap-1.5">
          <span className="ck-label">Caller id</span>
          <div className="grid grid-cols-2 gap-1.5">
            {fromNumbers.map((n) => {
              const i = phoneInfo(n);
              return <Choice key={n} on={from === n} onClick={() => setFrom(n)} title={i?.national ?? n} sub={[i?.city ?? i?.region, localTime(i?.timezone)].filter(Boolean).join(' · ')} mono />;
            })}
          </div>
          {fromInfo?.region && <span className="ck-label">Local presence: {fromInfo.city ?? fromInfo.region}</span>}
        </div>
        <div className="grid gap-1.5">
          <span className="ck-label">Lines at once</span>
          <div className="flex gap-1.5" role="radiogroup" data-testid="pd-lines">
            {Array.from({ length: maxAllowed }, (_, i) => i + 1).map((n) => (
              <button key={n} type="button" role="radio" aria-checked={lines === n} onClick={() => setLines(n)} className="ck-btn ck-mono h-9 w-9 justify-center px-0" style={lines === n ? { borderColor: 'var(--ck-live)', color: 'var(--ck-live)', background: 'var(--ck-live-dim)' } : undefined} data-testid={`pd-lines-${n}`}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center justify-between gap-3 rounded-lg p-3" style={{ border: '1px solid var(--ck-line)' }}>
          <span>
            <span className="block text-sm font-medium">Auto-dial</span>
            <span className="block text-xs" style={{ color: 'var(--ck-dim)' }}>
              Ring the next batch when nobody answers
            </span>
          </span>
          <Switch checked={autoDial} onCheckedChange={setAutoDial} />
        </label>
        <button onClick={start} disabled={busy || (repMode === 'phone' && !repPhone) || !from} className="ck-btn justify-center" data-tone="live" data-testid="pd-start">
          <PhoneForwarded className="size-4" /> Join and queue {picked.size || ''} {picked.size === 1 ? 'prospect' : 'prospects'}
        </button>
        {last?.status === 'ended' && (
          <div className="rounded-lg p-3 text-xs" style={{ border: '1px dashed var(--ck-line-strong)', color: 'var(--ck-dim)' }} data-testid="pd-summary">
            Last session: {last.stats.dialed ?? 0} dialed, {last.stats.connected ?? 0} conversations, {last.stats.voicemail ?? 0} voicemail, {last.stats.dropped ?? 0} dropped{last.endReason ? ` · ${last.endReason.replace(/_/g, ' ')}` : ''}.
          </div>
        )}
      </div>
      <div className="ck-cell min-w-0 p-4" data-testid="pd-pick">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="ck-label">Who to call</div>
            <div className="mt-1 text-sm" style={{ color: 'var(--ck-dim)' }}>
              Call tasks due today first. No phone, do-not-call and quiet hours are skipped automatically.
            </div>
          </div>
          <div className="flex gap-1.5">
            <button className="ck-btn h-8 px-2.5 text-xs" onClick={() => setPicked(new Map(callTasks.filter((t) => t.prospect?.id).map((t) => [t.prospect.id, { taskId: t.id }])))} disabled={!callTasks.length} data-testid="pd-pick-all-tasks">
              Select all {callTasks.length} call tasks
            </button>
            <button className="ck-btn h-8 px-2.5 text-xs" onClick={() => setPicked(new Map())} disabled={!picked.size}>
              Clear
            </button>
          </div>
        </div>
        {callTasks.length > 0 && (
          <ul className="grid min-w-0 gap-1.5" data-testid="pd-task-list">
            {callTasks.map((t) => (
              <PickRow key={t.id} checked={picked.has(t.prospect?.id)} onToggle={() => t.prospect?.id && toggle(t.prospect.id, { taskId: t.id })} p={t.prospect} note={t.note} tag={t.sequence?.name ?? 'task'} />
            ))}
          </ul>
        )}
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Add any prospect by name, title or number" className="ck-input mt-3" data-testid="pd-search" />
        {found && (
          <ul className="mt-1.5 grid min-w-0 gap-1.5">
            {found.map((p: any) => (
              <PickRow key={p.id} checked={picked.has(p.id)} onToggle={() => toggle(p.id, {})} p={p} />
            ))}
            {found.length === 0 && <li className="ck-label py-2">No prospects match.</li>}
          </ul>
        )}
      </div>
    </div>
  );
}

function Choice({ on, disabled, onClick, title, sub, mono, testid }: { on: boolean; disabled?: boolean; onClick: () => void; title: string; sub?: string | null; mono?: boolean; testid?: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} disabled={disabled} onClick={onClick} className={cn('ck-row grid min-w-0 gap-0.5 px-3 py-2 text-left disabled:opacity-40', mono && 'ck-mono')} data-picked={on ? 'true' : undefined} data-testid={testid}>
      <span className="truncate text-sm font-medium">{title}</span>
      {sub && (
        <span className="truncate text-xs" style={{ color: 'var(--ck-faint)' }}>
          {sub}
        </span>
      )}
    </button>
  );
}

function PickRow({ checked, onToggle, p, note, tag }: { checked: boolean; onToggle: () => void; p: any; note?: string | null; tag?: string }) {
  const info = phoneInfo(p?.phone);
  const tz = p?.timezone ?? info?.timezone ?? null;
  const hour = localHour(tz);
  const quiet = hour !== null && (hour < 8 || hour >= 21);
  return (
    <li className="min-w-0 overflow-hidden">
      <button type="button" onClick={onToggle} className="ck-row flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-sm" data-picked={checked ? 'true' : undefined} data-testid="pd-pick-row" aria-pressed={checked}>
        <Led tone={checked ? 'live' : !p?.phone ? 'off' : quiet ? 'ring' : 'idle'} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-medium">{p?.name ?? 'Unknown'}</span>
          <span className="block truncate text-xs" style={{ color: 'var(--ck-faint)' }}>
            {[p?.title, note].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="ck-mono hidden shrink-0 text-right text-xs sm:block" style={{ color: 'var(--ck-dim)' }}>
          <span className="block">{info?.national ?? 'no phone'}</span>
          <span className="block" style={{ color: quiet ? 'var(--ck-ring)' : 'var(--ck-faint)' }}>
            {[info?.city ?? info?.region, localTime(tz)].filter(Boolean).join(' · ')}
            {quiet ? ' · quiet' : ''}
          </span>
        </span>
        {tag && (
          <span className="ck-label shrink-0 rounded px-1.5 py-0.5" style={{ border: '1px solid var(--ck-line-strong)' }}>
            {tag}
          </span>
        )}
      </button>
    </li>
  );
}
