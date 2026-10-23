'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The power dialer panel as a working demo. Scripted batches, a clock that runs four times faster
 * than life, and the same verdict timings the speech gate produces on the mock carrier. The first
 * render is the settled batch, so the server-rendered HTML is complete without script.
 */

type Verdict = 'human' | 'voicemail' | 'machine' | 'busy' | 'noanswer';
type State = 'ring' | Verdict | 'hungup' | 'logged';
interface Scripted { n: string; p: string; c: string; v: Verdict; at?: number; q?: string }
interface Line extends Scripted { state: State; settledAt: number | null; outcome?: string }

const BATCHES: Scripted[][] = [
  [
    { n: 'Maya Chen', p: '+1 415 555 0142', c: 'Globex', v: 'human', at: 0.8, q: 'Hello?' },
    { n: 'Dev Patel', p: '+1 312 555 0199', c: 'Initech', v: 'voicemail', at: 1.0, q: "you've reached" },
    { n: 'Sam Okafor', p: '+1 646 555 0127', c: 'Hooli', v: 'busy' },
    { n: 'Lena Fischer', p: '+1 206 555 0163', c: 'Vandelay', v: 'noanswer', at: 31 },
  ],
  [
    { n: 'Priya Nair', p: '+1 512 555 0188', c: 'Acme', v: 'voicemail', at: 1.1, q: 'leave a message' },
    { n: 'Tom Walsh', p: '+1 617 555 0134', c: 'Stark', v: 'human', at: 0.9, q: 'Hi, this is Tom' },
    { n: 'Ana Costa', p: '+1 305 555 0171', c: 'Wayne', v: 'noanswer', at: 28 },
    { n: 'Omar Haddad', p: '+1 206 555 0115', c: 'Umbrella', v: 'busy' },
  ],
  [
    { n: 'Grace Liu', p: '+1 408 555 0122', c: 'Soylent', v: 'human', at: 0.7, q: 'Hello, Grace speaking' },
    { n: 'Jonas Berg', p: '+1 303 555 0149', c: 'Tyrell', v: 'voicemail', at: 1.2, q: 'not available' },
    { n: 'Ravi Menon', p: '+1 212 555 0106', c: 'Cyberdyne', v: 'busy' },
    { n: 'Elena Rossi', p: '+1 737 555 0160', c: 'Oscorp', v: 'machine', at: 3.0 },
  ],
];
const OUTCOMES = ['Meeting booked', 'Left voicemail', 'Not interested'];
const SPEED = 4;
const TICK = 250;

const mmss = (sec: number) => {
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
};

function seeded(): Line[] {
  return BATCHES[0].map((x) => ({ ...x, state: x.v, settledAt: x.v === 'busy' ? 6 : x.v === 'noanswer' ? 31 : null }));
}

function Status({ l }: { l: Line }) {
  switch (l.state) {
    case 'ring': return <>ringing</>;
    case 'human': return <>person · heard <q>{l.q}</q></>;
    case 'voicemail': return <>voicemail · heard <q>{l.q}</q></>;
    case 'machine': return <>machine · carrier detection</>;
    case 'busy': return <>hung up, rep is busy</>;
    case 'noanswer': return <>no answer · callback task made</>;
    case 'hungup': return <>hung up · log the call</>;
    case 'logged': return <>logged · {l.outcome}</>;
  }
}

function timeCell(l: Line, clock: number) {
  if (l.state === 'human' || l.state === 'voicemail' || l.state === 'machine' || l.state === 'logged' || l.state === 'hungup') {
    const at = l.at ?? 0;
    return at < 10 ? `${at.toFixed(1)} s` : mmss(at);
  }
  return mmss(l.settledAt ?? clock);
}

export function DialerDemo() {
  const [lines, setLines] = useState<Line[]>(seeded);
  const [human, setHuman] = useState(0);
  const [clock, setClock] = useState(0);
  const [batchNo, setBatchNo] = useState(3);
  const batchIndex = useRef(0);
  const timers = useRef<number[]>([]);
  const clockRef = useRef(0);

  const clear = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (ms: number, fn: () => void) => { timers.current.push(window.setTimeout(fn, ms)); };
  useEffect(() => clear, []);

  const start = useCallback((script: Scripted[]) => {
    clear();
    clockRef.current = 0;
    setClock(0);
    setHuman(-1);
    setLines(script.map((x) => ({ ...x, state: 'ring', settledAt: null })));
    const tick = () => {
      clockRef.current += (TICK / 1000) * SPEED;
      setClock(clockRef.current);
      later(TICK, tick);
    };
    later(TICK, tick);
    script.forEach((x, i) => {
      if (x.v === 'human') later((x.at ?? 1) * 1000, () => {
        setHuman((h) => (h >= 0 ? h : i));
        setLines((ls) => ls.map((l, j) => (j === i && l.state === 'ring' ? { ...l, state: 'human' } : l.v === 'busy' && l.state === 'ring' ? { ...l, state: 'busy', settledAt: clockRef.current + 0.3 } : l)));
      });
      else if (x.v === 'voicemail' || x.v === 'machine') later((x.at ?? 1) * 1000, () => {
        setLines((ls) => ls.map((l, j) => (j === i && l.state === 'ring' ? { ...l, state: x.v } : l)));
      });
      else if (x.v === 'noanswer') later(((x.at ?? 30) * 1000) / SPEED, () => {
        setLines((ls) => ls.map((l, j) => (j === i && l.state === 'ring' ? { ...l, state: 'noanswer', settledAt: x.at ?? 30 } : l)));
      });
      else later(6000, () => {
        setLines((ls) => ls.map((l, j) => (j === i && l.state === 'ring' ? { ...l, state: 'noanswer', settledAt: clockRef.current } : l)));
      });
    });
  }, []);

  const ringing = lines.some((l) => l.state === 'ring');
  useEffect(() => { if (!ringing) clear(); }, [ringing]);

  const log = (outcome: string) => setLines((ls) => ls.map((l, j) => (j === human ? { ...l, state: 'logged', outcome } : l)));
  const hangup = () => setLines((ls) => ls.map((l, j) => (j === human ? { ...l, state: 'hungup' } : l)));
  const next = () => {
    batchIndex.current = (batchIndex.current + 1) % BATCHES.length;
    setBatchNo((n) => (n >= 12 ? 1 : n + 1));
    start(BATCHES[batchIndex.current]);
  };

  const live = human >= 0 ? lines[human] : null;
  return (
    <div className="panel pd" aria-label="Power dialer demo: log the connected call, then dial the next batch">
      <div className="bar"><b>Power dialer</b><span className="live">Live · batch {batchNo} of 12</span></div>
      <div className="rows" aria-live="polite">
        {lines.map((l, i) => (
          <div key={`${batchNo}-${i}`} className={`row${l.state === 'ring' ? ' ring' : ''}${i === human && (l.state === 'human' || l.state === 'hungup') ? ' on' : ''}${l.state === 'logged' ? ' done' : ''}`}>
            <div className="who">{l.n}<small>{l.p} · {l.c}</small></div>
            <div className="st"><Status l={l} /></div>
            <div className="t">{timeCell(l, clock)}</div>
          </div>
        ))}
      </div>
      <div className="foot">
        {live && live.state !== 'logged' ? (
          <>
            <span className="chip fill">{live.state === 'hungup' ? 'Call ended' : `Talking to ${live.n}`}</span>
            {OUTCOMES.map((o) => <button key={o} className="chip" type="button" onClick={() => log(o)}>{o}</button>)}
            {live.state !== 'hungup' && <button className="chip" type="button" onClick={hangup}>Hang up</button>}
          </>
        ) : live ? (
          <>
            <span className="chip ok">Logged: {live.outcome}</span>
            <button className="chip fill" type="button" onClick={next}>Dial next batch</button>
          </>
        ) : !ringing ? (
          <>
            <span className="chip">No one answered</span>
            <button className="chip fill" type="button" onClick={next}>Dial next batch</button>
          </>
        ) : (
          <span className="chip">Ringing {lines.filter((l) => l.state === 'ring').length} lines</span>
        )}
      </div>
    </div>
  );
}
