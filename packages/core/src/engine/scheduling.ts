import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';

export interface SendWindow {
  /** Luxon weekdays: 1 = Monday ... 7 = Sunday */
  days: number[];
  /** "HH:mm" local time */
  start: string;
  end: string;
}

export const DEFAULT_WINDOW: SendWindow = { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' };
export const DEFAULT_JITTER_SECONDS = 300;

const hm = (s: string): [number, number] => {
  const [h, m] = s.split(':').map(Number);
  return [h ?? 0, m ?? 0];
};

export function isValidZone(tz: string | null | undefined): tz is string {
  return !!tz && DateTime.local().setZone(tz).isValid;
}

/** First zone in the chain that luxon accepts, else UTC. */
export function pickZone(...candidates: Array<string | null | undefined>): string {
  for (const c of candidates) if (isValidZone(c)) return c;
  return 'UTC';
}

/** If `d` falls inside the window (in `tz`) return it; otherwise the next window open. DST-safe via luxon. */
export function alignToWindow(d: Date, window: SendWindow, tz: string): Date {
  const days = window.days.length ? window.days : DEFAULT_WINDOW.days;
  const [sh, sm] = hm(window.start);
  const [eh, em] = hm(window.end);
  let t = DateTime.fromJSDate(d).setZone(tz);
  for (let i = 0; i < 15; i++) {
    const open = t.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
    const close = t.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
    if (days.includes(t.weekday)) {
      if (t >= open && t < close) return t.toJSDate();
      if (t < open) return open.toJSDate();
    }
    t = t.plus({ days: 1 }).set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  }
  return d; // window has no valid day; do not block forever
}

/** Deterministic jitter so retries and tests reproduce the same schedule. */
export function seededJitterSeconds(seed: string, maxSeconds: number): number {
  if (maxSeconds <= 0) return 0;
  const h = createHash('sha256').update(seed).digest();
  return h.readUInt32BE(0) % maxSeconds;
}

export interface NextRunArgs {
  base: Date;
  intervalMinutes: number;
  tz: string;
  window?: SendWindow;
  jitterSeconds?: number;
  seed: string;
  now: Date;
}

/** rawDue = base + interval → aligned into the send window → plus seeded jitter. Never in the past. */
export function computeNextRunAt(a: NextRunArgs): Date {
  const raw = new Date(Math.max(a.base.getTime() + a.intervalMinutes * 60_000, a.now.getTime()));
  const aligned = alignToWindow(raw, a.window ?? DEFAULT_WINDOW, a.tz);
  const jitter = seededJitterSeconds(a.seed, a.jitterSeconds ?? DEFAULT_JITTER_SECONDS);
  return new Date(aligned.getTime() + jitter * 1000);
}
