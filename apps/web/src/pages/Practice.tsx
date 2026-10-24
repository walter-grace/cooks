import { useEffect, useRef, useState } from 'react';
import { Mic, PhoneOff, Play } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '../api.js';
import { toast, useApi } from '../hooks.js';
import { navigate } from '../router.js';
import { Empty, PageHeader } from '../components/layout.js';

type Line = { role: 'rep' | 'partner'; text: string; final: boolean };
type Phase = 'idle' | 'connecting' | 'live' | 'ending';

const WORKLET = `class P extends AudioWorkletProcessor{process(inputs){const ch=inputs[0]&&inputs[0][0];if(!ch)return true;const out=new Int16Array(ch.length);for(let i=0;i<ch.length;i++){const s=Math.max(-1,Math.min(1,ch[i]));out[i]=s<0?s*32768:s*32767}this.port.postMessage(out.buffer,[out.buffer]);return true}}registerProcessor('cooks-pcm',P)`;

/** Microphone in, partner audio out, over one WebSocket. Everything is torn down in `stop()`. */
class PracticeLink {
  private ws: WebSocket | null = null;
  private inCtx: AudioContext | null = null;
  private outCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private pending: Int16Array[] = [];
  private pendingLen = 0;
  private playing = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private outRate = 24_000;
  constructor(
    private on: { line: (l: Line) => void; level: (v: number) => void; ended: (reason: string) => void; error: (m: string) => void; ready: () => void },
  ) {}

  async start(s: { workspaceId: string; callId: string; token: string }) {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    this.inCtx = new AudioContext();
    this.outCtx = new AudioContext();
    const rate = this.inCtx.sampleRate;
    await this.inCtx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' })));
    const src = this.inCtx.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(this.inCtx, 'cooks-pcm');
    src.connect(node);
    const chunk = Math.round(rate / 50); // 20 ms
    node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
      const pcm = new Int16Array(ev.data);
      this.pending.push(pcm);
      this.pendingLen += pcm.length;
      if (this.pendingLen < chunk) return;
      const out = new Int16Array(this.pendingLen);
      let o = 0;
      for (const p of this.pending) {
        out.set(p, o);
        o += p.length;
      }
      this.pending = [];
      this.pendingLen = 0;
      let sum = 0;
      for (let i = 0; i < out.length; i++) sum += out[i]! * out[i]!;
      this.on.level(Math.min(1, Math.sqrt(sum / out.length) / 6000));
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(out.buffer);
    };
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/practice/stream`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', ws: s.workspaceId, callId: s.callId, token: s.token, sampleRate: rate }));
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return this.play(ev.data as ArrayBuffer);
      let m: any;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m.type === 'ready') {
        this.outRate = m.sampleRate ?? 24_000;
        this.on.ready();
      } else if (m.type === 'transcript') this.on.line({ role: m.role, text: m.text, final: !!m.final });
      else if (m.type === 'interrupt') this.flush();
      else if (m.type === 'ended') this.on.ended(m.reason ?? 'stop');
      else if (m.type === 'error') this.on.error(m.message ?? 'error');
    };
    ws.onclose = () => this.on.ended('closed');
    ws.onerror = () => this.on.error('Connection failed');
  }

  private play(buf: ArrayBuffer) {
    const ctx = this.outCtx;
    if (!ctx) return;
    const pcm = new Int16Array(buf, 0, Math.floor(buf.byteLength / 2));
    if (!pcm.length) return;
    const ab = ctx.createBuffer(1, pcm.length, this.outRate);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
    const node = ctx.createBufferSource();
    node.buffer = ab;
    node.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this.nextAt);
    node.start(at);
    this.nextAt = at + ab.duration;
    this.playing.add(node);
    node.onended = () => this.playing.delete(node);
  }
  private flush() {
    for (const n of this.playing) {
      try {
        n.stop();
      } catch {
        /* already done */
      }
    }
    this.playing.clear();
    this.nextAt = 0;
  }
  stop() {
    try {
      this.ws?.send(JSON.stringify({ type: 'stop' }));
    } catch {
      /* closed */
    }
  }
  dispose() {
    this.flush();
    this.ws?.close();
    this.ws = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.inCtx?.close();
    void this.outCtx?.close();
  }
}

export function Practice() {
  const status = useApi<{ data: any }>('/v1/practice/status');
  const scenarios = useApi<{ data: any[] }>('/v1/practice/scenarios');
  const prospects = useApi<{ data: any[] }>('/v1/prospects?page[size]=50');
  const [prospectId, setProspectId] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [active, setActive] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const link = useRef<PracticeLink | null>(null);
  const callId = useRef<string>('');

  useEffect(() => {
    if (phase !== 'live') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);
  useEffect(() => () => link.current?.dispose(), []);

  const pushLine = (l: Line) =>
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && !last.final && last.role === l.role) return [...prev.slice(0, -1), l];
      return [...prev, l];
    });

  const start = async (scenarioId?: string) => {
    setPhase('connecting');
    setLines([]);
    setSeconds(0);
    try {
      const r = await api('/v1/practice/sessions', { method: 'POST', json: { data: prospectId && !scenarioId ? { prospectId } : { scenarioId } } });
      const s = r.data;
      callId.current = s.callId;
      setActive(s);
      const l = new PracticeLink({
        line: pushLine,
        level: setLevel,
        ready: () => setPhase('live'),
        ended: () => {
          link.current?.dispose();
          link.current = null;
          setPhase('idle');
          if (callId.current) navigate(`/calls/${callId.current}`);
        },
        error: (m) => toast(m, 'error'),
      });
      link.current = l;
      await l.start({ workspaceId: s.workspaceId, callId: s.callId, token: s.token });
    } catch (e: any) {
      setPhase('idle');
      link.current?.dispose();
      link.current = null;
      toast(e?.name === 'NotAllowedError' ? 'Microphone access was denied' : e.message, 'error');
    }
  };
  const end = () => {
    setPhase('ending');
    link.current?.stop();
    // If the socket never answers, finalise through the API.
    setTimeout(async () => {
      if (!callId.current || !link.current) return;
      await api(`/v1/practice/sessions/${callId.current}/actions/end`, { method: 'POST' }).catch(() => undefined);
      link.current?.dispose();
      link.current = null;
      setPhase('idle');
      navigate(`/calls/${callId.current}`);
    }, 4000);
  };

  const mmss = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

  if (phase !== 'idle' && active) {
    return (
      <>
        <PageHeader title={active.scenario.title} description={active.scenario.brief} actions={<Button variant="destructive" onClick={end} disabled={phase === 'ending'} data-testid="practice-end"><PhoneOff className="mr-2 h-4 w-4" />End call</Button>} />
        <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{active.scenario.persona.name}</CardTitle>
              <CardDescription>{active.scenario.persona.title}, {active.scenario.persona.company}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <div className="flex items-center justify-between"><span className="text-muted-foreground">{phase === 'connecting' ? 'Connecting…' : phase === 'ending' ? 'Wrapping up…' : 'Live'}</span><span className="font-mono">{mmss}</span></div>
              <div className="flex items-center gap-2"><Mic className="h-4 w-4 text-muted-foreground" /><div className="h-2 flex-1 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(level * 100)}%` }} /></div></div>
              <p className="text-muted-foreground">Temperament: {active.scenario.persona.mood}.</p>
              <p className="text-xs text-muted-foreground">The scorecard appears on the call page when you hang up.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Transcript</CardTitle></CardHeader>
            <CardContent className="grid max-h-[32rem] gap-2 overflow-y-auto text-sm" data-testid="practice-transcript">
              {lines.length === 0 && <p className="text-muted-foreground">{phase === 'live' ? 'Say hello.' : 'Waiting for the line…'}</p>}
              {lines.map((l, i) => (
                <div key={i} className={`flex gap-3 ${l.role === 'rep' ? '' : 'text-muted-foreground'} ${l.final ? '' : 'opacity-70'}`}>
                  <span className="w-20 shrink-0 font-medium">{l.role === 'rep' ? 'You' : active.scenario.persona.name.split(' ')[0]}</span>
                  <span>{l.text}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Practice" description="Rehearse a call against an AI prospect who interrupts, hesitates and pushes back. Every practice call gets the same scorecard as a real one." />
      {status.error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>Could not reach the practice service: {status.error}</AlertDescription>
        </Alert>
      )}
      {status.data && !status.data.data.configured && (
        <Alert className="mb-4" data-testid="practice-off">
          <AlertDescription>{status.data.data.reason} See docs/practice.md.</AlertDescription>
        </Alert>
      )}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Rehearse a real call</CardTitle>
          <CardDescription>The partner plays one of your prospects, using their title and company.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Select value={prospectId} onValueChange={setProspectId}>
            <SelectTrigger className="w-72" data-testid="practice-prospect"><SelectValue placeholder="Pick a prospect" /></SelectTrigger>
            <SelectContent>
              {(prospects.data?.data ?? []).map((p: any) => (
                <SelectItem key={p.id} value={p.id}>{p.name}{p.title ? ` · ${p.title}` : ''}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => start()} disabled={!prospectId || !status.data?.data.configured}><Play className="mr-2 h-4 w-4" />Start call</Button>
        </CardContent>
      </Card>
      {scenarios.loading && <Skeleton className="h-40" />}
      {scenarios.data && scenarios.data.data.length === 0 && <Empty>No scenarios.</Empty>}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(scenarios.data?.data ?? []).map((s: any) => (
          <Card key={s.id} data-testid={`scenario-${s.id}`}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-base">{s.title}</CardTitle>
                <Badge variant={s.difficulty === 'hard' ? 'destructive' : s.difficulty === 'easy' ? 'secondary' : 'outline'}>{s.difficulty}</Badge>
              </div>
              <CardDescription>{s.persona.name}, {s.persona.title} at {s.persona.company}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 text-sm">
              <p>{s.brief}</p>
              <Button variant="outline" className="w-fit" onClick={() => start(s.id)} disabled={!status.data?.data.configured}><Play className="mr-2 h-4 w-4" />Start call</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
