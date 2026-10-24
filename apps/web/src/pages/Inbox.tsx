import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { api, fmtDate, q } from '../api.js';
import { toast, useApi } from '../hooks.js';
import { Link } from '../router.js';
import { Empty, PageHeader } from '../components/layout.js';

const KIND_LABEL: Record<string, string> = { email: 'Email', sms: 'SMS', imessage: 'iMessage', a2a: 'Agent', call: 'Call' };

/** One row of the unified inbox. Inbound text is rendered as text only: never as HTML, never as a link target. */
export function InboxItemRow({ it, showProspect }: { it: any; showProspect?: boolean }) {
  const [open, setOpen] = useState(false);
  const inbound = it.direction === 'inbound';
  return (
    <div className={`rounded-lg border p-3 ${inbound ? '' : 'bg-muted/30'}`} data-testid="inbox-item">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2">
          <Badge variant={inbound ? 'default' : 'outline'}>{KIND_LABEL[it.kind] ?? it.kind}</Badge>
          <span className="text-xs text-muted-foreground">{inbound ? 'from' : 'to'}</span>
          <span className="font-medium">{inbound ? it.from : it.to}</span>
          {showProspect && it.prospect && (
            <Link to={`/prospects/${it.prospect.id}`} className="text-xs hover:underline">
              {it.prospect.name ?? 'prospect'}
            </Link>
          )}
          <Badge variant="secondary">{String(it.status).replace(/_/g, ' ')}</Badge>
          {it.meta?.blockReason && <Badge variant="destructive">{String(it.meta.blockReason).replace(/_/g, ' ')}</Badge>}
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtDate(it.at)} {it.provider ? `· ${it.provider}` : ''}
        </div>
      </div>
      {it.subject && <div className="mt-1 text-sm font-medium">{it.subject}</div>}
      {it.text && <p className={`mt-1 whitespace-pre-wrap text-sm ${open ? '' : 'line-clamp-3'}`}>{it.text}</p>}
      <div className="mt-2 flex gap-3 text-xs">
        {it.text && it.text.length > 200 && (
          <button className="text-muted-foreground hover:underline" onClick={() => setOpen(!open)}>
            {open ? 'less' : 'more'}
          </button>
        )}
        {it.kind === 'call' && (
          <Link to={`/calls/${it.id}`} className="text-muted-foreground hover:underline">
            call details →
          </Link>
        )}
      </div>
    </div>
  );
}

/** Compose an SMS or iMessage to a prospect; the API runs the consent and quiet-hours preflight. */
export function ComposeMessageDialog({ open, onOpenChange, prospectId, phone, onSent }: { open: boolean; onOpenChange: (o: boolean) => void; prospectId: string; phone?: string | null; onSent?: () => void }) {
  const [channel, setChannel] = useState<'sms' | 'imessage'>('sms');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api('/v1/messages', { method: 'POST', json: { data: { channel, prospectId, text } } });
      toast(`${channel === 'sms' ? 'Text' : 'iMessage'} sent`);
      setText('');
      onSent?.();
      onOpenChange(false);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="compose-dialog">
        <DialogHeader>
          <DialogTitle>Message {phone ?? 'prospect'}</DialogTitle>
          <DialogDescription>Sent from the Inkbox identity mapped to you. Texts only go out with consent on file, 08:00 to 21:00 in the prospect's time zone.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-2">
            <Label>Channel</Label>
            <Select value={channel} onValueChange={(v) => setChannel(v as 'sms' | 'imessage')}>
              <SelectTrigger className="w-full" data-testid="compose-channel">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sms">SMS</SelectItem>
                <SelectItem value="imessage">iMessage</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Message</Label>
            <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Hi {{ prospect.firstName }}, …" data-testid="compose-text" />
          </div>
          {err && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive" data-testid="compose-error">{err}</p>}
          <DialogFooter>
            <Button onClick={send} disabled={busy || !text.trim()} data-testid="compose-send">
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function Inbox() {
  const [dir, setDir] = useState('inbound');
  const [kinds, setKinds] = useState('');
  const { data, error, loading, reload } = useApi<{ data: any[]; nextBefore: string | null }>(`/v1/inbox${q({ 'filter[direction]': dir === 'all' ? undefined : dir, kinds: kinds || undefined, limit: 100 })}`, [dir, kinds]);
  return (
    <>
      <PageHeader title="Inbox" description="Email, texts, iMessages, agent requests and calls across every prospect, newest first." actions={<Button variant="outline" onClick={reload}>Refresh</Button>} />
      <div className="mb-3 flex flex-wrap gap-3">
        <Tabs value={dir} onValueChange={setDir}>
          <TabsList>
            <TabsTrigger value="inbound">Inbound</TabsTrigger>
            <TabsTrigger value="outbound">Outbound</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={kinds} onValueChange={setKinds}>
          <TabsList>
            <TabsTrigger value="">Every channel</TabsTrigger>
            <TabsTrigger value="email">Email</TabsTrigger>
            <TabsTrigger value="sms,imessage">Texts</TabsTrigger>
            <TabsTrigger value="call">Calls</TabsTrigger>
            <TabsTrigger value="a2a">Agents</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading && !data && <Skeleton className="h-40 w-full" />}
      {data && data.data.length === 0 && <Empty>Nothing here yet.</Empty>}
      <div className="grid gap-2" data-testid="inbox-list">
        {data?.data.map((it) => (
          <InboxItemRow key={`${it.kind}-${it.id}`} it={it} showProspect />
        ))}
      </div>
    </>
  );
}
