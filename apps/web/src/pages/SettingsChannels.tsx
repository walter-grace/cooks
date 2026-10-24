import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '../api.js';
import { fmtInt, plural } from '../lib/format.js';
import { toast, useApi } from '../hooks.js';

/** Settings → Channels: Inkbox connection, identities mapped to reps, webhook subscriptions. */
export function Channels({ isAdmin }: { isAdmin: boolean }) {
  const ink = useApi<{ data: any }>('/v1/workspace/channels/inkbox');
  const users = useApi<{ data: any[] }>('/v1/users?page[size]=100');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const d = ink.data?.data;
  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('/v1/workspace/channels/inkbox', { method: 'PUT', json: { data: { apiKey: apiKey.trim() } } });
      setApiKey('');
      toast('Inkbox connected');
      ink.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const mapUser = async (identityId: string, userId: string) => {
    try {
      await api(`/v1/workspace/channels/inkbox/identities/${identityId}/user`, { method: 'PUT', json: { data: { userId: userId || null } } });
      toast(userId ? 'Identity mapped; its mailbox is ready for sequences' : 'Identity unmapped');
      ink.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const subscribe = async (identityId: string) => {
    try {
      const r = await api(`/v1/workspace/channels/inkbox/identities/${identityId}/actions/subscribe`, { method: 'POST' });
      toast(r.data.signed ? 'Subscribed with a signing key' : 'Subscribed (bearer token only)');
      ink.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  if (!d) return null;
  return (
    <div className="grid gap-4 pt-2">
      <Card data-testid="inkbox-card">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="grid gap-1">
            <CardTitle>
              Inkbox {d.status === 'connected' && <Badge className="ml-1">connected</Badge>}
            </CardTitle>
            <CardDescription>
              {d.status === 'connected'
                ? `${plural(d.identities.length, 'identity', 'identities')} · today: ${fmtInt(d.stats?.sentToday ?? 0)} sent, ${fmtInt(d.stats?.receivedToday ?? 0)} received, ${fmtInt(d.stats?.blockedToday ?? 0)} blocked`
                : 'Each rep or agent gets an Inkbox identity with an email address, a phone number for SMS and an iMessage line. Sequences send from them; replies flow back through a signed webhook.'}
            </CardDescription>
          </div>
          {isAdmin && d.status === 'connected' && (
            <Button variant="destructive" size="sm" onClick={() => api('/v1/workspace/channels/inkbox', { method: 'DELETE' }).then(ink.reload)}>
              Disconnect
            </Button>
          )}
        </CardHeader>
        <CardContent className="grid gap-4">
          {d.status === 'connected' && (
            <div className="grid gap-2 rounded-lg border p-3" data-testid="inkbox-identities">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Identities</div>
                {isAdmin && (
                  <Button size="sm" variant="outline" onClick={() => api('/v1/workspace/channels/inkbox/actions/sync', { method: 'POST' }).then(ink.reload)}>
                    Re-sync
                  </Button>
                )}
              </div>
              {d.identities.length === 0 && <p className="text-xs text-muted-foreground">No identities on this key. Create one in Inkbox, then re-sync.</p>}
              {d.identities.map((i: any) => (
                <div key={i.id} className="grid gap-2 border-t pt-2 text-sm md:grid-cols-[1fr_auto_auto] md:items-center" data-testid="inkbox-identity">
                  <div className="min-w-0">
                    <div className="font-medium">
                      @{i.handle} {i.displayName ? <span className="text-muted-foreground">· {i.displayName}</span> : null}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {[i.emailAddress, i.phoneNumber ? `${i.phoneNumber}${i.smsStatus && i.smsStatus !== 'ready' ? ` (sms ${i.smsStatus})` : ''}` : null, i.imessageEnabled ? 'iMessage' : null].filter(Boolean).join(' · ') || 'no channels yet'}
                    </div>
                  </div>
                  <Select value={i.user?.id ?? 'none'} onValueChange={(v) => mapUser(i.id, v === 'none' ? '' : v)} disabled={!isAdmin}>
                    <SelectTrigger className="w-full sm:w-56" data-testid="identity-user">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Not mapped</SelectItem>
                      {users.data?.data.map((u) => (
                        <SelectItem key={u.id} value={u.id}>
                          {u.name ?? u.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-2">
                    <Badge variant={i.subscriptions ? 'secondary' : 'outline'}>{i.subscriptions ? `webhook${i.signed ? ' · signed' : ''}` : 'no webhook'}</Badge>
                    {isAdmin && (
                      <Button size="sm" variant="outline" onClick={() => subscribe(i.id)} data-testid="identity-subscribe">
                        {i.subscriptions ? 'Re-subscribe' : 'Subscribe'}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Mapping an identity to a rep creates an Inkbox mailbox they can send sequences from. Subscribing points Inkbox at <code className="rounded bg-muted px-1 py-0.5">{d.webhookUrl}</code> with a bearer token and, when available, an identity signing key. Inbound replies stop or pause the sequence, open a task and count in reply stats. STOP texts opt the prospect out.
              </p>
            </div>
          )}
          <form className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end" onSubmit={connect} data-testid="inkbox-form">
            <div className="grid gap-2">
              <Label>Inkbox API key</Label>
              <Input type="password" placeholder="Admin-scoped key from inkbox.ai → API keys" value={apiKey} onChange={(e) => setApiKey(e.target.value)} data-testid="inkbox-key" />
            </div>
            <Button type="submit" disabled={!isAdmin || busy || !apiKey} data-testid="inkbox-connect">
              {d.status === 'connected' ? 'Replace key' : 'Connect Inkbox'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
