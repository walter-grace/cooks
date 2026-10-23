import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Phone, PhoneCall, PhoneForwarded, PhoneOff, Square } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { api, q } from '../api.js';
import { toast, useApi } from '../hooks.js';
import { Link } from '../router.js';
import { Empty, PageHeader } from '../components/layout.js';
import { LINE_LABEL, OUTCOMES, SESSION_LABEL, fmtDuration, loadRepPhone, saveRepPhone, useDialer } from '../dialer.js';

type Line = { id: string; batch: number; status: string; to: string | null; prospect: { id: string; name: string | null; title: string | null; phone: string | null; account: string | null } | null; callId: string | null; taskId: string | null; callbackTaskId: string | null; answeredBy: string | null; skipReason: string | null; endReason: string | null; answeredAt: string | null; connectedAt: string | null; endedAt: string | null; durationSeconds: number | null };
type Session = { id: string; status: string; repMode: string; repPhone: string | null; fromNumber: string; maxLines: number; batch: number; complianceMode: string; autoDial: boolean; connectedLineId: string | null; connectedAt: string | null; endReason: string | null; stats: Record<string, number>; lines: Line[]; connectParams?: Record<string, string> };

const LIVE = new Set(['dialing', 'ringing', 'answered', 'connected']);

/**
 * Power dialer: the rep joins a silent room first (browser or phone), picks prospects, and rings a
 * batch. Each line shows its live state; the first human answer lands in the rep's ear with no
 * beep, the rest hang up. Log the call, dial again.
 */
export function PowerDialer() {
  const dialerCfg = useApi<{ data: any }>('/v1/workspace/dialer');
  const current = useApi<{ data: Session | null }>('/v1/dialSessions/current');
  const [session, setSession] = useState<Session | null>(null);
  const dialer = useDialer();
  const [busy, setBusy] = useState(false);
  const [joinedBrowser, setJoinedBrowser] = useState(false);
  const poll = useRef<number | null>(null);
  const cfg = dialerCfg.data?.data;
  const tw = cfg?.twilio;
  const parallel = cfg?.parallel;

  useEffect(() => {
    if (current.data) setSession(current.data.data);
  }, [current.data]);

  // Poll while the session is open. One second keeps line cards honest without hammering the API.
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

  const refresh = async () => {
    if (!session) return;
    const r = await api<{ data: Session }>(`/v1/dialSessions/${session.id}`);
    setSession((s) => ({ ...r.data, connectParams: s?.connectParams }));
  };

  const start = async (input: { repMode: 'browser' | 'phone'; repPhone?: string; fromNumber?: string; maxLines: number; autoDial: boolean; prospectIds: string[]; taskIds: string[] }) => {
    setBusy(true);
    try {
      const r = await api<{ data: Session }>('/v1/dialSessions', { method: 'POST', json: { data: input } });
      setSession(r.data);
      if (input.repMode === 'browser' && r.data.connectParams) {
        await dialer.joinConference(r.data.connectParams, () => setJoinedBrowser(false));
        setJoinedBrowser(true);
      }
      toast(input.repMode === 'browser' ? 'You are in the room. Dial when ready.' : 'Ringing your phone. Pick up to join.');
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const rejoinBrowser = async () => {
    if (!session) return;
    try {
      await dialer.joinConference({ kind: 'parallel', sessionId: session.id, ws: session.connectParams?.ws ?? '' }, () => setJoinedBrowser(false));
      setJoinedBrowser(true);
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const act = async (path: string, body?: unknown) => {
    if (!session) return;
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
  };
  const end = async () => {
    await act('/actions/end');
    dialer.hangup();
    setJoinedBrowser(false);
  };

  if (!cfg) return null;
  if (tw?.status !== 'connected') {
    return (
      <>
        <PageHeader title="Power dialer" description="Dial several prospects at once; the first person who answers is connected to you instantly." />
        <Empty>
          Connect Twilio under <Link to="/settings?tab=dialer" className="underline">Settings → Dialer</Link> to use the power dialer.
        </Empty>
      </>
    );
  }
  if (!parallel?.confirmed) {
    return (
      <>
        <PageHeader title="Power dialer" description="Dial several prospects at once; the first person who answers is connected to you instantly." />
        <Card data-testid="compliance-gate">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-600" /> An admin needs to confirm the compliance mode
            </CardTitle>
            <CardDescription>
              When two people answer at once, the second one is dropped. For calls to consumers in the US that counts as an abandoned call under the FTC Telemarketing Sales Rule, so an admin must choose B2B or consumer mode and confirm it under <Link to="/settings?tab=dialer" className="underline">Settings → Dialer</Link> first.
            </CardDescription>
          </CardHeader>
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Power dialer"
        description={session && session.status !== 'ended' ? `${SESSION_LABEL[session.status] ?? session.status} · caller id ${session.fromNumber} · ${session.maxLines} lines · ${session.complianceMode === 'consumer' ? 'consumer' : 'B2B'} mode` : 'Dial several prospects at once; the first person who answers is connected to you instantly, with no beep or message.'}
        actions={
          session && session.status !== 'ended' ? (
            <Button variant="destructive" onClick={end} disabled={busy} data-testid="pd-end">
              <Square className="size-4" /> End session
            </Button>
          ) : undefined
        }
      />
      {!session || session.status === 'ended' ? (
        <Setup softphone={!!tw.softphone} fromNumbers={tw.fromNumbers ?? []} maxLines={parallel.maxLines} maxAllowed={parallel.maxAllowedLines} busy={busy} onStart={start} last={session} />
      ) : (
        <Live session={session} busy={busy} joinedBrowser={joinedBrowser} onRejoin={rejoinBrowser} onDial={(lines) => act('/actions/dial', lines ? { lines } : {})} onHangup={() => act('/actions/hangup')} onQueue={(prospectIds) => act('/actions/queue', { prospectIds })} onToggleAuto={async (v) => {
          await api(`/v1/dialSessions/${session.id}`, { method: 'PATCH', json: { data: { autoDial: v } } });
          await refresh();
        }} onLogged={refresh} />
      )}
    </>
  );
}

/* ------------------------------------------------------------------ setup */

function Setup({ softphone, fromNumbers, maxLines, maxAllowed, busy, onStart, last }: { softphone: boolean; fromNumbers: string[]; maxLines: number; maxAllowed: number; busy: boolean; onStart: (i: { repMode: 'browser' | 'phone'; repPhone?: string; fromNumber?: string; maxLines: number; autoDial: boolean; prospectIds: string[]; taskIds: string[] }) => void; last: Session | null }) {
  const [repMode, setRepMode] = useState<'browser' | 'phone'>(softphone ? 'browser' : 'phone');
  const [repPhone, setRepPhone] = useState(loadRepPhone());
  const [from, setFrom] = useState(fromNumbers[0] ?? '');
  const [lines, setLines] = useState(String(maxLines));
  const [autoDial, setAutoDial] = useState(false);
  const [picked, setPicked] = useState<Map<string, { name: string; phone: string | null; taskId?: string }>>(new Map());
  const [search, setSearch] = useState('');
  const today = useMemo(() => new Date(Date.now() + 86_400_000).toISOString(), []);
  const tasks = useApi<{ data: any[] }>(`/v1/tasks${q({ 'filter[completed]': 'false', 'filter[dueAt][lte]': today, include: 'prospect', 'page[size]': 100 })}`);
  const all = useApi<{ data: any[] }>(`/v1/prospects${q({ 'page[size]': 100 })}`);
  const found = useMemo(() => (search.length >= 2 ? { data: (all.data?.data ?? []).filter((p) => `${p.name ?? ''} ${p.title ?? ''} ${p.phone ?? ''}`.toLowerCase().includes(search.toLowerCase())).slice(0, 20) } : null), [search, all.data]);
  const callTasks = (tasks.data?.data ?? []).filter((t) => t.action === 'call' || t.action === 'manual_call');
  useEffect(() => {
    if (!from && fromNumbers[0]) setFrom(fromNumbers[0]);
  }, [fromNumbers]);
  const toggle = (id: string, v: { name: string; phone: string | null; taskId?: string }) =>
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
    onStart({ repMode, repPhone: repMode === 'phone' ? repPhone : undefined, fromNumber: from || undefined, maxLines: Number(lines), autoDial, prospectIds, taskIds });
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Card data-testid="pd-setup">
        <CardHeader>
          <CardTitle>Your line</CardTitle>
          <CardDescription>You join first and wait in silence. Nothing is dialed until you press Dial.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          <div className="grid gap-2">
            <Label>Join from</Label>
            <Select value={repMode} onValueChange={(v) => setRepMode(v as 'browser' | 'phone')}>
              <SelectTrigger data-testid="pd-rep-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="browser" disabled={!softphone}>
                  This browser{softphone ? '' : ' (needs API key + TwiML app)'}
                </SelectItem>
                <SelectItem value="phone">My phone (Twilio rings me first)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {repMode === 'phone' && (
            <div className="grid gap-2">
              <Label>Your phone</Label>
              <Input value={repPhone} onChange={(e) => setRepPhone(e.target.value)} placeholder="+1 555 999 8888" data-testid="pd-rep-phone" />
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Caller id</Label>
              <Select value={from} onValueChange={setFrom}>
                <SelectTrigger>
                  <SelectValue placeholder="number" />
                </SelectTrigger>
                <SelectContent>
                  {fromNumbers.map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Lines at once</Label>
              <Select value={lines} onValueChange={setLines}>
                <SelectTrigger data-testid="pd-lines">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: maxAllowed }, (_, i) => String(i + 1)).map((n) => (
                    <SelectItem key={n} value={n}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div>
              <div className="text-sm font-medium">Auto-dial</div>
              <div className="text-xs text-muted-foreground">Ring the next batch when nobody answers</div>
            </div>
            <Switch checked={autoDial} onCheckedChange={setAutoDial} />
          </div>
          <Button onClick={start} disabled={busy || (repMode === 'phone' && !repPhone) || !from} data-testid="pd-start">
            <PhoneForwarded className="size-4" /> Join and queue {picked.size ? `${picked.size} ` : ''}prospects
          </Button>
          {last?.status === 'ended' && <SessionSummary s={last} />}
        </CardContent>
      </Card>
      <Card className="min-w-0" data-testid="pd-pick">
        <CardHeader>
          <CardTitle>Who to call</CardTitle>
          <CardDescription>Call tasks due today are listed first. Prospects without a phone, on the do-not-call list or outside 08:00–21:00 their time are skipped automatically.</CardDescription>
        </CardHeader>
        <CardContent className="grid min-w-0 gap-3">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setPicked(new Map(callTasks.filter((t) => t.prospect?.id).map((t) => [t.prospect.id, { name: t.prospect.name, phone: t.prospect.phone, taskId: t.id }])))} disabled={!callTasks.length} data-testid="pd-pick-all-tasks">
              Select all {callTasks.length} call tasks
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setPicked(new Map())} disabled={!picked.size}>
              Clear
            </Button>
          </div>
          {callTasks.length > 0 && (
            <ul className="grid min-w-0 gap-1" data-testid="pd-task-list">
              {callTasks.map((t) => (
                <PickRow key={t.id} checked={picked.has(t.prospect?.id)} onToggle={() => t.prospect?.id && toggle(t.prospect.id, { name: t.prospect.name, phone: t.prospect.phone, taskId: t.id })} name={t.prospect?.name ?? 'Unknown'} sub={[t.prospect?.phone ?? 'no phone', t.note].filter(Boolean).join(' · ')} tag={t.sequence?.name ?? 'task'} />
              ))}
            </ul>
          )}
          <div className="grid gap-2">
            <Label>Add any prospect</Label>
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name" data-testid="pd-search" />
          </div>
          {found?.data && (
            <ul className="grid min-w-0 gap-1">
              {found.data.map((p: any) => (
                <PickRow key={p.id} checked={picked.has(p.id)} onToggle={() => toggle(p.id, { name: p.name, phone: p.phone })} name={p.name} sub={[p.title, p.phone ?? 'no phone'].filter(Boolean).join(' · ')} />
              ))}
              {found.data.length === 0 && <li className="text-sm text-muted-foreground">No prospects match.</li>}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function PickRow({ checked, onToggle, name, sub, tag }: { checked: boolean; onToggle: () => void; name: string; sub: string; tag?: string }) {
  return (
    <li className="min-w-0 overflow-hidden">
      <button type="button" onClick={onToggle} className={cn('flex w-full min-w-0 items-center justify-between gap-3 overflow-hidden rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent', checked && 'border-primary bg-primary/5')} data-testid="pd-pick-row" aria-pressed={checked}>
        <span className="min-w-0">
          <span className="block truncate font-medium">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">{sub}</span>
        </span>
        {tag && (
          <Badge variant="outline" className="shrink-0">
            {tag}
          </Badge>
        )}
      </button>
    </li>
  );
}

/* ------------------------------------------------------------------- live */

function Live({ session: s, busy, joinedBrowser, onRejoin, onDial, onHangup, onQueue, onToggleAuto, onLogged }: { session: Session; busy: boolean; joinedBrowser: boolean; onRejoin: () => void; onDial: (lines?: number) => void; onHangup: () => void; onQueue: (ids: string[]) => void; onToggleAuto: (v: boolean) => void; onLogged: () => void }) {
  const batch = s.lines.filter((l) => l.batch === s.batch && l.batch > 0);
  const queued = s.lines.filter((l) => l.status === 'queued');
  const skipped = s.lines.filter((l) => l.status === 'skipped');
  const connected = s.connectedLineId ? s.lines.find((l) => l.id === s.connectedLineId) : null;
  const history = s.lines.filter((l) => l.batch > 0 && l.batch < s.batch && !LIVE.has(l.status));
  const canDial = (s.status === 'ready' || s.status === 'wrapping') && queued.length > 0;
  const [search, setSearch] = useState('');
  const all = useApi<{ data: any[] }>(`/v1/prospects${q({ 'page[size]': 100 })}`);
  const found = useMemo(() => (search.length >= 2 ? { data: (all.data?.data ?? []).filter((p) => `${p.name ?? ''} ${p.phone ?? ''}`.toLowerCase().includes(search.toLowerCase())).slice(0, 8) } : null), [search, all.data]);
  return (
    <div className="grid gap-4">
      {s.status === 'waiting_rep' && (
        <Card data-testid="pd-waiting">
          <CardContent className="flex items-center justify-between gap-3 pt-6">
            <div className="text-sm">{s.repMode === 'phone' ? `Ringing ${s.repPhone}. Pick up to join the room.` : joinedBrowser ? 'Connecting your browser to the room…' : 'Your browser is not in the room.'}</div>
            {s.repMode === 'browser' && !joinedBrowser && (
              <Button size="sm" onClick={onRejoin}>
                <Phone className="size-4" /> Join from this browser
              </Button>
            )}
          </CardContent>
        </Card>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => onDial()} disabled={busy || !canDial} data-testid="pd-dial">
          <PhoneCall className="size-4" /> {s.status === 'dialing' ? 'Dialing…' : `Dial next ${Math.min(s.maxLines, queued.length) || ''}`}
        </Button>
        {connected && (
          <Button variant="destructive" onClick={onHangup} disabled={busy} data-testid="pd-hangup">
            <PhoneOff className="size-4" /> Hang up
          </Button>
        )}
        <div className="ml-auto flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Auto-dial</span>
          <Switch checked={s.autoDial} onCheckedChange={onToggleAuto} data-testid="pd-auto" />
        </div>
      </div>
      {connected && <ConnectedPanel line={connected} session={s} onLogged={onLogged} />}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="pd-lines">
        {batch.length === 0 && <Empty>No lines ringing. {queued.length ? `${queued.length} queued.` : 'Queue is empty.'}</Empty>}
        {batch.map((l) => (
          <LineCard key={l.id} line={l} winner={l.id === s.connectedLineId} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Up next ({queued.length})</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2">
            {queued.slice(0, 12).map((l) => (
              <div key={l.id} className="flex items-center justify-between text-sm">
                <span className="truncate">{l.prospect?.name ?? l.to}</span>
                <span className="text-xs text-muted-foreground">{l.to}</span>
              </div>
            ))}
            {queued.length > 12 && <div className="text-xs text-muted-foreground">and {queued.length - 12} more</div>}
            <div className="grid gap-2 pt-2">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Add a prospect by name" data-testid="pd-live-search" />
              {found?.data.map((p: any) => (
                <Button key={p.id} size="sm" variant="outline" className="justify-between" onClick={() => (onQueue([p.id]), setSearch(''))}>
                  <span className="truncate">{p.name}</span>
                  <span className="text-xs text-muted-foreground">{p.phone ?? 'no phone'}</span>
                </Button>
              ))}
            </div>
            {skipped.length > 0 && (
              <details className="pt-2 text-xs text-muted-foreground">
                <summary>{skipped.length} skipped</summary>
                <ul className="mt-1 grid gap-1">
                  {skipped.map((l) => (
                    <li key={l.id}>
                      {l.prospect?.name ?? l.to}: {SKIP_LABEL[l.skipReason ?? ''] ?? l.skipReason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">This session</CardTitle>
            <CardDescription>
              {s.stats.dialed ?? 0} dialed · {s.stats.connected ?? 0} conversations · {s.stats.voicemail ?? 0} voicemail · {s.stats.noAnswer ?? 0} no answer · {s.stats.dropped ?? 0} dropped
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2">
            {history.length === 0 && <div className="text-sm text-muted-foreground">Nothing yet.</div>}
            {history
              .slice()
              .reverse()
              .slice(0, 20)
              .map((l) => (
                <div key={l.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{l.prospect?.name ?? l.to}</span>
                  <span className="flex items-center gap-2">
                    {l.callId && (l.status === 'completed' || l.status === 'dropped') && (
                      <Link to={`/calls/${l.callId}`} className="text-xs underline">
                        call
                      </Link>
                    )}
                    <LineBadge status={l.status} />
                  </span>
                </div>
              ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

const SKIP_LABEL: Record<string, string> = { no_phone: 'no phone number', do_not_call: 'on the do-not-call list', quiet_hours: 'outside 08:00–21:00 their time', duplicate: 'already in this session', session_ended: 'session ended' };

function LineBadge({ status }: { status: string }) {
  const tone = status === 'connected' || status === 'completed' ? 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-300' : status === 'ringing' || status === 'dialing' || status === 'answered' ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300' : status === 'dropped' ? 'bg-destructive/15 text-destructive' : 'text-muted-foreground';
  return <span className={cn('inline-flex items-center rounded-full border border-transparent px-2 py-0.5 text-xs font-medium', tone)}>{LINE_LABEL[status] ?? status}</span>;
}

function LineCard({ line: l, winner }: { line: Line; winner: boolean }) {
  const live = LIVE.has(l.status);
  return (
    <Card className={cn('min-w-0', winner && 'border-emerald-600', live && !winner && 'border-sky-500/50')} data-testid="pd-line" data-status={l.status}>
      <CardContent className="grid gap-1 pt-5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate font-medium">{l.prospect?.name ?? l.to}</div>
            <div className="truncate text-xs text-muted-foreground">{[l.prospect?.title, l.prospect?.account].filter(Boolean).join(' · ') || '\u00a0'}</div>
          </div>
          <LineBadge status={l.status} />
        </div>
        <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
          <span>{l.to}</span>
          <Timer from={l.status === 'connected' ? l.connectedAt : null} fixed={l.durationSeconds} />
        </div>
        {l.status === 'dropped' && l.callbackTaskId && <div className="text-xs text-destructive">Callback task created.</div>}
      </CardContent>
    </Card>
  );
}

function Timer({ from, fixed }: { from: string | null | undefined; fixed: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!from) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [from]);
  if (from) return <span className="tabular-nums">{fmtDuration((Date.now() - new Date(from).getTime()) / 1000)}</span>;
  if (fixed) return <span className="tabular-nums">{fmtDuration(fixed)}</span>;
  return null;
}

function ConnectedPanel({ line, session, onLogged }: { line: Line; session: Session; onLogged: () => void }) {
  const [outcome, setOutcome] = useState('connected');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [logged, setLogged] = useState<string | null>(null);
  useEffect(() => {
    setOutcome('connected');
    setNotes('');
    setLogged(null);
  }, [line.id]);
  const log = async () => {
    if (!line.callId) return;
    setBusy(true);
    try {
      await api(`/v1/calls/${line.callId}/actions/log`, { method: 'POST', json: { data: { outcome, notes: notes || undefined } } });
      setLogged(line.id);
      toast('Call logged');
      onLogged();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const ended = line.status !== 'connected';
  return (
    <Card className="border-emerald-600" data-testid="pd-connected">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PhoneCall className="size-4 text-emerald-600" /> {ended ? 'Call ended' : 'Live'}: {line.prospect?.name ?? line.to}
          {!ended && (
            <Badge variant="secondary" className="ml-auto">
              <Timer from={line.connectedAt} fixed={null} />
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          {[line.prospect?.title, line.prospect?.account].filter(Boolean).join(' · ')}
          {line.prospect?.id && (
            <>
              {' · '}
              <Link to={`/prospects/${line.prospect.id}`} className="underline">
                open prospect
              </Link>
            </>
          )}
          {session.status === 'wrapping' && ' · log the call, then dial the next batch'}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-[200px_minmax(0,1fr)_auto]">
        <div className="grid gap-2">
          <Label>Outcome</Label>
          <Select value={outcome} onValueChange={setOutcome}>
            <SelectTrigger data-testid="pd-outcome">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {OUTCOMES.map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label>Notes</Label>
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What happened, next step" data-testid="pd-notes" />
        </div>
        <div className="flex items-end">
          <Button onClick={log} disabled={busy || logged === line.id || !line.callId} data-testid="pd-log">
            {logged === line.id ? 'Logged' : 'Log call'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SessionSummary({ s }: { s: Session }) {
  return (
    <div className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground" data-testid="pd-summary">
      Last session: {s.stats.dialed ?? 0} dialed, {s.stats.connected ?? 0} conversations, {s.stats.voicemail ?? 0} voicemail, {s.stats.dropped ?? 0} dropped{s.endReason ? ` · ${s.endReason.replace(/_/g, ' ')}` : ''}.
    </div>
  );
}
