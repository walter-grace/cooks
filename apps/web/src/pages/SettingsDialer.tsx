import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { api, currentSession } from '../api.js';
import { toast, useApi } from '../hooks.js';

export function Dialer({ isAdmin }: { isAdmin: boolean }) {
  const tel = useApi<{ data: any }>('/v1/workspace/telephony');
  const [f, setF] = useState({ accountSid: '', authToken: '', apiKeySid: '', apiKeySecret: '', twimlAppSid: '', fromNumbers: '' });
  const [busy, setBusy] = useState(false);
  const ws = currentSession()?.workspace.id;
  const voiceUrl = `${location.origin}/telephony/voice?ws=${ws}`;
  const t = tel.data?.data;
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/v1/workspace/telephony', { method: 'PUT', json: { data: { accountSid: f.accountSid.trim(), authToken: f.authToken.trim(), apiKeySid: f.apiKeySid.trim() || undefined, apiKeySecret: f.apiKeySecret.trim() || undefined, twimlAppSid: f.twimlAppSid.trim() || undefined, fromNumbers: f.fromNumbers ? f.fromNumbers.split(/[\s,;]+/).filter(Boolean) : undefined } } });
      setF({ accountSid: '', authToken: '', apiKeySid: '', apiKeySecret: '', twimlAppSid: '', fromNumbers: '' });
      toast('Twilio connected');
      tel.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const patch = async (p: Record<string, unknown>) => {
    try {
      await api('/v1/workspace/telephony', { method: 'PATCH', json: { data: p } });
      tel.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  if (!t) return null;
  return (
    <div className="grid gap-4 pt-2">
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
              <Button variant="destructive" size="sm" onClick={() => api('/v1/workspace/telephony', { method: 'DELETE' }).then(tel.reload)}>
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
    </div>
  );
}
