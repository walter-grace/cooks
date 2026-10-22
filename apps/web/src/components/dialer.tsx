import { useEffect, useState } from 'react';
import { Phone, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { api } from '../api.js';
import { toast, useApi } from '../hooks.js';
import { OUTCOMES, STATUS_LABEL, fmtDuration, loadRepPhone, saveRepPhone, useDialer, type DialRequest } from '../dialer.js';
import { Link } from '../router.js';

/**
 * One dialog for the whole call: place it (bridge or softphone), watch status, then log the
 * disposition. Used from Tasks, Prospect detail and the Calls page.
 */
export function DialDialog({ open, onOpenChange, target, onLogged }: { open: boolean; onOpenChange: (o: boolean) => void; target: { prospectId?: string; name?: string | null; phone?: string | null; taskId?: string } | null; onLogged?: () => void }) {
  const tel = useApi<{ data: any }>(open ? '/v1/workspace/telephony' : null, [open]);
  const dialer = useDialer();
  const [mode, setMode] = useState<'bridge' | 'softphone'>('bridge');
  const [repPhone, setRepPhone] = useState(loadRepPhone());
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState('connected');
  const [notes, setNotes] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const t = tel.data?.data;
  useEffect(() => {
    if (t) {
      setMode(t.softphone ? 'softphone' : 'bridge');
      setFrom(t.fromNumbers?.[0] ?? '');
    }
  }, [t]);
  useEffect(() => {
    setTo(target?.phone ?? '');
    setOutcome('connected');
    setNotes('');
  }, [target]);
  useEffect(() => {
    if (!dialer.active || dialer.active.status !== 'in_progress') return;
    const id = window.setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => window.clearInterval(id);
  }, [dialer.active?.status]);

  const place = async () => {
    setBusy(true);
    try {
      saveRepPhone(repPhone);
      const req: DialRequest = { prospectId: target?.prospectId, taskId: target?.taskId, to: target?.prospectId ? undefined : to, mode, repPhone: mode === 'bridge' ? repPhone : undefined, fromNumber: from || undefined };
      if (target?.prospectId && to && to !== target.phone) req.to = to;
      setElapsed(0);
      await dialer.dial(req);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const log = async () => {
    if (!dialer.active) return;
    setBusy(true);
    try {
      await api(`/v1/calls/${dialer.active.callId}/actions/log`, { method: 'POST', json: { data: { outcome, notes: notes || undefined } } });
      toast('Call logged');
      dialer.clear();
      onLogged?.();
      onOpenChange(false);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const close = (o: boolean) => {
    if (!o) {
      dialer.hangup();
      dialer.clear();
    }
    onOpenChange(o);
  };
  const a = dialer.active;
  const live = a && !['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(a.status) && !a.status.startsWith('rep_');

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md" data-testid="dial-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="size-4" /> {target?.name ? `Call ${target.name}` : 'Place a call'}
          </DialogTitle>
          <DialogDescription>{t?.status === 'connected' ? (mode === 'bridge' ? 'Twilio rings your phone first, then connects the prospect.' : 'Calls from this browser tab. Allow microphone access when asked.') : 'Connect Twilio under Settings → Dialer to place calls, or log a call you made elsewhere.'}</DialogDescription>
        </DialogHeader>
        {!a && t?.status === 'connected' && (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label>Number to call</Label>
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+1 555 010 2020" data-testid="dial-to" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Mode</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as 'bridge' | 'softphone')}>
                  <SelectTrigger data-testid="dial-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bridge">Ring my phone first</SelectItem>
                    <SelectItem value="softphone" disabled={!t.softphone}>
                      Call from browser{t.softphone ? '' : ' (needs API key)'}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Caller id</Label>
                <Select value={from} onValueChange={setFrom}>
                  <SelectTrigger>
                    <SelectValue placeholder="number" />
                  </SelectTrigger>
                  <SelectContent>
                    {(t.fromNumbers as string[]).map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {mode === 'bridge' && (
              <div className="grid gap-2">
                <Label>Your phone</Label>
                <Input value={repPhone} onChange={(e) => setRepPhone(e.target.value)} placeholder="+1 555 999 8888" data-testid="dial-rep-phone" />
              </div>
            )}
            <DialogFooter>
              <Button onClick={place} disabled={busy || !to || (mode === 'bridge' && !repPhone)} data-testid="dial-start">
                <Phone className="size-4" /> Call
              </Button>
            </DialogFooter>
          </div>
        )}
        {!a && t && t.status !== 'connected' && (
          <DialogFooter>
            <Button asChild variant="outline">
              <Link to="/settings?tab=dialer">Open dialer settings</Link>
            </Button>
          </DialogFooter>
        )}
        {a && (
          <div className="grid gap-4">
            <div className="flex items-center justify-between rounded-lg border p-3" data-testid="dial-status">
              <div>
                <div className="font-medium">{a.to}</div>
                <div className="text-sm text-muted-foreground">{STATUS_LABEL[a.status] ?? a.status}</div>
              </div>
              <div className="flex items-center gap-2">
                {a.status === 'in_progress' && <Badge variant="secondary">{fmtDuration(elapsed)}</Badge>}
                {live && a.mode === 'softphone' && (
                  <Button size="sm" variant="destructive" onClick={() => dialer.hangup()}>
                    <PhoneOff className="size-4" /> Hang up
                  </Button>
                )}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Outcome</Label>
              <Select value={outcome} onValueChange={setOutcome}>
                <SelectTrigger data-testid="dial-outcome">
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
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What happened, next step" data-testid="dial-notes" />
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => close(false)}>
                Close
              </Button>
              <Button onClick={log} disabled={busy} data-testid="dial-log">
                Log call
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Log a call that happened outside Cooks. */
export function LogCallDialog({ open, onOpenChange, prospectId, taskId, onLogged }: { open: boolean; onOpenChange: (o: boolean) => void; prospectId: string; taskId?: string; onLogged?: () => void }) {
  const [outcome, setOutcome] = useState('connected');
  const [notes, setNotes] = useState('');
  const [minutes, setMinutes] = useState('5');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api('/v1/calls', { method: 'POST', json: { data: { prospectId, taskId, outcome, notes: notes || undefined, durationSeconds: Math.round(Number(minutes || 0) * 60) } } });
      toast('Call logged');
      onLogged?.();
      onOpenChange(false);
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md" data-testid="log-call-dialog">
        <DialogHeader>
          <DialogTitle>Log a call</DialogTitle>
          <DialogDescription>For calls made from your own phone or another tool.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label>Outcome</Label>
              <Select value={outcome} onValueChange={setOutcome}>
                <SelectTrigger data-testid="log-outcome">
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
              <Label>Minutes</Label>
              <Input type="number" min={0} step={0.5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-2">
            <Label>Notes</Label>
            <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} data-testid="log-notes" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save} disabled={busy} data-testid="log-save">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
