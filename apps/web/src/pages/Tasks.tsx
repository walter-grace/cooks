import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { api, fmtDate, q } from '../api.js';
import { useApi, toast } from '../hooks.js';
import { Link } from '../router.js';
import { Empty, PageHeader, StateBadge } from '../components/layout.js';

export function Tasks() {
  const [scope, setScope] = useState<'due' | 'open' | 'done'>('due');
  const now = useMemo(() => new Date().toISOString(), [scope]);
  const path = `/v1/tasks${q({ 'filter[completed]': scope === 'done' ? 'true' : 'false', 'filter[dueAt][lte]': scope === 'due' ? now : undefined, 'filter[status]': scope === 'open' ? 'ready' : undefined, include: 'prospect', 'page[size]': 100 })}`;
  const { data, error, loading, reload } = useApi<{ data: any[] }>(path, [scope]);
  const [draft, setDraft] = useState<any | null>(null);

  const act = async (id: string, verb: 'complete' | 'skip') => {
    await api(`/v1/tasks/${id}/${verb}`, { method: 'POST' });
    toast(verb === 'complete' ? 'Task completed' : 'Task skipped');
    reload();
  };
  const openDraft = async (t: any) => {
    const emails = await api<{ data: any[] }>(`/v1/emails${q({ 'filter[task][id]': t.id })}`);
    setDraft({ task: t, email: emails.data[0] ?? { subject: '', bodyHtml: '' } });
  };
  const sendDraft = async () => {
    if (!draft) return;
    try {
      await api('/v1/emails', { method: 'POST', json: { data: { prospectId: draft.task.prospect.id, ownerId: draft.task.owner.id, subject: draft.email.subject, bodyHtml: draft.email.bodyHtml, send: true } } });
      await api(`/v1/tasks/${draft.task.id}/complete`, { method: 'POST' });
      setDraft(null);
      toast('Email queued and task completed');
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Calls, manual emails and social touches that are due for you."
        actions={
          <Tabs value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
            <TabsList>
              <TabsTrigger value="due">Due now</TabsTrigger>
              <TabsTrigger value="open">All open</TabsTrigger>
              <TabsTrigger value="done">Done</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && !data && <Skeleton className="h-40 w-full" />}
      {data && data.data.length === 0 && <Empty>Nothing here. Enroll prospects in a sequence and tasks appear when steps come due.</Empty>}
      {data && data.data.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Due</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Prospect</TableHead>
                <TableHead className="w-[40%]">Note</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead className="text-right"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.data.map((t) => (
                <TableRow key={t.id} data-testid="task-row">
                  <TableCell className="text-muted-foreground whitespace-nowrap">{fmtDate(t.dueAt)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{t.action.replace(/_/g, ' ')}</Badge>
                  </TableCell>
                  <TableCell>
                    {t.prospect?.name ? (
                      <Link to={`/prospects/${t.prospect.id}`} className="font-medium hover:underline">
                        {t.prospect.name}
                      </Link>
                    ) : (
                      '—'
                    )}
                    <div className="text-xs text-muted-foreground">{t.prospect?.title}</div>
                  </TableCell>
                  <TableCell className="whitespace-pre-wrap text-sm">{t.note}</TableCell>
                  <TableCell>
                    <Badge variant={t.priority === 'urgent' || t.priority === 'high' ? 'default' : 'secondary'}>{t.priority}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {!t.completed && t.status !== 'skipped' ? (
                      <div className="flex justify-end gap-1">
                        {t.action.includes('email') && (
                          <Button size="sm" variant="outline" onClick={() => openDraft(t)}>
                            Draft
                          </Button>
                        )}
                        <Button size="sm" onClick={() => act(t.id, 'complete')}>
                          Done
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => act(t.id, 'skip')}>
                          Skip
                        </Button>
                      </div>
                    ) : (
                      <StateBadge state={t.status} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <Dialog open={!!draft} onOpenChange={(o) => !o && setDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Email draft</DialogTitle>
            <DialogDescription>{draft?.task?.prospect?.name ? `To ${draft.task.prospect.name}` : ''} · sent through your connected mailbox by the worker</DialogDescription>
          </DialogHeader>
          {draft && (
            <div className="grid gap-3">
              {!draft.email.id && <p className="text-sm text-muted-foreground">No AI draft attached yet; write one below.</p>}
              <div className="grid gap-2">
                <Label>Subject</Label>
                <Input value={draft.email.subject ?? ''} onChange={(e) => setDraft({ ...draft, email: { ...draft.email, subject: e.target.value } })} />
              </div>
              <div className="grid gap-2">
                <Label>Body (HTML)</Label>
                <Textarea rows={10} value={draft.email.bodyHtml ?? ''} onChange={(e) => setDraft({ ...draft, email: { ...draft.email, bodyHtml: e.target.value } })} />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={sendDraft}>Send and complete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
