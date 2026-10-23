import { useState } from 'react';
import { Phone, ExternalLink, MessageSquare, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { api, currentSession, fmtDate, q } from '../api.js';
import { useApi, toast } from '../hooks.js';
import { Link, navigate } from '../router.js';
import { Empty, PageHeader, StateBadge } from '../components/layout.js';
import { AiCallDialog, DialDialog, LogCallDialog } from '../components/dialer.jsx';
import { fmtDuration } from '../dialer.js';
import { ComposeMessageDialog, InboxItemRow } from './Inbox.js';

export function Prospects() {
  const [search, setSearch] = useState('');
  const [after, setAfter] = useState<string | undefined>();
  const path = `/v1/prospects${q({ 'filter[primaryEmail]': search.includes('@') ? search : undefined, 'filter[name]': search && !search.includes('@') ? search : undefined, 'page[size]': 50, 'page[after]': after, include: 'sequenceStates' })}`;
  const { data, error, loading, reload } = useApi<{ data: any[]; links: any }>(path, [search, after]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', title: '', primaryEmail: '', phone: '', accountName: '' });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let accountId: string | undefined;
      if (form.accountName) {
        const found = await api<{ data: any[] }>(`/v1/accounts${q({ 'filter[name]': form.accountName })}`);
        accountId = found.data[0]?.id ?? (await api('/v1/accounts', { method: 'POST', json: { data: { name: form.accountName } } })).data.id;
      }
      await api('/v1/prospects', { method: 'POST', json: { data: { firstName: form.firstName, lastName: form.lastName || undefined, title: form.title || undefined, primaryEmail: form.primaryEmail || undefined, phone: form.phone || undefined, account: accountId ? { id: accountId } : undefined } } });
      setForm({ firstName: '', lastName: '', title: '', primaryEmail: '', phone: '', accountName: '' });
      setOpen(false);
      toast('Prospect created');
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Prospects"
        description="People you are reaching out to, with their enrollments."
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
              <Input className="w-64 pl-8" placeholder="Exact name or email" value={search} onChange={(e) => (setAfter(undefined), setSearch(e.target.value))} />
            </div>
            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button data-testid="add-prospect">Add prospect</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>New prospect</DialogTitle>
                </DialogHeader>
                <form className="grid gap-3" onSubmit={create} id="prospect-form">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="grid gap-2">
                      <Label>First name</Label>
                      <Input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
                    </div>
                    <div className="grid gap-2">
                      <Label>Last name</Label>
                      <Input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <Label>Title</Label>
                    <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>Email</Label>
                    <Input type="email" value={form.primaryEmail} onChange={(e) => setForm({ ...form, primaryEmail: e.target.value })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>Phone</Label>
                    <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+1 555 010 2020" />
                  </div>
                  <div className="grid gap-2">
                    <Label>Company</Label>
                    <Input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
                  </div>
                </form>
                <DialogFooter>
                  <Button type="submit" form="prospect-form">
                    Create
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </>
        }
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && !data && <Skeleton className="h-48 w-full" />}
      {data && data.data.length === 0 && <Empty>No prospects match. Add one, import from HubSpot in Settings, or let your assistant create them over MCP.</Empty>}
      {data && data.data.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>Enrollments</TableHead>
                <TableHead className="text-right">Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((p) => (
                <TableRow key={p.id} className="cursor-pointer" onClick={() => navigate(`/prospects/${p.id}`)} data-testid="prospect-row">
                  <TableCell className="font-medium">{p.name ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{p.title}</TableCell>
                  <TableCell className="text-sm">{p.primaryEmail}</TableCell>
                  <TableCell className="space-x-1">
                    {p.sequenceStates.map((s: any) => (
                      <StateBadge key={s.id} state={s.state} />
                    ))}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{fmtDate(p.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {data && (data.links.next || after) && (
        <div className="mt-3 flex gap-2">
          {data.links.next && (
            <Button variant="outline" size="sm" onClick={() => setAfter(new URL(data.links.next, location.origin).searchParams.get('page[after]') ?? undefined)}>
              Next page
            </Button>
          )}
          {after && (
            <Button variant="ghost" size="sm" onClick={() => setAfter(undefined)}>
              First page
            </Button>
          )}
        </div>
      )}
    </>
  );
}

export function ProspectDetail({ id }: { id: string }) {
  const { data, error, reload } = useApi<{ data: any }>(`/v1/prospects/${id}?include=sequenceStates&includeCRMCustomFields=true`);
  const emails = useApi<{ data: any[] }>(`/v1/emails${q({ 'filter[prospect][id]': id, 'page[size]': 20 })}`);
  const tasks = useApi<{ data: any[] }>(`/v1/tasks${q({ 'filter[prospect][id]': id, 'page[size]': 20 })}`);
  const seqs = useApi<{ data: any[] }>('/v1/sequences?page[size]=100');
  const research = useApi<{ data: any }>(`/v1/prospects/${id}/research`);
  const [researching, setResearching] = useState(false);
  const [seqId, setSeqId] = useState('');
  const [dial, setDial] = useState(false);
  const [aiCall, setAiCall] = useState(false);
  const [logCall, setLogCall] = useState(false);
  const dialer = useApi<{ data: any }>('/v1/workspace/dialer');
  const callsList = useApi<{ data: any[] }>(`/v1/calls${q({ 'filter[prospect][id]': id, include: 'callDisposition,owner', 'page[size]': 20 })}`);
  const inbox = useApi<{ data: any[] }>(`/v1/prospects/${id}/inbox?limit=40`);
  const channels = useApi<{ data: any }>('/v1/workspace/channels/inkbox');
  const [compose, setCompose] = useState(false);
  const p = data?.data;
  const dp = dialer.data?.data;

  const enroll = async () => {
    const me = await api('/v1/me');
    const owner = me.data.userId ?? (await api('/v1/users?page[size]=1')).data[0]?.id;
    try {
      await api('/v1/sequenceStates', { method: 'POST', json: { data: { prospect: { id }, sequence: { id: seqId }, owner: { id: owner } } } });
      toast('Enrolled');
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const runResearch = async () => {
    setResearching(true);
    const prev = research.data?.data?.researchedAt;
    try {
      await api(`/v1/prospects/${id}/actions/research`, { method: 'POST', json: { data: { force: true } } });
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const now = await api(`/v1/prospects/${id}/research`);
        if (now.data.status === 'ready' && now.data.researchedAt !== prev) break;
      }
      research.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setResearching(false);
    }
  };
  const transition = async (stateId: string, verb: 'pause' | 'resume' | 'finish') => {
    await api(`/v1/sequenceStates/${stateId}/actions/${verb}`, { method: 'POST' });
    reload();
  };

  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!p) return <Skeleton className="h-48 w-full" />;
  const r = research.data?.data;
  return (
    <>
      <Link to="/prospects" className="text-sm text-muted-foreground hover:underline">
        ← Prospects
      </Link>
      <PageHeader
        title={p.name ?? p.primaryEmail}
        description={[p.title, p.primaryEmail, p.phone].filter(Boolean).join(' · ')}
        actions={
          <div className="flex gap-2">
            {channels.data?.data?.status === 'connected' && (
              <Button variant="outline" onClick={() => setCompose(true)} data-testid="prospect-message">
                <MessageSquare className="size-4" /> Message
              </Button>
            )}
            <Button variant="outline" onClick={() => setLogCall(true)} data-testid="prospect-log-call">
              Log a call
            </Button>
            {dp?.speko?.status === 'connected' && (
              <Button variant={dp.provider === 'speko' ? 'default' : 'outline'} onClick={() => setAiCall(true)} data-testid="prospect-ai-call">
                <Sparkles className="size-4" /> AI call
              </Button>
            )}
            {(dp?.twilio?.status === 'connected' || !dp) && (
              <Button variant={dp?.provider === 'speko' ? 'outline' : 'default'} onClick={() => setDial(true)} data-testid="prospect-call">
                <Phone className="size-4" /> Call
              </Button>
            )}
          </div>
        }
      />
      <DialDialog open={dial} onOpenChange={setDial} target={{ prospectId: p.id, name: p.name, phone: p.phone }} onLogged={() => { tasks.reload(); callsList.reload(); }} />
      <AiCallDialog open={aiCall} onOpenChange={setAiCall} target={{ prospectId: p.id, name: p.name, phone: p.phone }} onDone={() => { tasks.reload(); callsList.reload(); }} />
      <LogCallDialog open={logCall} onOpenChange={setLogCall} prospectId={p.id} onLogged={() => tasks.reload()} />
      <ComposeMessageDialog open={compose} onOpenChange={setCompose} prospectId={p.id} phone={p.phone} onSent={() => inbox.reload()} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Row k="Title" v={p.title} />
            <Row k="Email" v={p.primaryEmail} />
            <Row k="Phone" v={p.phone} />
            <Row k="LinkedIn" v={p.linkedInUrl ? <a className="inline-flex items-center gap-1 hover:underline" href={p.linkedInUrl} target="_blank" rel="noreferrer">profile <ExternalLink className="size-3" /></a> : null} />
            <Row k="CRM id" v={p.crmId} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Enrollments</CardTitle>
            <CardDescription>Sequences this prospect is in</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            {p.sequenceStates.length === 0 && <p className="text-sm text-muted-foreground">Not enrolled anywhere yet.</p>}
            {p.sequenceStates.map((s: any) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <Link to={`/sequences/${s.sequence.id}`} className="font-medium hover:underline">
                  {seqs.data?.data.find((x) => x.id === s.sequence.id)?.name ?? `Sequence ${s.sequence.id.slice(0, 8)}…`}
                </Link>
                <div className="flex items-center gap-1">
                  <StateBadge state={s.state} />
                  {s.state === 'active' && (
                    <Button size="sm" variant="outline" onClick={() => transition(s.id, 'pause')}>
                      Pause
                    </Button>
                  )}
                  {s.state === 'paused' && (
                    <Button size="sm" variant="outline" onClick={() => transition(s.id, 'resume')}>
                      Resume
                    </Button>
                  )}
                  {s.state !== 'finished' && (
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => transition(s.id, 'finish')}>
                      Finish
                    </Button>
                  )}
                </div>
              </div>
            ))}
            <div className="flex gap-2">
              <Select value={seqId} onValueChange={setSeqId}>
                <SelectTrigger className="flex-1">
                  <SelectValue placeholder="Enroll in a sequence…" />
                </SelectTrigger>
                <SelectContent>
                  {seqs.data?.data.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button disabled={!seqId} onClick={enroll}>
                Enroll
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4" data-testid="research-card">
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4" /> Research
            </CardTitle>
            <CardDescription>A web-grounded brief from the workspace AI provider, with sources.</CardDescription>
          </div>
          <Button variant={r?.status === 'ready' ? 'outline' : 'default'} disabled={researching} onClick={runResearch}>
            {researching ? 'Researching…' : r?.status === 'ready' ? 'Refresh' : 'Research this prospect'}
          </Button>
        </CardHeader>
        {r?.status === 'ready' && (
          <CardContent className="grid gap-3 text-sm">
            <p>{r.summary}</p>
            {r.talkingPoints?.length > 0 && (
              <ul className="list-disc space-y-1 pl-5">
                {r.talkingPoints.map((t: string, i: number) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            )}
            {r.signals?.length > 0 && (
              <div className="rounded-md border">
                <Table>
                  <TableBody>
                    {r.signals.map((sg: any) => (
                      <TableRow key={sg.id}>
                        <TableCell className="w-28">
                          <Badge variant="outline">{sg.kind}</Badge>
                        </TableCell>
                        <TableCell>{sg.text}</TableCell>
                        <TableCell className="w-28 text-xs text-muted-foreground">{sg.date ?? ''}</TableCell>
                        <TableCell className="w-20 text-right">{sg.sourceUrl && <a className="text-xs hover:underline" href={sg.sourceUrl} target="_blank" rel="noreferrer">source</a>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
            <div className="text-xs text-muted-foreground">
              confidence {Math.round((r.confidence ?? 0) * 100)}% · {fmtDate(r.researchedAt)} · {r.source}
              {r.citations?.length > 0 && (
                <>
                  {' '}
                  · sources:{' '}
                  {r.citations.map((c: any, i: number) => (
                    <a key={i} href={c.url} target="_blank" rel="noreferrer" className="mr-1 hover:underline">
                      {new URL(c.url).hostname}
                    </a>
                  ))}
                </>
              )}
            </div>
          </CardContent>
        )}
      </Card>

      <Card className="mt-4" data-testid="calls-timeline">
        <CardHeader>
          <CardTitle className="text-base">Calls</CardTitle>
          <CardDescription>Dialer and AI calls with outcome, summary, transcript and recording.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          {callsList.data?.data.length === 0 && <p className="text-muted-foreground">No calls yet.</p>}
          {callsList.data?.data.map((c) => (
            <CallTimelineItem key={c.id} c={c} />
          ))}
        </CardContent>
      </Card>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card data-testid="prospect-inbox">
          <CardHeader>
            <CardTitle className="text-base">Inbox</CardTitle>
            <CardDescription>Email, texts, iMessages and calls with this prospect, newest first.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {inbox.data?.data.length === 0 && <p className="text-muted-foreground">Nothing yet.</p>}
            {inbox.data?.data.map((it) => (
              <InboxItemRow key={`${it.kind}-${it.id}`} it={it} />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tasks</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {tasks.data?.data.length === 0 && <p className="text-muted-foreground">None yet.</p>}
            {tasks.data?.data.map((t) => (
              <div key={t.id} className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Badge variant="outline">{t.action.replace(/_/g, ' ')}</Badge>
                  <div className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">{t.note}</div>
                </div>
                <div className="text-right text-xs text-muted-foreground">
                  {fmtDate(t.dueAt)}
                  <div>
                    <StateBadge state={t.status} />
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

const OUTCOME: Record<string, string> = { answered: 'Answered', voicemail: 'Voicemail', no_answer: 'No answer', failed: 'Failed' };

function CallTimelineItem({ c }: { c: any }) {
  const [open, setOpen] = useState(false);
  const [tx, setTx] = useState<any | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  const expand = async () => {
    setOpen(!open);
    if (!tx) setTx((await api(`/v1/calls/${c.id}/transcript`).catch(() => ({ data: null }))).data);
  };
  const play = async () => {
    const s = currentSession();
    const r = await fetch(`/v1/calls/${c.id}/recording`, { headers: { authorization: `Bearer ${s?.access_token}` } });
    if (!r.ok) return toast('Recording not available', 'error');
    setAudio(URL.createObjectURL(await r.blob()));
  };
  const live = ['initiated', 'queued', 'ringing', 'in_progress'].includes(c.status);
  return (
    <div className="rounded-lg border p-3" data-testid="call-item">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {c.mode === 'ai' ? <Sparkles className="size-4 text-muted-foreground" /> : <Phone className="size-4 text-muted-foreground" />}
          <span className="font-medium">{c.mode === 'ai' ? 'AI call' : c.mode === 'manual' ? 'Logged call' : 'Call'}</span>
          <Badge variant={live ? 'default' : 'secondary'} data-testid="call-item-outcome">{c.outcome ? OUTCOME[c.outcome] ?? c.outcome : c.callDisposition?.name ?? c.status.replace(/_/g, ' ')}</Badge>
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtDate(c.time)} · {fmtDuration(c.duration)}
          {c.costUsd !== null && c.costUsd !== undefined ? ` · $${Number(c.costUsd).toFixed(2)}` : ''} {c.owner?.name ? `· ${c.owner.name}` : ''}
        </div>
      </div>
      {c.summary && <p className="mt-2 text-sm">{c.summary}</p>}
      {!c.summary && c.notes && <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">{c.notes}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        {(c.transcriptStatus === 'ready' || c.mode === 'ai') && !live && (
          <Button size="sm" variant="outline" onClick={expand} data-testid="call-item-transcript">
            {open ? 'Hide transcript' : 'Transcript'}
          </Button>
        )}
        {c.recordingUrl && !audio && (
          <Button size="sm" variant="outline" onClick={play} data-testid="call-item-play">
            Play recording
          </Button>
        )}
        <Link to={`/calls/${c.id}`} className="self-center text-xs text-muted-foreground hover:underline">
          details →
        </Link>
      </div>
      {audio && <audio controls src={audio} className="mt-2 w-full" />}
      {open && tx && (
        <div className="mt-2 grid max-h-64 gap-1 overflow-y-auto border-t pt-2 text-sm" data-testid="call-item-transcript-body">
          {tx.transcript?.length === 0 && <p className="text-muted-foreground">No transcript.</p>}
          {tx.transcript?.map((e: any, k: number) => (
            <div key={k} className={`flex gap-2 ${e.role === 'agent' ? '' : 'text-muted-foreground'}`}>
              <span className="w-16 shrink-0 font-medium">{e.role === 'agent' ? (c.mode === 'ai' ? 'Agent' : 'Rep') : e.role === 'user' ? 'Prospect' : 'System'}</span>
              <span>{e.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v || '—'}</span>
    </div>
  );
}
