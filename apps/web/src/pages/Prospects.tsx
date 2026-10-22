import { useState } from 'react';
import { ExternalLink, Search, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { api, fmtDate, q } from '../api.js';
import { useApi, toast } from '../hooks.js';
import { Link, navigate } from '../router.js';
import { Empty, PageHeader, StateBadge } from '../components/layout.js';

export function Prospects() {
  const [search, setSearch] = useState('');
  const [after, setAfter] = useState<string | undefined>();
  const path = `/v1/prospects${q({ 'filter[primaryEmail]': search.includes('@') ? search : undefined, 'filter[name]': search && !search.includes('@') ? search : undefined, 'page[size]': 50, 'page[after]': after, include: 'sequenceStates' })}`;
  const { data, error, loading, reload } = useApi<{ data: any[]; links: any }>(path, [search, after]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', title: '', primaryEmail: '', accountName: '' });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      let accountId: string | undefined;
      if (form.accountName) {
        const found = await api<{ data: any[] }>(`/v1/accounts${q({ 'filter[name]': form.accountName })}`);
        accountId = found.data[0]?.id ?? (await api('/v1/accounts', { method: 'POST', json: { data: { name: form.accountName } } })).data.id;
      }
      await api('/v1/prospects', { method: 'POST', json: { data: { firstName: form.firstName, lastName: form.lastName || undefined, title: form.title || undefined, primaryEmail: form.primaryEmail || undefined, account: accountId ? { id: accountId } : undefined } } });
      setForm({ firstName: '', lastName: '', title: '', primaryEmail: '', accountName: '' });
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
  const p = data?.data;

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
      <PageHeader title={p.name ?? p.primaryEmail} description={[p.title, p.primaryEmail].filter(Boolean).join(' · ')} />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profile</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            <Row k="Title" v={p.title} />
            <Row k="Email" v={p.primaryEmail} />
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

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Emails</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm">
            {emails.data?.data.length === 0 && <p className="text-muted-foreground">None yet.</p>}
            {emails.data?.data.map((e) => (
              <div key={e.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate">{e.subject || '(no subject)'}</div>
                  <div className="text-xs text-muted-foreground">
                    {fmtDate(e.date ?? e.createdAt)} {e.openCount ? `· ${e.openCount} opens` : ''} {e.clickCount ? `· ${e.clickCount} clicks` : ''} {e.repliedAt ? '· replied' : ''}
                  </div>
                </div>
                <StateBadge state={e.status} />
              </div>
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

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{k}</span>
      <span className="text-right">{v || '—'}</span>
    </div>
  );
}
