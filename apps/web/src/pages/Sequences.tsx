import { useState } from 'react';
import { ArrowDown, ArrowUp, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { api, fmtDate, q } from '../api.js';
import { useApi, toast } from '../hooks.js';
import { Link, navigate } from '../router.js';
import { Empty, PageHeader, StateBadge } from '../components/layout.js';

const ACTIONS = ['auto_email', 'manual_email', 'call', 'manual_email_reply', 'auto_email_reply', 'basic_task', 'linkedin_connection_request', 'manual_linkedin_message', 'manual_sms', 'auto_sms', 'manual_imessage', 'auto_imessage', 'auto_ai_call', 'manual_whatsapp'];
const BODY_ACTIONS = new Set(['auto_sms', 'auto_imessage', 'auto_ai_call', 'manual_sms', 'manual_imessage']);
const BODY_LABEL: Record<string, string> = { auto_sms: 'Text message (sent automatically through Inkbox)', auto_imessage: 'iMessage (sent automatically through Inkbox)', auto_ai_call: 'Brief for the Inkbox call agent (what to accomplish)', manual_sms: 'Suggested text for the rep', manual_imessage: 'Suggested iMessage for the rep' };

export function Sequences() {
  const { data, error, loading, reload } = useApi<{ data: any[] }>('/v1/sequences?include=owner&page[size]=100');
  const [name, setName] = useState('');
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    const me = await api('/v1/me');
    const owner = me.data.userId ?? (await api('/v1/users?page[size]=1')).data[0]?.id;
    const r = await api('/v1/sequences', { method: 'POST', json: { data: { name, owner: { id: owner } } } });
    setName('');
    toast('Sequence created');
    reload();
    navigate(`/sequences/${r.data.id}`);
  };
  return (
    <>
      <PageHeader
        title="Sequences"
        description="Multi-step outreach: emails, calls and social touches on a schedule."
        actions={
          <form className="flex gap-2" onSubmit={create}>
            <Input className="w-56" placeholder="New sequence name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="new-sequence-name" />
            <Button type="submit">Create</Button>
          </form>
        }
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && !data && <Skeleton className="h-40 w-full" />}
      {data && data.data.length === 0 && <Empty>No sequences yet. Create one and add steps.</Empty>}
      {data && data.data.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="text-right">Delivered</TableHead>
                <TableHead className="text-right">Opened</TableHead>
                <TableHead className="text-right">Replied</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((s) => (
                <TableRow key={s.id} className="cursor-pointer" onClick={() => navigate(`/sequences/${s.id}`)} data-testid="sequence-row">
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell>{s.sequenceSteps.length}</TableCell>
                  <TableCell className="text-muted-foreground">{s.owner?.name ?? ''}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.analytics.email.delivered}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.analytics.email.opened}</TableCell>
                  <TableCell className="text-right tabular-nums">{s.analytics.email.replied}</TableCell>
                  <TableCell>
                    <StateBadge state={s.enabled ? 'active' : 'paused'} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

export function SequenceDetail({ id }: { id: string }) {
  const { data, error, reload } = useApi<{ data: any }>(`/v1/sequences/${id}?include=sequenceSteps,owner`);
  const states = useApi<{ data: any[] }>(`/v1/sequenceStates${q({ 'filter[sequence][id]': id, include: 'prospect,sequenceStep', 'page[size]': 100 })}`);
  const [step, setStep] = useState({ action: 'auto_email', intervalDays: '2', name: '', note: '', emailSubject: '', emailBody: '', aiPrompt: '', body: '' });
  const s = data?.data;

  const addStep = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/sequenceSteps', {
        method: 'POST',
        json: {
          data: {
            sequence: { id },
            action: step.action,
            interval: Math.round(Number(step.intervalDays) * 24 * 60),
            name: step.name || undefined,
            note: step.note || undefined,
            emailSubject: step.action.includes('email') ? step.emailSubject : undefined,
            emailBody: step.action.includes('email') ? step.emailBody : undefined,
            aiEmail: step.aiPrompt && step.action.includes('email') ? { promptOverride: step.aiPrompt } : undefined,
            body: BODY_ACTIONS.has(step.action) && step.body ? step.body : undefined,
          },
        },
      });
      setStep({ ...step, name: '', note: '', emailSubject: '', emailBody: '', aiPrompt: '', body: '' });
      toast('Step added');
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const move = async (idx: number, dir: -1 | 1) => {
    const ids = s.sequenceSteps.map((x: any) => x.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api(`/v1/sequences/${id}/actions/reorderSteps`, { method: 'POST', json: { data: { stepIds: ids } } });
    reload();
  };
  const del = async (stepId: string) => {
    if (!confirm('Delete this step?')) return;
    await api(`/v1/sequenceSteps/${stepId}`, { method: 'DELETE' });
    reload();
  };
  const transition = async (stateId: string, verb: 'pause' | 'resume' | 'finish') => {
    await api(`/v1/sequenceStates/${stateId}/actions/${verb}`, { method: 'POST' });
    states.reload();
  };
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!s) return <Skeleton className="h-48 w-full" />;
  const isEmail = step.action.includes('email');
  const stats: Array<[string, number]> = [
    ['Delivered', s.analytics.email.delivered],
    ['Opened', s.analytics.email.opened],
    ['Clicked', s.analytics.email.clicked],
    ['Replied', s.analytics.email.replied],
    ['Bounced', s.analytics.email.bounced],
    ['Unsubscribed', s.analytics.email.unsubscribed],
    ['Texts sent', s.analytics.messages?.sent ?? 0],
    ['Text replies', s.analytics.messages?.replied ?? 0],
    ['Inkbox replies', s.analytics.inbox?.replies ?? 0],
  ];
  return (
    <>
      <Link to="/sequences" className="text-sm text-muted-foreground hover:underline">
        ← Sequences
      </Link>
      <PageHeader
        title={s.name}
        description={`Owner ${s.owner?.name ?? ''} · ${s.sequenceSteps.length} steps`}
        actions={
          <Button variant="outline" onClick={() => api(`/v1/sequences/${id}`, { method: 'PATCH', json: { data: { enabled: !s.enabled } } }).then(reload)}>
            {s.enabled ? 'Disable' : 'Enable'}
          </Button>
        }
      />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-6">
        {stats.map(([k, v]) => (
          <Card key={k} className="gap-1 py-4">
            <CardHeader className="px-4">
              <CardDescription>{k}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{v}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <h2 className="mt-8 mb-3 text-lg font-semibold">Steps</h2>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">#</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Wait</TableHead>
              <TableHead>Name / template</TableHead>
              <TableHead className="text-right">Delivered</TableHead>
              <TableHead className="text-right">Replied</TableHead>
              <TableHead className="text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {s.sequenceSteps.map((st: any, i: number) => (
              <TableRow key={st.id} data-testid="step-row">
                <TableCell className="text-muted-foreground">{st.order}</TableCell>
                <TableCell>
                  <Badge variant="outline">{st.action.replace(/_/g, ' ')}</Badge>
                </TableCell>
                <TableCell className="text-sm">{st.interval === 0 ? 'immediately' : `${Math.round((st.interval / 1440) * 10) / 10} d`}</TableCell>
                <TableCell>
                  {st.name ?? ''} {st.template?.subject ? <span className="text-xs text-muted-foreground">“{st.template.subject}”</span> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{st.analytics.email.delivered}</TableCell>
                <TableCell className="text-right tabular-nums">{st.analytics.email.replied}</TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button size="icon" variant="ghost" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>
                      <ArrowUp className="size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === s.sequenceSteps.length - 1}>
                      <ArrowDown className="size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" aria-label="Delete step" className="text-destructive" onClick={() => del(st.id)}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">Add a step</CardTitle>
          <CardDescription>Liquid merge fields work in subject and body: {'{{ prospect.firstName }}'}, {'{{ account.name }}'}, {'{{ owner.name }}'}.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3" onSubmit={addStep} data-testid="add-step-form">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="grid gap-2">
                <Label>Action</Label>
                <Select value={step.action} onValueChange={(v) => setStep({ ...step, action: v })}>
                  <SelectTrigger data-testid="step-action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTIONS.map((a) => (
                      <SelectItem key={a} value={a}>
                        {a.replace(/_/g, ' ')}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Wait (days after previous)</Label>
                <Input type="number" min={0} step={0.5} value={step.intervalDays} onChange={(e) => setStep({ ...step, intervalDays: e.target.value })} data-testid="step-interval" />
              </div>
              <div className="grid gap-2">
                <Label>Name</Label>
                <Input value={step.name} onChange={(e) => setStep({ ...step, name: e.target.value })} data-testid="step-name" />
              </div>
            </div>
            {isEmail ? (
              <>
                <div className="grid gap-2">
                  <Label>Subject</Label>
                  <Input value={step.emailSubject} onChange={(e) => setStep({ ...step, emailSubject: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>Body (HTML)</Label>
                  <Textarea rows={6} value={step.emailBody} onChange={(e) => setStep({ ...step, emailBody: e.target.value })} />
                </div>
                <div className="grid gap-2">
                  <Label>AI drafting instructions (optional)</Label>
                  <Input value={step.aiPrompt} onChange={(e) => setStep({ ...step, aiPrompt: e.target.value })} placeholder="e.g. Reference their recent funding and ask for 15 minutes." />
                </div>
              </>
            ) : BODY_ACTIONS.has(step.action) ? (
              <>
                <div className="grid gap-2">
                  <Label>{BODY_LABEL[step.action]}</Label>
                  <Textarea rows={4} value={step.body} onChange={(e) => setStep({ ...step, body: e.target.value })} placeholder={step.action === 'auto_ai_call' ? 'Call {{ prospect.firstName }} at {{ account.name }} and confirm Thursday at 10.' : 'Hi {{ prospect.firstName }}, …'} data-testid="step-body" />
                  {step.action.startsWith('auto_') && <p className="text-xs text-muted-foreground">Goes out through the Inkbox identity mapped to the enrollment owner. Texts need consent on file and only send 08:00 to 21:00 in the prospect's zone; blocked recipients are skipped with the reason recorded.</p>}
                </div>
                <div className="grid gap-2">
                  <Label>Note for the rep (optional)</Label>
                  <Input value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} />
                </div>
              </>
            ) : (
              <div className="grid gap-2">
                <Label>Instructions for the rep</Label>
                <Input value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} />
              </div>
            )}
            <div>
              <Button type="submit" data-testid="add-step">
                Add step
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <h2 className="mt-8 mb-3 text-lg font-semibold">Enrollments</h2>
      {states.data?.data.length === 0 && <Empty>No one is enrolled yet. Enroll from a prospect page or an auto-enroll rule.</Empty>}
      {states.data && states.data.data.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Prospect</TableHead>
                <TableHead>State</TableHead>
                <TableHead>Current step</TableHead>
                <TableHead>Since</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {states.data.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link to={`/prospects/${e.prospect.id}`} className="font-medium hover:underline">
                      {e.prospect.name ?? e.prospect.id}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StateBadge state={e.state} />
                  </TableCell>
                  <TableCell className="text-sm">{e.sequenceStep?.action?.replace(/_/g, ' ') ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtDate(e.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {e.state === 'active' && (
                        <Button size="sm" variant="outline" onClick={() => transition(e.id, 'pause')}>
                          Pause
                        </Button>
                      )}
                      {e.state === 'paused' && (
                        <Button size="sm" variant="outline" onClick={() => transition(e.id, 'resume')}>
                          Resume
                        </Button>
                      )}
                      {e.state !== 'finished' && (
                        <Button size="sm" variant="ghost" className="text-destructive" onClick={() => transition(e.id, 'finish')}>
                          Finish
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}
