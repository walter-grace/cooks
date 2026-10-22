import { useState } from 'react';
import { ExternalLink, Radar } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, fmtDate, q } from '../api.js';
import { toast, useApi } from '../hooks.js';
import { Link } from '../router.js';
import { Empty, PageHeader } from '../components/layout.js';

const KIND_TONE: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = { email: 'secondary', research: 'default', crm: 'outline', web: 'outline', intent: 'outline', custom: 'outline' };
export const kindLabel = (k: string) => k.replace(/^[a-z]+\./, '').replace(/_/g, ' ');

export function Signals() {
  const [status, setStatus] = useState('new');
  const [kind, setKind] = useState('all');
  const summary = useApi<{ data: any }>('/v1/signals/summary?days=14');
  const list = useApi<{ data: any[] }>(`/v1/signals${q({ 'filter[status]': status, 'filter[kind]': kind === 'all' ? undefined : kind, include: 'prospect,account', 'page[size]': 100 })}`, [status, kind]);
  const seqs = useApi<{ data: any[] }>('/v1/sequences?page[size]=100');
  const users = useApi<{ data: any[] }>('/v1/users?page[size]=100');
  const [act, setAct] = useState<{ signal: any; action: 'enroll' | 'task' } | null>(null);
  const [seqId, setSeqId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [note, setNote] = useState('');
  const [scanDomain, setScanDomain] = useState('');

  const reload = () => {
    list.reload();
    summary.reload();
  };
  const dismiss = async (id: string) => {
    await api(`/v1/signals/${id}/actions/dismiss`, { method: 'POST' });
    toast('Dismissed', 'info');
    reload();
  };
  const submitAct = async () => {
    if (!act) return;
    try {
      const data = act.action === 'enroll' ? { action: 'enroll', sequenceId: seqId, ownerId } : { action: 'task', ownerId, note: note || undefined };
      const r = await api(`/v1/signals/${act.signal.id}/actions/act`, { method: 'POST', json: { data } });
      toast(act.action === 'enroll' ? (r.data.enrolled ? 'Enrolled' : `Not enrolled: ${r.data.reason}`) : 'Task created', r.data.enrolled === false ? 'info' : 'success');
      setAct(null);
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const scan = async (accountId: string) => {
    try {
      await api(`/v1/accounts/${accountId}/actions/scan`, { method: 'POST', json: { data: {} } });
      toast('Scan queued. New findings appear here in about a minute.', 'info');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  const scanByDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api(`/v1/accounts${q({ 'filter[domain]': scanDomain.trim(), 'page[size]': 1 })}`);
      const a = r.data[0];
      if (!a) return toast(`No account with domain ${scanDomain}. Create it under Prospects first.`, 'error');
      await scan(a.id);
      setScanDomain('');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const s = summary.data?.data;
  const kinds = Object.keys(s?.byKind ?? {}).sort();
  return (
    <>
      <PageHeader
        title="Signals"
        description="Buying signals from email engagement, web research, your CRM and anything your bot pushes in."
        actions={
          <form className="flex gap-2" onSubmit={scanByDomain}>
            <Input className="w-48" placeholder="Scan account by domain" value={scanDomain} onChange={(e) => setScanDomain(e.target.value)} data-testid="scan-domain" />
            <Button type="submit" variant="outline">
              <Radar className="size-4" /> Scan
            </Button>
          </form>
        }
      />
      {s && (
        <div className="mb-4 flex flex-wrap gap-2" data-testid="signal-summary">
          <Badge variant="secondary">{s.new} new</Badge>
          <Badge variant="outline">{s.total} in {s.days} days</Badge>
          {kinds.slice(0, 8).map((k) => (
            <button key={k} className="rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent" onClick={() => setKind(kind === k ? 'all' : k)}>
              {kindLabel(k)} · {s.byKind[k]}
            </button>
          ))}
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs value={status} onValueChange={setStatus}>
          <TabsList>
            <TabsTrigger value="new">New</TabsTrigger>
            <TabsTrigger value="acted">Acted</TabsTrigger>
            <TabsTrigger value="dismissed">Dismissed</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger className="w-56" data-testid="signal-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {['email.*', 'research.*', 'crm.*', 'web.*', 'intent.*', 'custom.*'].map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
            {Object.keys(s?.catalog ?? {}).map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {list.error && <p className="text-sm text-destructive">{list.error}</p>}
      {list.loading && !list.data && <Skeleton className="h-40 w-full" />}
      {list.data && list.data.data.length === 0 && (
        <Empty>
          Nothing here yet. Signals arrive from opens, clicks and replies, from research and account scans, and from <code>POST /v1/signals</code> (or the <code>cooks_push_signal</code> tool).
        </Empty>
      )}
      {list.data && list.data.data.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Signal</TableHead>
                <TableHead>Who</TableHead>
                <TableHead className="text-right">Score</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.data.map((g) => (
                <TableRow key={g.id} data-testid="signal-row">
                  <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtDate(g.occurredAt)}</TableCell>
                  <TableCell className="max-w-xl whitespace-normal">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={KIND_TONE[g.kind.split('.')[0]] ?? 'outline'}>{kindLabel(g.kind)}</Badge>
                      <span className="line-clamp-2">{g.title ?? g.kind}</span>
                      {g.url && (
                        <a href={g.url} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground" aria-label="Source">
                          <ExternalLink className="size-3.5" />
                        </a>
                      )}
                      {g.status !== 'new' && (
                        <Badge variant="outline" className="text-xs">
                          {g.status}
                          {g.actedAction ? ` · ${g.actedAction}` : ''}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {g.prospect?.name ? (
                      <Link to={`/prospects/${g.prospect.id}`} className="font-medium hover:underline">
                        {g.prospect.name}
                      </Link>
                    ) : null}
                    {g.account?.name ? <div className="text-xs text-muted-foreground">{g.account.name}</div> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{g.score === null ? '' : Math.round(g.score * 100)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {g.account?.id && (
                        <Button size="sm" variant="ghost" onClick={() => scan(g.account.id)} aria-label="Scan account">
                          <Radar className="size-4" />
                        </Button>
                      )}
                      {g.status === 'new' && (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setAct({ signal: g, action: 'enroll' });
                              setOwnerId(users.data?.data[0]?.id ?? '');
                            }}
                            data-testid="signal-enroll"
                          >
                            Enroll
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setAct({ signal: g, action: 'task' });
                              setOwnerId(users.data?.data[0]?.id ?? '');
                            }}
                          >
                            Task
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => dismiss(g.id)} data-testid="signal-dismiss">
                            Dismiss
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={!!act} onOpenChange={(o) => !o && setAct(null)}>
        <DialogContent className="sm:max-w-md" data-testid="signal-act-dialog">
          <DialogHeader>
            <DialogTitle>{act?.action === 'enroll' ? 'Enroll from signal' : 'Create a task'}</DialogTitle>
            <DialogDescription>{act?.signal.title ?? act?.signal.kind}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {act?.action === 'enroll' && (
              <div className="grid gap-2">
                <Label>Sequence</Label>
                <Select value={seqId} onValueChange={setSeqId}>
                  <SelectTrigger data-testid="signal-sequence">
                    <SelectValue placeholder="choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {seqs.data?.data.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-2">
              <Label>Owner</Label>
              <Select value={ownerId} onValueChange={setOwnerId}>
                <SelectTrigger>
                  <SelectValue placeholder="choose…" />
                </SelectTrigger>
                <SelectContent>
                  {users.data?.data.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {act?.action === 'task' && (
              <div className="grid gap-2">
                <Label>Note</Label>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="defaults to the signal" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button onClick={submitAct} disabled={!ownerId || (act?.action === 'enroll' && !seqId)} data-testid="signal-act-submit">
              {act?.action === 'enroll' ? 'Enroll' : 'Create task'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Settings → Signals: rules. */
export function SignalRules({ isAdmin }: { isAdmin: boolean }) {
  const rules = useApi<{ data: any[] }>('/v1/workspace/signalRules');
  const seqs = useApi<{ data: any[] }>('/v1/sequences?page[size]=100');
  const users = useApi<{ data: any[] }>('/v1/users?page[size]=100');
  const [form, setForm] = useState({ kindPattern: 'research.*', minScore: '', action: 'task', sequenceId: '', ownerId: '', taskNote: '' });
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/workspace/signalRules', { method: 'POST', json: { data: { kindPattern: form.kindPattern, minScore: form.minScore === '' ? undefined : Number(form.minScore), action: form.action, sequenceId: form.action === 'enroll' ? form.sequenceId : undefined, ownerId: form.ownerId, taskNote: form.taskNote || undefined } } });
      toast('Rule added');
      rules.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  return (
    <Card className="mt-2">
      <CardHeader>
        <CardTitle>Signal rules</CardTitle>
        <CardDescription>When a new signal matches, enroll the prospect or create a task. Patterns: an exact kind, a prefix like research.*, or * for everything.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {rules.data && rules.data.data.length > 0 && (
          <Table>
            <TableBody>
              {rules.data.data.map((r) => (
                <TableRow key={r.id} data-testid="signal-rule-row">
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{r.kindPattern}</Badge>
                    {r.minScore !== null && <span className="ml-2 text-xs text-muted-foreground">score ≥ {Math.round(r.minScore * 100)}</span>}
                  </TableCell>
                  <TableCell className="text-sm">
                    → {r.action}
                    {r.sequenceName ? ` into ${r.sequenceName}` : ''}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    fired {r.firedCount}×{r.lastFiredAt ? `, last ${fmtDate(r.lastFiredAt)}` : ''}
                  </TableCell>
                  <TableCell className="text-right">
                    {isAdmin && (
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => api(`/v1/workspace/signalRules/${r.id}`, { method: 'DELETE' }).then(rules.reload)}>
                        Remove
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {isAdmin && (
          <form className="grid gap-3 md:grid-cols-6 md:items-end" onSubmit={add} data-testid="signal-rule-form">
            <div className="grid gap-2">
              <Label>Kind pattern</Label>
              <Input value={form.kindPattern} onChange={(e) => setForm({ ...form, kindPattern: e.target.value })} data-testid="rule-kind" />
            </div>
            <div className="grid gap-2">
              <Label>Min score (0-1)</Label>
              <Input type="number" min={0} max={1} step={0.05} value={form.minScore} onChange={(e) => setForm({ ...form, minScore: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>Action</Label>
              <Select value={form.action} onValueChange={(v) => setForm({ ...form, action: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="task">Create task</SelectItem>
                  <SelectItem value="enroll">Enroll</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.action === 'enroll' ? (
              <div className="grid gap-2">
                <Label>Sequence</Label>
                <Select value={form.sequenceId} onValueChange={(v) => setForm({ ...form, sequenceId: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="choose…" />
                  </SelectTrigger>
                  <SelectContent>
                    {seqs.data?.data.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div className="grid gap-2">
                <Label>Task note</Label>
                <Input value={form.taskNote} onChange={(e) => setForm({ ...form, taskNote: e.target.value })} placeholder="optional" />
              </div>
            )}
            <div className="grid gap-2">
              <Label>Owner</Label>
              <Select value={form.ownerId} onValueChange={(v) => setForm({ ...form, ownerId: v })}>
                <SelectTrigger data-testid="rule-owner-select">
                  <SelectValue placeholder="choose…" />
                </SelectTrigger>
                <SelectContent>
                  {users.data?.data.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!form.ownerId || (form.action === 'enroll' && !form.sequenceId)} data-testid="rule-add">
              Add rule
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
