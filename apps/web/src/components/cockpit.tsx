/**
 * Instrument-panel pieces for the power dialer. Everything that moves is driven by real signals:
 * the scope by the Voice SDK's volume events, the signal bars by its quality samples, the LEDs by
 * line state. Nothing animates for decoration alone.
 */
import { useEffect, useRef, useState } from 'react';
import NumberFlow from '@number-flow/react';
import { AU, CA, DE, FR, GB, IN, MX, US } from 'country-flag-icons/react/3x2';
import { hasFlag } from 'country-flag-icons';
import getUnicodeFlagIcon from 'country-flag-icons/unicode';
import { cn } from '@/lib/utils';
import { localHour, localTime, phoneInfo, zoneAbbr, type PhoneInfo } from '../lib/phone.js';
import type { AudioLevels, LinkQuality } from '../dialer.js';

/* ------------------------------------------------------------------- LED */

export type LedTone = 'off' | 'idle' | 'ring' | 'live' | 'drop' | 'vm';
export function Led({ tone, pulse = false, className }: { tone: LedTone; pulse?: boolean; className?: string }) {
  return <span className={cn('ck-led shrink-0', className)} data-tone={tone === 'idle' ? undefined : tone} data-pulse={pulse ? 'true' : undefined} aria-hidden />;
}

export const toneFor = (status: string): LedTone =>
  status === 'connected' ? 'live' : status === 'ringing' || status === 'dialing' || status === 'answered' ? 'ring' : status === 'dropped' || status === 'failed' ? 'drop' : status === 'voicemail' ? 'vm' : status === 'queued' ? 'idle' : 'off';

/* ----------------------------------------------------------------- Scope */

/**
 * Scrolling two-trace oscilloscope. Reads the level ref on every frame, smooths with a fast attack
 * and slow release, and draws the last few seconds. Rep is the pale trace, the far end the accent.
 */
export function Scope({ levels, active, className, height = 56 }: { levels: React.MutableRefObject<AudioLevels>; active: boolean; className?: string; height?: number }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext('2d');
    if (!ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const N = 160;
    const inHist = new Float32Array(N);
    const outHist = new Float32Array(N);
    let sIn = 0;
    let sOut = 0;
    let frame = 0;
    let raf = 0;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = () => {
      const w = el.clientWidth;
      const h = height;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const lv = levels.current;
      const fresh = active && performance.now() - lv.at < 400;
      const tIn = fresh ? Math.min(1, lv.input * 1.6) : 0;
      const tOut = fresh ? Math.min(1, lv.output * 1.6) : 0;
      sIn += (tIn - sIn) * (tIn > sIn ? 0.6 : 0.12);
      sOut += (tOut - sOut) * (tOut > sOut ? 0.6 : 0.12);
      if (frame++ % 2 === 0) {
        inHist.copyWithin(0, 1);
        outHist.copyWithin(0, 1);
        inHist[N - 1] = sIn;
        outHist[N - 1] = sOut;
      }
      // baseline + faint grid
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += 24) {
        ctx.moveTo(x + 0.5, 0);
        ctx.lineTo(x + 0.5, h);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.moveTo(0, h / 2 + 0.5);
      ctx.lineTo(w, h / 2 + 0.5);
      ctx.stroke();
      const trace = (hist: Float32Array, color: string, width: number) => {
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
          const x = (i / (N - 1)) * w;
          const amp = hist[i]! * (h / 2 - 3);
          // symmetric envelope so silence is a line and speech a band
          const y = h / 2 + (i % 2 === 0 ? -amp : amp);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      trace(outHist, 'oklch(0.84 0.19 150)', 1.5);
      trace(inHist, 'rgba(255,255,255,0.75)', 1);
      if (!reduced || fresh) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [levels, active, height]);
  return <canvas ref={canvas} className={cn('block w-full', className)} style={{ height }} aria-hidden />;
}

/* ---------------------------------------------------------- Signal bars */

/** MOS 1–5 → 0–4 bars, refreshed once a second from the SDK sample ref. */
export function SignalBars({ quality, active }: { quality: React.MutableRefObject<LinkQuality>; active: boolean }) {
  const [q, setQ] = useState<LinkQuality>(quality.current);
  useEffect(() => {
    const id = window.setInterval(() => setQ({ ...quality.current }), 1000);
    return () => window.clearInterval(id);
  }, [quality]);
  const fresh = active && q.mos !== null && performance.now() - q.at < 5000;
  const bars = !fresh ? 0 : q.mos! >= 4.3 ? 4 : q.mos! >= 4.0 ? 3 : q.mos! >= 3.6 ? 2 : 1;
  const title = fresh ? `MOS ${q.mos!.toFixed(2)} · ${q.rtt ?? '–'} ms rtt · jitter ${q.jitter ?? '–'}` : active ? 'measuring' : 'no browser audio';
  return (
    <span className="inline-flex items-end gap-[2px]" title={title} aria-label={title}>
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="w-[3px] rounded-sm" style={{ height: 5 + i * 3, background: i < bars ? 'var(--ck-live)' : 'rgba(255,255,255,0.15)' }} />
      ))}
    </span>
  );
}

/* ----------------------------------------------------------------- Timer */

export function Timer({ from, fixedSeconds, className, animated = true }: { from: string | null | undefined; fixedSeconds?: number | null; className?: string; animated?: boolean }) {
  const [s, setS] = useState(() => (from ? Math.max(0, (Date.now() - new Date(from).getTime()) / 1000) : (fixedSeconds ?? 0)));
  useEffect(() => {
    if (!from) {
      setS(fixedSeconds ?? 0);
      return;
    }
    const tick = () => setS(Math.max(0, (Date.now() - new Date(from).getTime()) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [from, fixedSeconds]);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  if (!animated) return <span className={cn('ck-mono', className)}>{`${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`}</span>;
  return (
    <span className={cn('ck-mono inline-flex items-baseline', className)}>
      <NumberFlow value={m} format={{ minimumIntegerDigits: 2 }} />
      <span className="opacity-60">:</span>
      <NumberFlow value={sec} format={{ minimumIntegerDigits: 2 }} />
    </span>
  );
}

/* ---------------------------------------------------------------- Ticker */

export interface TickerEvent {
  at: string;
  line: number;
  text: string;
  tone: LedTone;
}

/** Last few line events across the batch, newest at the bottom, like a console log. */
export function Ticker({ events, sessionStart, className }: { events: TickerEvent[]; sessionStart: string; className?: string }) {
  const t0 = new Date(sessionStart).getTime();
  const last = events.slice(-5);
  return (
    <div className={cn('ck-mono grid gap-0.5 text-[11px]', className)} data-testid="pd-ticker" aria-live="polite">
      {last.length === 0 && <div style={{ color: 'var(--ck-faint)' }}>waiting for the first batch</div>}
      {last.map((e, i) => {
        const dt = Math.max(0, (new Date(e.at).getTime() - t0) / 1000);
        return (
          <div key={`${e.at}-${e.line}-${e.text}`} className="flex items-center gap-2" style={{ opacity: 0.45 + (0.55 * (i + 1)) / last.length }}>
            <span style={{ color: 'var(--ck-faint)' }}>{`${String(Math.floor(dt / 60)).padStart(2, '0')}:${String(Math.floor(dt % 60)).padStart(2, '0')}`}</span>
            <Led tone={e.tone} />
            <span className="ck-label" style={{ color: 'var(--ck-dim)' }}>L{e.line}</span>
            <span className="truncate" style={{ color: e.tone === 'live' ? 'var(--ck-live)' : e.tone === 'drop' ? 'var(--ck-drop)' : 'var(--ck-text)' }}>{e.text}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Flag */

const FLAGS: Record<string, React.ComponentType<{ className?: string; title?: string }>> = { US, CA, GB, AU, DE, FR, MX, IN };
export function Flag({ country, className }: { country: string | null | undefined; className?: string }) {
  if (!country) return null;
  const C = FLAGS[country];
  if (C) return <C className={cn('inline-block h-3 w-[18px] rounded-[2px] align-[-1px]', className)} title={country} />;
  if (hasFlag(country)) return <span className={cn('text-sm leading-none', className)}>{getUnicodeFlagIcon(country)}</span>;
  return null;
}

/* -------------------------------------------------------------- Caller ID */

export interface CallerIdProps {
  name: string | null | undefined;
  title?: string | null;
  account?: string | null;
  phone: string | null | undefined;
  timezone?: string | null;
  city?: string | null;
  state?: string | null;
  size?: 'sm' | 'lg';
  className?: string;
}

/** Name, formatted number with flag and region, local time with a quiet-hours flag. */
export function CallerId(p: CallerIdProps) {
  const info = phoneInfo(p.phone);
  const tz = p.timezone ?? info?.timezone ?? null;
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(id);
  }, []);
  const time = localTime(tz, now);
  const hour = localHour(tz, now);
  const quiet = hour !== null && (hour < 8 || hour >= 21);
  const place = p.city && p.state ? `${p.city}, ${p.state}` : p.city || p.state || (info?.city && info.region ? `${info.city}, ${info.region}` : (info?.region ?? null));
  const lg = p.size === 'lg';
  return (
    <div className={cn('min-w-0', p.className)}>
      <div className={cn('truncate font-semibold tracking-tight', lg ? 'text-2xl' : 'text-[15px]')}>{p.name ?? info?.national ?? p.phone ?? 'Unknown'}</div>
      {(p.title || p.account) && <div className={cn('truncate', lg ? 'text-sm' : 'text-xs')} style={{ color: 'var(--ck-dim)' }}>{[p.title, p.account].filter(Boolean).join(' · ')}</div>}
      <div className={cn('ck-mono mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5', lg ? 'text-sm' : 'text-xs')} style={{ color: 'var(--ck-dim)' }}>
        <span className="inline-flex items-center gap-1.5">
          <Flag country={info?.country} />
          {info?.national ?? p.phone ?? '—'}
        </span>
        {place && <span style={{ color: 'var(--ck-faint)' }}>{place}</span>}
        {time && (
          <span className={cn('inline-flex items-center gap-1')} style={{ color: quiet ? 'var(--ck-ring)' : 'var(--ck-faint)' }} title={tz ?? undefined}>
            {time}
            {zoneAbbr(tz, now) && <span className="opacity-70">{zoneAbbr(tz, now)}</span>}
            {quiet && <span className="ck-label" style={{ color: 'var(--ck-ring)' }}>quiet hrs</span>}
          </span>
        )}
      </div>
    </div>
  );
}

export const describePhone = (phone: string | null | undefined): PhoneInfo | null => phoneInfo(phone);

/* ---------------------------------------------------------------- Keypad */

const KEYS: Array<[string, string]> = [['1', ''], ['2', 'ABC'], ['3', 'DEF'], ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'], ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'], ['*', ''], ['0', '+'], ['#', '']];

/** DTMF pad for IVRs and extensions. Only works on the browser leg (the phone leg uses the handset). */
export function Keypad({ onDigit, enabled }: { onDigit: (d: string) => void; enabled: boolean }) {
  const [typed, setTyped] = useState('');
  const press = (d: string) => {
    if (!enabled) return;
    onDigit(d);
    setTyped((t) => (t + d).slice(-24));
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!enabled) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (/^[0-9*#]$/.test(e.key)) press(e.key);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return (
    <div className="grid gap-2">
      <div className="ck-mono flex h-7 items-center justify-center text-lg tracking-[0.3em]" style={{ color: typed ? 'var(--ck-text)' : 'var(--ck-faint)' }}>
        {typed || '·'}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {KEYS.map(([d, letters]) => (
          <button key={d} type="button" onClick={() => press(d)} disabled={!enabled} className="ck-btn flex h-12 flex-col items-center justify-center gap-0 rounded-xl px-0" data-testid={`keypad-${d}`}>
            <span className="ck-mono text-base leading-none">{d}</span>
            {letters && <span className="ck-label mt-0.5 text-[8px] tracking-[0.2em]">{letters}</span>}
          </button>
        ))}
      </div>
      {!enabled && <div className="ck-label text-center">keypad works on the browser line</div>}
    </div>
  );
}

/* -------------------------------------------------------------- Hotkeys */

/** Global single-key shortcuts that ignore typing targets. */
export function useHotkeys(map: Record<string, (() => void) | undefined>) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.getAttribute('role') === 'combobox')) return;
      const fn = map[e.key.toLowerCase()];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [map]);
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="ck-kbd">{children}</kbd>;
}
