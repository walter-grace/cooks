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
import { fmtMoney } from '../lib/format.js';
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

const OUTCOME_LABEL: Record<string, string> = { answered: 'Answered', voicemail: 'Voicemail', no_answer: 'No answer', failed: 'Failed' };

/**
 * AI call through Speko or Dial: pick the number, tweak the script, place, then watch the call until
 * the worker writes the outcome, summary and transcript.
 */
export function AiCallDialog({ open, onOpenChange, target, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; target: { prospectId?: string; name?: string | null; phone?: string | null; taskId?: string } | null; onDone?: () => void }) {
  const dialer = useApi<{ data: any }>(open ? '/v1/workspace/dialer' : null, [open]);
  const dd = dialer.data?.data;
  // The AI dialer: the chosen one when it is Speko or Dial, else whichever is connected.
  const sp = dd ? (dd.provider === 'dial' && dd.dial?.status === 'connected' ? dd.dial : dd.speko?.status === 'connected' ? dd.speko : dd.dial?.status === 'connected' ? dd.dial : dd.speko) : undefined;
  const providerName = sp?.provider === 'dial' ? 'Dial' : 'Speko';
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [firstMessage, setFirstMessage] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [maxSeconds, setMaxSeconds] = useState(120);
  const [busy, setBusy] = useState(false);
  const [call, setCall] = useState<any | null>(null);
  const [transcript, setTranscript] = useState<any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const prospect = useApi<{ data: any }>(open && target?.prospectId ? `/v1/prospects/${target.prospectId}?includeCRMCustomFields=true` : null, [open, target?.prospectId]);
  const own = prospect.data?.data?.crmCustomFields?.aiCallScript as { firstMessage?: string; systemPrompt?: string } | undefined;
  useEffect(() => {
    if (!sp) return;
    setFrom(sp.settings?.fromNumber ?? sp.fromNumbers?.[0] ?? '');
    setFirstMessage(own?.firstMessage ?? sp.settings?.firstMessage ?? '');
    setSystemPrompt(own?.systemPrompt ?? sp.settings?.systemPrompt ?? '');
    setMaxSeconds(sp.settings?.maxDurationSeconds ?? 120);
  }, [sp, own]);
  const saveForProspect = async () => {
    const pr = prospect.data?.data;
    if (!pr) return;
    try {
      await api(`/v1/prospects/${pr.id}`, { method: 'PATCH', json: { data: { crmCustomFields: { ...(pr.crmCustomFields ?? {}), aiCallScript: { firstMessage, systemPrompt } } } } });
      prospect.reload();
      toast(`Saved as ${pr.name ?? 'this prospect'}'s call script`, 'success');
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  useEffect(() => {
    setTo(target?.phone ?? '');
    setCall(null);
    setTranscript(null);
    setErr(null);
    // keyed on ids, not the target object: parents re-render (and rebuild `target`) when the call lands
  }, [target?.prospectId, target?.taskId, open]);
  const live = call && ['initiated', 'queued', 'ringing', 'in_progress'].includes(call.status);
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(async () => {
      try {
        const r = await api(`/v1/calls/${call.id}`);
        setCall(r.data);
        if (!['initiated', 'queued', 'ringing', 'in_progress'].includes(r.data.status)) {
          setTranscript((await api(`/v1/calls/${call.id}/transcript`)).data);
          onDone?.();
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [live, call?.id]);
  const place = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api('/v1/calls/actions/aiCall', { method: 'POST', json: { data: { prospectId: target?.prospectId, taskId: target?.taskId, to: target?.prospectId && to === target.phone ? undefined : to || undefined, fromNumber: from || undefined, firstMessage: firstMessage || undefined, systemPrompt: systemPrompt || undefined, maxDurationSeconds: maxSeconds } } });
      setCall(r.data.call);
      toast(`Queued · up to ${r.data.maxDurationSeconds}s · about $${r.data.estimatedUsd}`, 'info');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const hangup = async () => {
    if (!call) return;
    await api(`/v1/calls/${call.id}/actions/hangup`, { method: 'POST' }).catch((e: any) => toast(e.message, 'error'));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="ai-call-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Phone className="size-4" /> {target?.name ? `AI call to ${target.name}` : 'AI call'}
          </DialogTitle>
          <DialogDescription>{sp?.status === 'connected' ? `A ${providerName} voice agent places the call, follows the script, and reports the outcome and transcript here. Calls only go out 08:00 to 21:00 in the prospect’s time zone.` : 'Connect Speko or Dial under Settings → Dialer to place AI calls.'}</DialogDescription>
        </DialogHeader>
        {!call && sp?.status === 'connected' && (
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Number to call</Label>
                <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="+1 555 010 2020" data-testid="ai-call-to" />
              </div>
              <div className="grid gap-2">
                <Label>Caller id</Label>
                <Select value={from} onValueChange={setFrom}>
                  <SelectTrigger data-testid="ai-call-from">
                    <SelectValue placeholder="Caller id" />
                  </SelectTrigger>
                  <SelectContent>
                    {(sp.fromNumbers as string[]).map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Opening line</Label>
              <Input value={firstMessage} onChange={(e) => setFirstMessage(e.target.value)} data-testid="ai-call-first" />
            </div>
            <div className="grid gap-2">
              <Label>Instructions for the agent</Label>
              <Textarea rows={5} value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} data-testid="ai-call-prompt" />
              <p className="text-xs text-muted-foreground">Merge fields: {'{{ prospect.firstName }}'}, {'{{ account.name }}'}, {'{{ owner.name }}'}, {'{{ workspace.name }}'}</p>
              {target?.prospectId && (
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span data-testid="ai-call-script-source">{own ? `Using ${prospect.data?.data?.name ?? 'this prospect'}'s own script` : 'Using the workspace default script'}</span>
                  <Button type="button" variant="outline" size="sm" onClick={saveForProspect} data-testid="ai-call-save-script">
                    Save for this prospect
                  </Button>
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <Label>Maximum length: {maxSeconds}s</Label>
              <input type="range" min={30} max={sp.settings?.maxAllowedSeconds ?? 600} step={30} value={maxSeconds} onChange={(e) => setMaxSeconds(Number(e.target.value))} />
            </div>
            {err && <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive" data-testid="ai-call-error">{err}</p>}
            <DialogFooter>
              <Button onClick={place} disabled={busy || !to || !from} data-testid="ai-call-start">
                {busy ? 'Placing…' : 'Place AI call'}
              </Button>
            </DialogFooter>
          </div>
        )}
        {call && (
          <div className="grid gap-3" data-testid="ai-call-live">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <div>
                <div className="font-medium" data-testid="ai-call-status">
                  {call.outcome ? OUTCOME_LABEL[call.outcome] ?? call.outcome : STATUS_LABEL[call.status] ?? call.status}
                </div>
                <div className="text-xs text-muted-foreground">
                  {call.to} · {fmtDuration(call.duration)}
                  {call.costUsd !== null && call.costUsd !== undefined ? ` · ${fmtMoney(call.costUsd)}` : ''}
                </div>
              </div>
              {live ? (
                <Button variant="destructive" size="sm" onClick={hangup} data-testid="ai-call-hangup">
                  <PhoneOff className="size-4" /> Hang up
                </Button>
              ) : (
                <Badge variant="secondary">{call.callDisposition?.name ?? 'logged'}</Badge>
              )}
            </div>
            {live && <p className="text-sm text-muted-foreground">Waiting for the call to finish. You can close this; the result lands on the prospect timeline and the Calls page.</p>}
            {transcript && (
              <div className="grid gap-2 text-sm">
                {transcript.summary && <p className="rounded-md bg-muted p-2" data-testid="ai-call-summary">{transcript.summary}</p>}
                <div className="grid max-h-56 gap-1 overflow-y-auto">
                  {transcript.transcript?.map((e: any, k: number) => (
                    <div key={k} className={`flex gap-2 ${e.role === 'agent' ? '' : 'text-muted-foreground'}`}>
                      <span className="w-16 shrink-0 font-medium">{e.role === 'agent' ? 'Agent' : e.role === 'user' ? 'Prospect' : 'System'}</span>
                      <span>{e.text}</span>
                    </div>
                  ))}
                </div>
                <Link to={`/calls/${call.id}`} className="text-xs hover:underline">
                  Open the call page for the recording and coaching →
                </Link>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
