import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { api, currentSession } from '../api.js';
import { fmtInt, fmtMoney, fmtPctValue, plural } from '../lib/format.js';
import { toast, useApi } from '../hooks.js';

export function Dialer({ isAdmin }: { isAdmin: boolean }) {
  const dialer = useApi<{ data: any }>('/v1/workspace/dialer');
  const d = dialer.data?.data;
  if (!d) return null;
  const pick = async (provider: 'twilio' | 'speko' | 'dial') => {
    try {
      await api('/v1/workspace/dialer/provider', { method: 'PUT', json: { data: { provider } } });
      toast(`${{ twilio: 'Twilio', speko: 'Speko', dial: 'Dial' }[provider]} is now the dialer`);
      dialer.reload();
    } catch (e: any) {
      toast(e.message, 'error');
    }
  };
  return (
    <div className="grid gap-4 pt-2">
      <div className="grid gap-3 md:grid-cols-3" data-testid="dialer-providers">
        {(
          [
            ['twilio', 'Twilio', 'Reps call from their phone or the browser. Recordings, transcripts and coaching.', d.twilio.status],
            ['speko', 'Speko', 'An AI voice agent places the call, follows your script and reports the outcome and transcript.', d.speko.status],
            ['dial', 'Dial', 'A phone number for your agent in seconds: the Dial voice agent places the call from your script and brings back the transcript.', d.dial?.status ?? 'disconnected'],
          ] as const
        ).map(([key, name, blurb, status]) => (
          <div key={key} className={`flex items-start justify-between gap-3 rounded-lg border p-3 ${d.provider === key ? 'border-primary' : ''}`} data-testid={`provider-${key}`}>
            <div>
              <div className="flex items-center gap-2 text-sm font-medium">
                {name}
                <Badge variant={status === 'connected' ? 'default' : 'outline'}>{status}</Badge>
                {d.provider === key && <Badge variant="secondary">default dialer</Badge>}
              </div>
              <div className="text-xs text-muted-foreground">{blurb}</div>
            </div>
            {isAdmin && status === 'connected' && d.provider !== key && (
              <Button size="sm" variant="outline" onClick={() => pick(key)} data-testid={`use-${key}`}>
                Use as dialer
              </Button>
            )}
          </div>
        ))}
      </div>
      <Speko isAdmin={isAdmin} data={d.speko} reload={dialer.reload} />
      {d.dial && <DialCard isAdmin={isAdmin} data={d.dial} reload={dialer.reload} />}
      <Twilio isAdmin={isAdmin} t={d.twilio} reload={dialer.reload} />
      {d.twilio.status === 'connected' && <ParallelCompliance isAdmin={isAdmin} reload={dialer.reload} />}
    </div>
  );
}

/** Dial (getdial.ai): an agent phone number with calls and texts. Same script and caps as Speko; numbers can be bought here. */
function DialCard({ isAdmin, data: s, reload }: { isAdmin: boolean; data: any; reload: () => void }) {
  const bal = useApi<{ data: any }>(s.status === 'connected' ? '/v1/workspace/telephony/dial/balance' : null, [s.status, s.updatedAt]);
  const numbers = useApi<{ data: any[] }>(s.status === 'connected' ? '/v1/workspace/telephony/dial/numbers' : null, [s.status, s.updatedAt]);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ systemPrompt: '', firstMessage: '', maxDurationSeconds: 120, dailySpendCapUsd: 20, fromNumber: '', onMachine: 'leave_message', voice: '' });
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (s.status === 'connected' && !dirty) setF({ systemPrompt: s.settings.systemPrompt ?? '', firstMessage: s.settings.firstMessage ?? '', maxDurationSeconds: s.settings.maxDurationSeconds ?? 120, dailySpendCapUsd: s.settings.dailySpendCapUsd ?? 20, fromNumber: s.settings.fromNumber ?? '', onMachine: s.settings.onMachine ?? 'leave_message', voice: s.settings.voice ?? '' });
  }, [s.updatedAt, s.status]);
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/v1/workspace/telephony/dial', { method: 'PUT', json: { data: { apiKey: apiKey.trim() || undefined } } });
      setApiKey('');
      toast('Dial connected');
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('/v1/workspace/telephony/dial', { method: 'PATCH', json: { data: { ...f, fromNumber: f.fromNumber || null, voice: f.voice || null } } });
      setDirty(false);
      toast('Dial call settings saved');
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const patch = async (p: Record<string, unknown>) => {
    try {
      await api('/v1/workspace/telephony/dial', { method: 'PATCH', json: { data: p } });
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const set = (k: keyof typeof f, v: string | number) => {
    setF({ ...f, [k]: v });
    setDirty(true);
  };
  const b = bal.data?.data;
  return (
    <Card data-testid="dial-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1">
          <CardTitle>
            Dial AI calls {s.status === 'connected' && <Badge className="ml-1">connected</Badge>}
          </CardTitle>
          <CardDescription>
            {s.status === 'connected'
              ? `Key ${s.keySource === 'server' ? 'from the server' : `…${s.keyLast4}`} · ${plural(s.fromNumbers.length, 'number')}${b ? `${b.balanceUsd === null ? '' : ` · balance ${fmtMoney(b.balanceUsd)}`} · spent today ${fmtMoney(b.spentTodayUsd)} of ${fmtMoney(b.dailySpendCapUsd)}` : ''}`
              : 'Paste a Dial API key (getdial.ai → dashboard, or `dial auth rotate-key`). Dial gives the agent a real phone number; calls are placed by its voice agent and land here with the outcome and transcript. No recording.'}
          </CardDescription>
        </div>
        {isAdmin && s.status === 'connected' && (
          <Button variant="destructive" size="sm" onClick={() => api('/v1/workspace/telephony/dial', { method: 'DELETE' }).then(reload)} data-testid="dial-disconnect">
            Disconnect
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {s.status === 'connected' && b && (
          <div className="grid gap-3 md:grid-cols-4" data-testid="dial-balance">
            <Stat k="Balance" v={fmtMoney(b.balanceUsd, 'USD', 'n/a')} />
            <Stat k="Spent today" v={fmtMoney(b.spentTodayUsd)} />
            <Stat k="Daily cap" v={fmtMoney(b.dailySpendCapUsd)} />
            <Stat k="In flight" v={fmtInt(b.inFlight)} />
          </div>
        )}
        {s.status === 'connected' && (
          <div className="grid gap-3">
            <div className="grid gap-3 md:grid-cols-4">
              <div className="grid gap-2">
                <Label>Caller id</Label>
                <Select value={f.fromNumber || 'first'} onValueChange={(v) => set('fromNumber', v === 'first' ? '' : v)} disabled={!isAdmin}>
                  <SelectTrigger className="w-full" data-testid="dial-from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="first">First number</SelectItem>
                    {s.fromNumbers.map((n: string) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Max length (seconds, {s.settings.minSeconds} to {s.settings.maxAllowedSeconds})</Label>
                <Input type="number" min={s.settings.minSeconds} max={s.settings.maxAllowedSeconds} value={f.maxDurationSeconds} onChange={(e) => set('maxDurationSeconds', Number(e.target.value))} disabled={!isAdmin} data-testid="dial-max" />
              </div>
              <div className="grid gap-2">
                <Label>Daily spend cap (USD)</Label>
                <Input type="number" min={0} step={1} value={f.dailySpendCapUsd} onChange={(e) => set('dailySpendCapUsd', Number(e.target.value))} disabled={!isAdmin} data-testid="dial-cap" />
              </div>
              <div className="grid gap-2">
                <Label>Voice</Label>
                <Select value={f.voice || 'default'} onValueChange={(v) => set('voice', v === 'default' ? '' : v)} disabled={!isAdmin}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Dial default</SelectItem>
                    <SelectItem value="female">Female</SelectItem>
                    <SelectItem value="male">Male</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Opening line</Label>
              <Input value={f.firstMessage} onChange={(e) => set('firstMessage', e.target.value)} disabled={!isAdmin} />
            </div>
            <div className="grid gap-2">
              <Label>Default instructions for the agent</Label>
              <Textarea rows={5} value={f.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} disabled={!isAdmin} />
              <p className="text-xs text-muted-foreground">Merge fields: {'{{ prospect.firstName }}'}, {'{{ prospect.title }}'}, {'{{ account.name }}'}, {'{{ owner.name }}'}, {'{{ workspace.name }}'}. Dial takes one prompt per call, so the opening line and the voicemail rule are folded into it.</p>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <div className="grid gap-2">
                <Label>On voicemail</Label>
                <Select value={f.onMachine} onValueChange={(v) => set('onMachine', v)} disabled={!isAdmin}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="leave_message">Leave a message</SelectItem>
                    <SelectItem value="hangup">Hang up</SelectItem>
                    <SelectItem value="agent_decides">Let the agent decide</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3 md:col-span-2">
                <div>
                  <div className="text-sm font-medium">AI coaching on AI calls</div>
                  <div className="text-xs text-muted-foreground">Score the agent's transcript with the workspace AI provider</div>
                </div>
                <Switch checked={!!s.coach} disabled={!isAdmin} onCheckedChange={(v) => patch({ coach: v })} />
              </div>
            </div>
            {isAdmin && (
              <div>
                <Button onClick={save} disabled={busy || !dirty} data-testid="dial-save">
                  Save Dial call settings
                </Button>
              </div>
            )}
            <div className="grid gap-1 rounded-lg border p-3" data-testid="dial-numbers">
              <div className="text-sm font-medium">Numbers on the account</div>
              {numbers.data?.data.map((n) => (
                <div key={n.id} className="flex items-center justify-between text-sm" data-testid="dial-number">
                  <span>
                    {n.e164} {n.label ? <span className="text-muted-foreground">· {n.label}</span> : null} {n.isDefault && <Badge variant="secondary">default</Badge>}
                  </span>
                  <span className="text-xs text-muted-foreground">{(n.capabilities as string[]).join(', ')}{n.callingEnabled === false ? ' · calling off' : ''}</span>
                </div>
              ))}
              {numbers.data && numbers.data.data.length === 0 && <p className="text-xs text-muted-foreground">No numbers yet. Buy one below.</p>}
              <DialBuyNumber isAdmin={isAdmin} onBought={() => { reload(); numbers.reload(); }} />
              <p className="text-xs text-muted-foreground">Free Dial accounts are limited to two concurrent calls and five minutes a call until the first top-up.</p>
            </div>
          </div>
        )}
        <form className="grid gap-3 md:grid-cols-2" onSubmit={connect} data-testid="dial-form">
          <div className="grid gap-2">
            <Label>API key {s.serverKeyAvailable ? '(blank = use the server key)' : ''}</Label>
            <Input type="password" placeholder="sk_live_…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} data-testid="dial-key" />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={!isAdmin || busy || (!apiKey && !s.serverKeyAvailable && s.status !== 'connected')} data-testid="dial-connect">
              {s.status === 'connected' ? 'Save credentials' : 'Connect Dial'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Speko({ isAdmin, data: s, reload }: { isAdmin: boolean; data: any; reload: () => void }) {
  const bal = useApi<{ data: any }>(s.status === 'connected' ? '/v1/workspace/telephony/speko/balance' : null, [s.status, s.updatedAt]);
  const numbers = useApi<{ data: any[] }>(s.status === 'connected' ? '/v1/workspace/telephony/speko/numbers' : null, [s.status, s.updatedAt]);
  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({ systemPrompt: '', firstMessage: '', maxDurationSeconds: 120, dailySpendCapUsd: 20, fromNumber: '', onMachine: 'leave_message' });
  const [dirty, setDirty] = useState(false);
  const [areaCode, setAreaCode] = useState('');
  const [found, setFound] = useState<any[] | null>(null);
  const [buying, setBuying] = useState<any | null>(null);
  const ws = currentSession()?.workspace.id;
  useEffect(() => {
    if (s.status === 'connected' && !dirty) setF({ systemPrompt: s.settings.systemPrompt ?? '', firstMessage: s.settings.firstMessage ?? '', maxDurationSeconds: s.settings.maxDurationSeconds ?? 120, dailySpendCapUsd: s.settings.dailySpendCapUsd ?? 20, fromNumber: s.settings.fromNumber ?? '', onMachine: s.settings.onMachine ?? 'leave_message' });
  }, [s.updatedAt, s.status]);
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/v1/workspace/telephony/speko', { method: 'PUT', json: { data: { apiKey: apiKey.trim() || undefined, webhookSecret: webhookSecret.trim() || undefined } } });
      setApiKey('');
      setWebhookSecret('');
      toast('Speko connected');
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      await api('/v1/workspace/telephony/speko', { method: 'PATCH', json: { data: { ...f, fromNumber: f.fromNumber || null } } });
      setDirty(false);
      toast('AI call settings saved');
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const patch = async (p: Record<string, unknown>) => {
    try {
      await api('/v1/workspace/telephony/speko', { method: 'PATCH', json: { data: p } });
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const search = async () => {
    try {
      setFound((await api(`/v1/workspace/telephony/speko/numbers/available?areaCode=${encodeURIComponent(areaCode)}&limit=8`)).data);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const buy = async () => {
    if (!buying) return;
    setBusy(true);
    try {
      const r = await api('/v1/workspace/telephony/speko/numbers', { method: 'POST', json: { data: { e164: buying.e164, confirm: true, expectedUpfrontCostUsd: buying.upfrontCostUsd, expectedMonthlyCostUsd: buying.monthlyCostUsd, makeDefault: true } } });
      toast(`Bought ${r.data.e164}`);
      setBuying(null);
      setFound(null);
      reload();
      numbers.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const set = (k: keyof typeof f, v: string | number) => {
    setF({ ...f, [k]: v });
    setDirty(true);
  };
  const b = bal.data?.data;
  return (
    <Card data-testid="speko-card">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1">
          <CardTitle>
            Speko AI calls {s.status === 'connected' && <Badge className="ml-1">connected</Badge>}
          </CardTitle>
          <CardDescription>
            {s.status === 'connected'
              ? `Key ${s.keySource === 'server' ? 'from the server' : `…${s.keyLast4}`} · ${plural(s.fromNumbers.length, 'number')}${b ? `${b.balanceUsd === null ? '' : ` · balance ${fmtMoney(b.balanceUsd)}`} · spent today ${fmtMoney(b.spentTodayUsd)} of ${fmtMoney(b.dailySpendCapUsd)}` : ''}`
              : 'Paste a Speko API key (platform.speko.ai → API keys). Calls are placed by a voice agent, recorded and transcribed on Speko, and land here with outcome, summary and cost.'}
          </CardDescription>
        </div>
        {isAdmin && s.status === 'connected' && (
          <Button variant="destructive" size="sm" onClick={() => api('/v1/workspace/telephony/speko', { method: 'DELETE' }).then(reload)}>
            Disconnect
          </Button>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        {s.status === 'connected' && b && (
          <div className="grid gap-3 md:grid-cols-4" data-testid="speko-balance">
            <Stat k="Balance" v={fmtMoney(b.balanceUsd, 'USD', 'n/a')} />
            <Stat k="Spent today" v={fmtMoney(b.spentTodayUsd)} />
            <Stat k="Daily cap" v={fmtMoney(b.dailySpendCapUsd)} />
            <Stat k="In flight" v={fmtInt(b.inFlight)} />
          </div>
        )}
        {s.status === 'connected' && (
          <div className="grid gap-3">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="grid gap-2">
                <Label>Caller id</Label>
                <Select value={f.fromNumber || 'first'} onValueChange={(v) => set('fromNumber', v === 'first' ? '' : v)} disabled={!isAdmin}>
                  <SelectTrigger className="w-full" data-testid="speko-from">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="first">First number</SelectItem>
                    {s.fromNumbers.map((n: string) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Max length (seconds, up to {s.settings.maxAllowedSeconds})</Label>
                <Input type="number" min={30} max={s.settings.maxAllowedSeconds} value={f.maxDurationSeconds} onChange={(e) => set('maxDurationSeconds', Number(e.target.value))} disabled={!isAdmin} data-testid="speko-max" />
              </div>
              <div className="grid gap-2">
                <Label>Daily spend cap (USD)</Label>
                <Input type="number" min={0} step={1} value={f.dailySpendCapUsd} onChange={(e) => set('dailySpendCapUsd', Number(e.target.value))} disabled={!isAdmin} data-testid="speko-cap" />
              </div>
            </div>
            <div className="grid gap-2">
              <Label>Opening line</Label>
              <Input value={f.firstMessage} onChange={(e) => set('firstMessage', e.target.value)} disabled={!isAdmin} />
            </div>
            <div className="grid gap-2">
              <Label>Default instructions for the agent</Label>
              <Textarea rows={5} value={f.systemPrompt} onChange={(e) => set('systemPrompt', e.target.value)} disabled={!isAdmin} />
              <p className="text-xs text-muted-foreground">Merge fields: {'{{ prospect.firstName }}'}, {'{{ prospect.title }}'}, {'{{ account.name }}'}, {'{{ owner.name }}'}, {'{{ workspace.name }}'}. Reps can edit per call.</p>
            </div>
            <div className="grid gap-2 md:grid-cols-3">
              <div className="grid gap-2">
                <Label>On voicemail</Label>
                <Select value={f.onMachine} onValueChange={(v) => set('onMachine', v)} disabled={!isAdmin}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="leave_message">Leave a message</SelectItem>
                    <SelectItem value="hangup">Hang up</SelectItem>
                    <SelectItem value="agent_decides">Let the agent decide</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between rounded-lg border p-3 md:col-span-2">
                <div>
                  <div className="text-sm font-medium">AI coaching on AI calls</div>
                  <div className="text-xs text-muted-foreground">Score the agent's transcript with the workspace AI provider</div>
                </div>
                <Switch checked={!!s.coach} disabled={!isAdmin} onCheckedChange={(v) => patch({ coach: v })} />
              </div>
            </div>
            {isAdmin && (
              <div>
                <Button onClick={save} disabled={busy || !dirty} data-testid="speko-save">
                  Save AI call settings
                </Button>
              </div>
            )}
            <div className="grid gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm font-medium">Phone numbers</div>
                {isAdmin && (
                  <div className="flex gap-2">
                    <Input className="w-28" placeholder="Area code" value={areaCode} onChange={(e) => setAreaCode(e.target.value)} data-testid="speko-area" />
                    <Button size="sm" variant="outline" onClick={search} data-testid="speko-search">
                      Search
                    </Button>
                  </div>
                )}
              </div>
              {(numbers.data?.data ?? []).map((n) => (
                <div key={n.id} className="flex items-center justify-between text-sm" data-testid="speko-number">
                  <span>
                    {n.e164} {n.label ? <span className="text-muted-foreground">· {n.label}</span> : null} {n.isDefault && <Badge variant="secondary">default</Badge>}
                  </span>
                  <Badge variant={n.status === 'ready' ? 'outline' : 'destructive'}>{n.status}</Badge>
                </div>
              ))}
              {numbers.data && numbers.data.data.length === 0 && <p className="text-xs text-muted-foreground">No numbers yet. Search an area code and buy one, or add numbers in the Speko dashboard.</p>}
              {found && (
                <div className="mt-2 grid gap-1 border-t pt-2" data-testid="speko-found">
                  {found.length === 0 && <p className="text-xs text-muted-foreground">Nothing available for that area code.</p>}
                  {found.map((a) => (
                    <div key={a.e164} className="flex items-center justify-between text-sm">
                      <span>
                        {a.friendlyName ?? a.e164} <span className="text-xs text-muted-foreground">${a.upfrontCostUsd} setup · ${a.monthlyCostUsd}/mo{a.aboveStandardPrice ? ' · above standard price' : ''}</span>
                      </span>
                      <Button size="sm" onClick={() => setBuying(a)} data-testid="speko-buy">
                        Buy
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              Optional webhook for faster results: in Speko, subscribe <code className="rounded bg-muted px-1 py-0.5">{`${location.origin}/telephony/speko/webhook?ws=${ws}`}</code> to call.status and call.report, and paste the signing secret below. Without it Cooks polls every 10 seconds.
            </div>
          </div>
        )}
        <form className="grid gap-3 md:grid-cols-2" onSubmit={connect} data-testid="speko-form">
          <div className="grid gap-2">
            <Label>API key {s.serverKeyAvailable ? '(blank = use the server key)' : ''}</Label>
            <Input type="password" placeholder="sk_live_…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} data-testid="speko-key" />
          </div>
          <div className="grid gap-2">
            <Label>Webhook signing secret (optional)</Label>
            <Input type="password" placeholder="whsec_…" value={webhookSecret} onChange={(e) => setWebhookSecret(e.target.value)} />
          </div>
          <div className="md:col-span-2">
            <Button type="submit" disabled={!isAdmin || busy || (!apiKey && !s.serverKeyAvailable && s.status !== 'connected')} data-testid="speko-connect">
              {s.status === 'connected' ? 'Save credentials' : 'Connect Speko'}
            </Button>
          </div>
        </form>
      </CardContent>
      <Dialog open={!!buying} onOpenChange={(o) => !o && setBuying(null)}>
        <DialogContent className="sm:max-w-md" data-testid="speko-buy-dialog">
          <DialogHeader>
            <DialogTitle>Buy {buying?.friendlyName ?? buying?.e164}?</DialogTitle>
            <DialogDescription>
              This is a paid action on your Speko balance: ${buying?.upfrontCostUsd} setup now and ${buying?.monthlyCostUsd} every month until you release the number. It becomes the default caller id.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuying(null)}>
              Cancel
            </Button>
            <Button onClick={buy} disabled={busy} data-testid="speko-buy-confirm">
              Buy for ${buying?.upfrontCostUsd} + ${buying?.monthlyCostUsd}/mo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

/** Buy a Dial number: Dial picks a free US number, in the area code when it can. PAID, admins, explicit consent. */
function DialBuyNumber({ isAdmin, onBought }: { isAdmin: boolean; onBought: () => void }) {
  const [open, setOpen] = useState(false);
  const [areaCode, setAreaCode] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!isAdmin) return null;
  const buy = async () => {
    setBusy(true);
    try {
      const r = await api('/v1/workspace/telephony/dial/numbers', { method: 'POST', json: { data: { areaCode: areaCode.trim() || undefined, confirm: true, consent: true, makeDefault: true } } });
      toast(`Bought ${r.data.e164}`);
      setOpen(false);
      setConsent(false);
      onBought();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
        <Input className="w-28" placeholder="Area code" inputMode="numeric" maxLength={3} value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))} data-testid="dial-area" />
        <Button size="sm" variant="outline" disabled={areaCode !== '' && areaCode.length !== 3} onClick={() => setOpen(true)} data-testid="dial-buy">
          Get a number
        </Button>
        <span className="text-xs text-muted-foreground">US numbers only. Leave the area code blank for any.</span>
      </div>
      <Dialog open={open} onOpenChange={(o) => !o && setOpen(false)}>
        <DialogContent className="sm:max-w-md" data-testid="dial-buy-dialog">
          <DialogHeader>
            <DialogTitle>Buy a Dial number{areaCode ? ` in ${areaCode}` : ''}?</DialogTitle>
            <DialogDescription>
              This is a paid action on your Dial account, billed by Dial each month at your plan&apos;s per-number rate until you release it. Dial picks the exact number{areaCode ? ' (in this area code when one is free)' : ''}. It becomes the default caller id, and inbound calls to it get a short take-a-message agent.
            </DialogDescription>
          </DialogHeader>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="dial-consent" />
            <span>I hold this Dial account (or am authorized to act for it) and agree to Cooks buying this number for it. Dial keeps this statement on the number.</span>
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={buy} disabled={busy || !consent} data-testid="dial-buy-confirm">
              {busy ? 'Buying…' : 'Buy number'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Buy a Twilio number: search local numbers with voice, see the monthly price, confirm. PAID, admins. */
function TwilioBuyNumber({ isAdmin, onBought }: { isAdmin: boolean; onBought: () => void }) {
  const [areaCode, setAreaCode] = useState('');
  const [found, setFound] = useState<any[] | null>(null);
  const [buying, setBuying] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const search = async () => {
    try {
      setFound((await api(`/v1/workspace/telephony/numbers/available?${areaCode ? `areaCode=${encodeURIComponent(areaCode)}&` : ''}limit=8`)).data);
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const buy = async () => {
    if (!buying) return;
    setBusy(true);
    try {
      const r = await api('/v1/workspace/telephony/numbers', { method: 'POST', json: { data: { e164: buying.e164, confirm: true, makeDefault: true } } });
      toast(`Bought ${r.data.e164}`);
      setBuying(null);
      setFound(null);
      onBought();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const price = (a: any) => (a?.monthlyUsd == null ? 'Twilio\'s monthly rate' : `${fmtMoney(a.monthlyUsd)}/mo`);
  return (
    <Card data-testid="twilio-numbers">
      <CardHeader>
        <CardTitle className="text-base">Get a Twilio number</CardTitle>
        <CardDescription>Search local US numbers that can place calls. A bought number is billed by Twilio every month and becomes the default caller id.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2">
        {isAdmin ? (
          <div className="flex flex-wrap gap-2">
            <Input className="w-28" placeholder="Area code" inputMode="numeric" maxLength={3} value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))} data-testid="twilio-area" />
            <Button size="sm" variant="outline" disabled={areaCode !== '' && areaCode.length !== 3} onClick={search} data-testid="twilio-search">
              Search
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Ask an admin to buy numbers.</p>
        )}
        {found && (
          <div className="grid gap-1 border-t pt-2" data-testid="twilio-found">
            {found.length === 0 && <p className="text-xs text-muted-foreground">Nothing available for that area code.</p>}
            {found.map((a) => (
              <div key={a.e164} className="flex items-center justify-between text-sm">
                <span>
                  {a.friendlyName ?? a.e164} <span className="text-xs text-muted-foreground">{[a.locality, a.region].filter(Boolean).join(', ')} · {price(a)}</span>
                </span>
                <Button size="sm" onClick={() => setBuying(a)} data-testid="twilio-buy">
                  Buy
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <Dialog open={!!buying} onOpenChange={(o) => !o && setBuying(null)}>
        <DialogContent className="sm:max-w-md" data-testid="twilio-buy-dialog">
          <DialogHeader>
            <DialogTitle>Buy {buying?.friendlyName ?? buying?.e164}?</DialogTitle>
            <DialogDescription>This is a paid action on your Twilio account: {price(buying)} until you release the number in Twilio. It becomes the default caller id.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuying(null)}>
              Cancel
            </Button>
            <Button onClick={buy} disabled={busy} data-testid="twilio-buy-confirm">
              {busy ? 'Buying…' : `Buy for ${price(buying)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{k}</div>
      <div className="text-lg font-semibold tabular-nums">{v}</div>
    </div>
  );
}

function Twilio({ isAdmin, t, reload }: { isAdmin: boolean; t: any; reload: () => void }) {
  const [f, setF] = useState({ accountSid: '', authToken: '', apiKeySid: '', apiKeySecret: '', twimlAppSid: '', fromNumbers: '' });
  const [busy, setBusy] = useState(false);
  const ws = currentSession()?.workspace.id;
  const voiceUrl = `${location.origin}/telephony/voice?ws=${ws}`;
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/v1/workspace/telephony', { method: 'PUT', json: { data: { accountSid: f.accountSid.trim(), authToken: f.authToken.trim(), apiKeySid: f.apiKeySid.trim() || undefined, apiKeySecret: f.apiKeySecret.trim() || undefined, twimlAppSid: f.twimlAppSid.trim() || undefined, fromNumbers: f.fromNumbers ? f.fromNumbers.split(/[\s,;]+/).filter(Boolean) : undefined } } });
      setF({ accountSid: '', authToken: '', apiKeySid: '', apiKeySecret: '', twimlAppSid: '', fromNumbers: '' });
      toast('Twilio connected');
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const patch = async (p: Record<string, unknown>) => {
    try {
      await api('/v1/workspace/telephony', { method: 'PATCH', json: { data: p } });
      reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  return (
    <>
      {t.status === 'connected' && (
        <Card data-testid="dialer-connected">
          <CardHeader className="flex flex-row items-start justify-between gap-4">
            <div className="grid gap-1">
              <CardTitle>
                Twilio <Badge className="ml-1">connected</Badge>
              </CardTitle>
              <CardDescription>
                Account …{t.accountSidLast4} · caller ids {t.fromNumbers.join(', ') || 'none'} · browser calling {t.softphone ? 'on' : 'off (add an API key pair and TwiML App SID)'}
              </CardDescription>
            </div>
            {isAdmin && (
              <Button variant="destructive" size="sm" onClick={() => api('/v1/workspace/telephony', { method: 'DELETE' }).then(reload)}>
                Disconnect
              </Button>
            )}
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-3">
            {(
              [
                ['record', 'Record calls', 'Dual-channel, kept in your Twilio account'],
                ['transcribe', 'Transcribe recordings', 'Needs a speech-to-text endpoint (see docs/coaching.md)'],
                ['coach', 'AI coaching', 'Scorecard per call with the workspace AI provider'],
              ] as const
            ).map(([k, label, hint]) => (
              <div key={k} className="flex items-center justify-between rounded-lg border p-3">
                <div>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-xs text-muted-foreground">{hint}</div>
                </div>
                <Switch checked={!!t[k]} disabled={!isAdmin} onCheckedChange={(v) => patch({ [k]: v })} data-testid={`toggle-${k}`} />
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {t.status === 'connected' && <TwilioBuyNumber isAdmin={isAdmin} onBought={reload} />}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.status === 'connected' ? 'Update Twilio credentials' : 'Connect Twilio'}</CardTitle>
          <CardDescription>Account SID and Auth Token are enough for calls that ring your phone first. For calling from the browser add a Standard API key pair and a TwiML App whose voice URL is the one below.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-2" onSubmit={connect} data-testid="twilio-form">
            <div className="grid gap-2">
              <Label>Account SID</Label>
              <Input required placeholder="AC…" value={f.accountSid} onChange={(e) => setF({ ...f, accountSid: e.target.value })} data-testid="twilio-sid" />
            </div>
            <div className="grid gap-2">
              <Label>Auth Token</Label>
              <Input required type="password" value={f.authToken} onChange={(e) => setF({ ...f, authToken: e.target.value })} data-testid="twilio-token" />
            </div>
            <div className="grid gap-2">
              <Label>API key SID (browser calling)</Label>
              <Input placeholder="SK…" value={f.apiKeySid} onChange={(e) => setF({ ...f, apiKeySid: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>API key secret</Label>
              <Input type="password" value={f.apiKeySecret} onChange={(e) => setF({ ...f, apiKeySecret: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>TwiML App SID</Label>
              <Input placeholder="AP…" value={f.twimlAppSid} onChange={(e) => setF({ ...f, twimlAppSid: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>Caller id numbers (blank = all numbers on the account)</Label>
              <Input placeholder="+15550001111, +15550002222" value={f.fromNumbers} onChange={(e) => setF({ ...f, fromNumbers: e.target.value })} />
            </div>
            <div className="md:col-span-2">
              <Button type="submit" disabled={!isAdmin || busy} data-testid="twilio-connect">
                {t.status === 'connected' ? 'Save credentials' : 'Connect Twilio'}
              </Button>
            </div>
          </form>
          <div className="mt-4 grid gap-1 text-xs text-muted-foreground">
            <div>
              TwiML App voice URL: <code className="rounded bg-muted px-1 py-0.5">{voiceUrl}</code>
            </div>
            <div>Twilio must reach this server for status and recording callbacks. Locally, run a tunnel and set COOKS_PUBLIC_URL to it.</div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}

/** Parallel dialer: compliance mode an admin must confirm, line cap, AMD tuning, abandonment rate. */
function ParallelCompliance({ isAdmin, reload }: { isAdmin: boolean; reload: () => void }) {
  const cfg = useApi<{ data: any }>('/v1/workspace/dialer/compliance');
  const c = cfg.data?.data;
  const [mode, setMode] = useState<'b2b' | 'consumer'>('b2b');
  const [msg, setMsg] = useState('');
  const [lines, setLines] = useState('3');
  const [onUnknown, setOnUnknown] = useState<'hangup' | 'connect'>('hangup');
  const [gate, setGate] = useState<'off' | 'rules' | 'jev'>('rules');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!c) return;
    setMode(c.complianceMode);
    setMsg(c.abandonedCallMessage ?? '');
    setLines(String(c.maxLines));
    setOnUnknown(c.onUnknown);
    setGate(c.speechGate?.enabled === false ? 'off' : c.speechGate?.judge === 'jev' ? 'jev' : 'rules');
  }, [c?.confirmedAt, c?.complianceMode]);
  if (!c) return null;
  const save = async (confirm: boolean) => {
    setBusy(true);
    try {
      await api('/v1/workspace/dialer/compliance', { method: 'PUT', json: { data: { complianceMode: mode, abandonedCallMessage: msg || null, maxLines: Number(lines), onUnknown, confirm, speechGate: { enabled: gate !== 'off', judge: gate === 'jev' ? 'jev' : 'rules' } } } });
      toast(confirm ? 'Compliance mode confirmed' : 'Saved');
      cfg.reload();
      reload();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const rate = c.abandonment;
  return (
    <Card data-testid="parallel-compliance">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Parallel dialer
          <Badge variant={c.confirmed ? 'default' : 'outline'}>{c.confirmed ? `${c.complianceMode === 'consumer' ? 'consumer' : 'B2B'} · confirmed` : 'not confirmed'}</Badge>
        </CardTitle>
        <CardDescription>
          Dialing several prospects at once means a second person who answers is dropped. For calls to US consumers that is an abandoned call under the FTC Telemarketing Sales Rule (16 CFR 310.4), which allows at most 3% abandoned over 30 days and requires a recorded message with your name and number. Business-to-business calls are largely exempt. Pick the mode that matches who your reps call and confirm it. This is not legal advice.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="grid gap-2">
            <Label>Who you call</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as 'b2b' | 'consumer')} disabled={!isAdmin}>
              <SelectTrigger data-testid="pc-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="b2b">Businesses (B2B)</SelectItem>
                <SelectItem value="consumer">Consumers</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label>Lines per batch (max {mode === 'consumer' ? 2 : 6})</Label>
            <Input type="number" min={1} max={mode === 'consumer' ? 2 : 6} value={lines} onChange={(e) => setLines(e.target.value)} disabled={!isAdmin} data-testid="pc-lines" />
          </div>
          <div className="grid gap-2">
            <Label>When detection is unsure</Label>
            <Select value={onUnknown} onValueChange={(v) => setOnUnknown(v as 'hangup' | 'connect')} disabled={!isAdmin}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hangup">Hang up (safer)</SelectItem>
                <SelectItem value="connect">Connect to the rep</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid gap-2">
          <Label>Fast pickup (speech gate)</Label>
          <Select value={gate} onValueChange={(v) => setGate(v as 'off' | 'rules' | 'jev')} disabled={!isAdmin}>
            <SelectTrigger data-testid="pc-gate">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="off">Off: wait for carrier AMD</SelectItem>
              <SelectItem value="rules">Hear the first words, decide by rules</SelectItem>
              <SelectItem value="jev" disabled={!c.speech?.jevAvailable}>Rules, with Jev deciding unclear pickups{c.speech?.jevAvailable ? '' : ' (set OPENROUTER_API_KEY)'}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {c.speech?.provider
              ? `Each answered line streams its first seconds to the ${c.speech.provider} recognizer; a person saying "Hello?" is connected in well under a second, a voicemail greeting is dropped on its first phrase. Carrier AMD still runs as the fallback. No audio is stored; the first words are kept on the line as evidence.`
              : 'No recognizer is configured on this server (SPEECH_PROVIDER is off), so lines wait for carrier AMD. See docs/dialer.md → Fast pickup.'}
          </p>
        </div>
        {mode === 'consumer' && (
          <div className="grid gap-2">
            <Label>Abandoned-call message (played to a dropped person)</Label>
            <Textarea rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="This was Acme calling. Reach us at 555 000 1111." disabled={!isAdmin} data-testid="pc-message" />
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {rate && (
            <span className="text-muted-foreground" data-testid="pc-rate">
              Last {plural(rate.windowDays, 'day')}: {fmtInt(rate.humansAnswered)} people answered, {fmtInt(rate.dropped)} dropped{rate.ratePct !== null ? ` (${fmtPctValue(rate.ratePct)})` : ''}. Safe harbor {fmtPctValue(rate.safeHarborMaxPct)}.
            </span>
          )}
          {isAdmin && (
            <span className="ml-auto flex gap-2">
              <Button size="sm" variant="outline" onClick={() => save(false)} disabled={busy}>
                Save
              </Button>
              <Button size="sm" onClick={() => save(true)} disabled={busy} data-testid="pc-confirm">
                {c.confirmed && c.complianceMode === mode ? 'Re-confirm' : 'Confirm mode'}
              </Button>
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
