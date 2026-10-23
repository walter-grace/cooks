import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { api, currentSession, fmtDate } from '../api.js';
import { useApi, toast } from '../hooks.js';
import { PageHeader } from '../components/layout.js';
import { Dialer } from './SettingsDialer.js';
import { Channels } from './SettingsChannels.js';
import { SignalRules } from './Signals.js';

const RELEASE = 'https://github.com/walter-grace/cooks/releases/latest/download/cooks-mcp.tgz';

export function Settings({ authMode }: { authMode: 'password' | 'clerk' }) {
  const session = currentSession();
  const isAdmin = session?.workspace.role === 'admin';
  const connected = new URLSearchParams(location.search).get('connected');
  const clerk = authMode === 'clerk';
  const [tab, setTab] = useState(new URLSearchParams(location.search).get('tab') ?? 'mailboxes');
  return (
    <>
      <PageHeader title="Settings" description={`${session?.workspace.name ?? ''} · signed in ${clerk ? 'with Clerk SSO' : 'with a password'}`} />
      {connected && (
        <Alert className="mb-4">
          <AlertTitle>Connected</AlertTitle>
          <AlertDescription>{connected === 'hubspot' ? 'HubSpot is now linked to this workspace.' : `Mailbox ${connected} is connected.`}</AlertDescription>
        </Alert>
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap">
          <TabsTrigger value="mailboxes">Mailboxes</TabsTrigger>
          <TabsTrigger value="crm" data-testid="tab-crm">
            CRM
          </TabsTrigger>
          <TabsTrigger value="dialer" data-testid="tab-dialer">
            Dialer
          </TabsTrigger>
          <TabsTrigger value="channels" data-testid="tab-channels">
            Channels
          </TabsTrigger>
          <TabsTrigger value="signals" data-testid="tab-signals">
            Signals
          </TabsTrigger>
          <TabsTrigger value="ai">Hosted AI</TabsTrigger>
          <TabsTrigger value="workspace">Workspace</TabsTrigger>
          {isAdmin && <TabsTrigger value="api">API keys & MCP</TabsTrigger>}
          {isAdmin && <TabsTrigger value="webhooks">Webhooks</TabsTrigger>}
        </TabsList>
        <TabsContent value="mailboxes">
          <Mailboxes clerk={clerk} />
        </TabsContent>
        <TabsContent value="crm">
          <Crm clerk={clerk} isAdmin={!!isAdmin} />
        </TabsContent>
        <TabsContent value="dialer">
          <Dialer isAdmin={!!isAdmin} />
        </TabsContent>
        <TabsContent value="channels">
          <Channels isAdmin={!!isAdmin} />
        </TabsContent>
        <TabsContent value="signals">
          <SignalRules isAdmin={!!isAdmin} />
        </TabsContent>
        <TabsContent value="ai">
          <HostedAi isAdmin={!!isAdmin} />
        </TabsContent>
        <TabsContent value="workspace">
          <Workspace isAdmin={!!isAdmin} />
        </TabsContent>
        {isAdmin && (
          <TabsContent value="api">
            <ApiKeys />
          </TabsContent>
        )}
        {isAdmin && (
          <TabsContent value="webhooks">
            <Webhooks />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}

function Mailboxes({ clerk }: { clerk: boolean }) {
  const mailboxes = useApi<{ data: any[] }>('/v1/mailboxes?include=user&page[size]=100');
  const [mb, setMb] = useState({ email: '', smtpUrl: '', imapUrl: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const addMailbox = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/mailboxes', { method: 'POST', json: { data: { email: mb.email, smtpUrl: mb.smtpUrl || undefined, imapUrl: mb.imapUrl || undefined, isDefault: true } } });
      setMb({ email: '', smtpUrl: '', imapUrl: '' });
      toast('Mailbox added');
      mailboxes.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const viaClerk = async (provider: 'google' | 'microsoft') => {
    setBusy(provider);
    try {
      const r = await api('/v1/mailboxes/from-clerk', { method: 'POST', json: { data: { provider, isDefault: true } } });
      toast(`Connected ${r.data.email}`);
      mailboxes.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-4 pt-2">
      <Card>
        <CardHeader>
          <CardTitle>Connected mailboxes</CardTitle>
          <CardDescription>Sequences send from the default mailbox of the step owner. Replies are read from the same account.</CardDescription>
        </CardHeader>
        <CardContent>
          {mailboxes.data?.data.length === 0 && <p className="text-sm text-muted-foreground" data-testid="mailboxes-empty">No mailboxes yet.</p>}
          {mailboxes.data && mailboxes.data.data.length > 0 && (
            <Table>
              <TableBody>
                {mailboxes.data.data.map((m) => (
                  <TableRow key={m.id} data-testid="mailbox-row">
                    <TableCell className="font-medium">{m.email}</TableCell>
                    <TableCell className="text-muted-foreground">{m.user?.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{m.provider}</Badge>
                    </TableCell>
                    <TableCell>{m.isDefault && <Badge>default</Badge>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          {clerk ? (
            <>
              <Button onClick={() => viaClerk('google')} disabled={busy !== null} data-testid="connect-gmail-clerk">
                {busy === 'google' ? 'Connecting…' : 'Connect Gmail via Clerk'}
              </Button>
              <Button variant="secondary" onClick={() => viaClerk('microsoft')} disabled={busy !== null} data-testid="connect-ms-clerk">
                {busy === 'microsoft' ? 'Connecting…' : 'Connect Microsoft 365 via Clerk'}
              </Button>
              <span className="text-xs text-muted-foreground">Uses the Google or Microsoft account you linked in Clerk. Add it under your Clerk profile if the button fails.</span>
            </>
          ) : (
            <>
              <Button asChild>
                <a href="/connect/google/start">Connect Gmail</a>
              </Button>
              <Button asChild variant="secondary">
                <a href="/connect/microsoft/start">Connect Microsoft 365</a>
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add an SMTP mailbox</CardTitle>
          <CardDescription>Any provider that gives you SMTP and IMAP credentials. Mailpit works for local testing.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-3 md:grid-cols-3" onSubmit={addMailbox} data-testid="add-mailbox-form">
            <div className="grid gap-2">
              <Label>Address</Label>
              <Input type="email" required value={mb.email} onChange={(e) => setMb({ ...mb, email: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>SMTP URL</Label>
              <Input placeholder="smtp://user:pass@host:587" value={mb.smtpUrl} onChange={(e) => setMb({ ...mb, smtpUrl: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>IMAP URL (for replies)</Label>
              <Input placeholder="imaps://user:pass@host:993" value={mb.imapUrl} onChange={(e) => setMb({ ...mb, imapUrl: e.target.value })} />
            </div>
            <div className="md:col-span-3">
              <Button type="submit" variant="outline">
                Add SMTP mailbox
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function Crm({ clerk, isAdmin }: { clerk: boolean; isAdmin: boolean }) {
  const crm = useApi<{ data: any }>('/v1/workspace/crm');
  const seqs = useApi<{ data: any[] }>('/v1/sequences?page[size]=100');
  const users = useApi<{ data: any[] }>('/v1/users?page[size]=100');
  const [hsToken, setHsToken] = useState('');
  const [rule, setRule] = useState({ kind: 'list', listId: '', pipelineId: '', stageId: '', sequenceId: '', ownerId: '' });
  const [ruleResult, setRuleResult] = useState<string | null>(null);
  const [syncEmails, setSyncEmails] = useState('');
  const [busy, setBusy] = useState(false);

  const connectHubspot = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/workspace/crm/hubspot', { method: 'PUT', json: { data: { accessToken: hsToken.trim() } } });
      setHsToken('');
      toast('HubSpot connected');
      crm.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const connectViaClerk = async () => {
    setBusy(true);
    try {
      await api('/v1/workspace/crm/hubspot/from-clerk', { method: 'PUT' });
      toast('HubSpot connected');
      crm.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const addRule = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/workspace/crm/rules', { method: 'POST', json: { data: { kind: rule.kind, listId: rule.listId || undefined, pipelineId: rule.pipelineId || undefined, stageId: rule.stageId || undefined, sequenceId: rule.sequenceId, ownerId: rule.ownerId } } });
      toast('Rule added');
      crm.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  const runRule = async (id: string) => {
    setRuleResult('Running…');
    try {
      const r = await api(`/v1/workspace/crm/rules/${id}/actions/run`, { method: 'POST' });
      setRuleResult(`Synced ${r.data.synced}, enrolled ${r.data.enrolled}, skipped ${r.data.skipped}`);
      crm.reload();
    } catch (err: any) {
      setRuleResult(err.message);
    }
  };
  const importEmails = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const emails = syncEmails.split(/[\s,;]+/).filter(Boolean);
      const r = await api('/v1/integrations/hubspot/import', { method: 'POST', json: { data: { emails } } });
      toast(`Imported ${r.results.length}, ${r.errors.length} not found`);
      setSyncEmails('');
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };

  if (!crm.data) return null;
  const c = crm.data.data;
  if (c.type !== 'hubspot') {
    return (
      <Card className="mt-2" data-testid="crm-disconnected">
        <CardHeader>
          <CardTitle>HubSpot</CardTitle>
          <CardDescription>Not connected. Connect HubSpot to sync contacts and companies, write notes, log sent emails and calls on the contact timeline, and auto-enroll contacts from lists or deal stages.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="flex flex-wrap items-center gap-2">
            {clerk ? (
              <Button onClick={connectViaClerk} disabled={!isAdmin || busy} data-testid="connect-hubspot-clerk">
                {busy ? 'Connecting…' : 'Connect HubSpot via Clerk'}
              </Button>
            ) : (
              <Button asChild>
                <a href="/connect/hubspot/start">Connect HubSpot (OAuth)</a>
              </Button>
            )}
            <span className="text-sm text-muted-foreground">or paste a private-app access token</span>
          </div>
          <form className="grid gap-2 md:grid-cols-[1fr_auto] md:items-end" onSubmit={connectHubspot}>
            <div className="grid gap-2">
              <Label>Private app token</Label>
              <Input type="password" required placeholder="pat-na1-…" value={hsToken} onChange={(e) => setHsToken(e.target.value)} data-testid="hubspot-token" />
              <p className="text-xs text-muted-foreground">HubSpot → Settings → Integrations → Private apps. Scopes: contacts, companies, deals, owners, lists.</p>
            </div>
            <Button type="submit" variant="outline" disabled={!isAdmin} data-testid="connect-hubspot-token">
              Connect with token
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid gap-4 pt-2">
      <Card data-testid="crm-connected">
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="grid gap-1">
            <CardTitle>
              HubSpot <Badge className="ml-1">connected</Badge>
            </CardTitle>
            <CardDescription>
              Portal {c.hubspot?.portalId ?? '?'} · {c.hubspot?.kind === 'oauth' ? 'OAuth' : c.hubspot?.kind === 'clerk' ? 'via Clerk' : 'private app'} · token …{c.hubspot?.tokenLast4}
              <br />
              {c.settings.ownerMapSize} owners matched to users · logging {[c.settings.logEmails && 'emails', c.settings.logCalls && 'calls'].filter(Boolean).join(' and ') || 'nothing'} · last poll {fmtDate(c.settings.lastPollAt) || 'never'}
            </CardDescription>
          </div>
          {isAdmin && (
            <Button variant="destructive" size="sm" onClick={() => api('/v1/workspace/crm', { method: 'DELETE' }).then(crm.reload)}>
              Disconnect
            </Button>
          )}
        </CardHeader>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import contacts by email</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap gap-2" onSubmit={importEmails}>
            <Input className="min-w-64 flex-1" value={syncEmails} onChange={(e) => setSyncEmails(e.target.value)} placeholder="ada@globex.com, grace@globex.com" data-testid="import-emails" />
            <Button type="submit">Import from HubSpot</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Auto-enroll rules</CardTitle>
          <CardDescription>Every 5 minutes the worker pulls the HubSpot list or deal stage, syncs the contacts, and enrolls new ones into the sequence.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {c.settings.autoEnroll.length > 0 && (
            <Table>
              <TableBody>
                {c.settings.autoEnroll.map((r: any) => (
                  <TableRow key={r.id} data-testid="rule-row">
                    <TableCell>
                      <Badge variant="outline">{r.kind === 'list' ? `list ${r.listId}` : `deal stage ${r.pipelineId}/${r.stageId}`}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">→ {seqs.data?.data.find((s) => s.id === r.sequenceId)?.name ?? r.sequenceId}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">owner {users.data?.data.find((u) => u.id === r.ownerId)?.name ?? r.ownerId}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button size="sm" variant="outline" onClick={() => runRule(r.id)}>
                          Run now
                        </Button>
                        {isAdmin && (
                          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => api(`/v1/workspace/crm/rules/${r.id}`, { method: 'DELETE' }).then(crm.reload)}>
                            Remove
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {ruleResult && (
            <p className="text-sm" data-testid="rule-result">
              {ruleResult}
            </p>
          )}
          {isAdmin && (
            <form className="grid gap-3 md:grid-cols-5 md:items-end" onSubmit={addRule} data-testid="add-rule-form">
              <div className="grid gap-2">
                <Label>Source</Label>
                <Select value={rule.kind} onValueChange={(v) => setRule({ ...rule, kind: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="list">HubSpot list</SelectItem>
                    <SelectItem value="dealStage">Deal stage</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {rule.kind === 'list' ? (
                <div className="grid gap-2">
                  <Label>List id</Label>
                  <Input required value={rule.listId} onChange={(e) => setRule({ ...rule, listId: e.target.value })} data-testid="rule-list-id" />
                </div>
              ) : (
                <>
                  <div className="grid gap-2">
                    <Label>Pipeline id</Label>
                    <Input required value={rule.pipelineId} onChange={(e) => setRule({ ...rule, pipelineId: e.target.value })} placeholder="default" />
                  </div>
                  <div className="grid gap-2">
                    <Label>Stage id</Label>
                    <Input required value={rule.stageId} onChange={(e) => setRule({ ...rule, stageId: e.target.value })} placeholder="appointmentscheduled" />
                  </div>
                </>
              )}
              <div className="grid gap-2">
                <Label>Sequence</Label>
                <Select value={rule.sequenceId} onValueChange={(v) => setRule({ ...rule, sequenceId: v })}>
                  <SelectTrigger data-testid="rule-sequence">
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
              <div className="grid gap-2">
                <Label>Owner</Label>
                <Select value={rule.ownerId} onValueChange={(v) => setRule({ ...rule, ownerId: v })}>
                  <SelectTrigger data-testid="rule-owner">
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
              <Button type="submit" disabled={!rule.sequenceId || !rule.ownerId}>
                Add rule
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HostedAi({ isAdmin }: { isAdmin: boolean }) {
  const ai = useApi<{ data: any }>('/v1/workspace/ai');
  const stats = useApi<{ data: any }>('/v1/agentRuns/stats?days=30');
  const [aiForm, setAiForm] = useState<any>(null);
  const saveAi = async (e: React.FormEvent) => {
    e.preventDefault();
    const d: any = { ...aiForm };
    if (!d.apiKey) delete d.apiKey;
    try {
      await api('/v1/workspace/ai', { method: 'PATCH', json: { data: d } });
      setAiForm(null);
      toast('AI settings saved');
      ai.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  if (!ai.data) return null;
  const a = ai.data.data;
  return (
    <Card className="mt-2">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1">
          <CardTitle>Hosted AI</CardTitle>
          <CardDescription>
            Drafts emails, classifies replies and researches prospects on the web. Provider <strong>{a.provider ?? 'server default'}</strong> · model <strong>{a.model ?? 'default'}</strong> · key {a.hasKey ? `…${a.keyLast4}` : 'none'} · confidence threshold {a.confidenceThreshold} · budget {a.monthlyBudgetUsd ?? 'none'} · auto-send {a.autoSendAiEmail ? 'on' : 'off'}
            {stats.data && (
              <>
                <br />
                Last 30 days: ${stats.data.data.totalCostUsd} across {stats.data.data.rows.reduce((n: number, r: any) => n + r.runs, 0)} runs
              </>
            )}
          </CardDescription>
        </div>
        {isAdmin && !aiForm && (
          <Button variant="outline" size="sm" onClick={() => setAiForm({ provider: a.provider ?? 'anthropic', model: a.model ?? '', apiKey: '', confidenceThreshold: a.confidenceThreshold, monthlyBudgetUsd: a.monthlyBudgetUsd })}>
            Edit
          </Button>
        )}
      </CardHeader>
      {aiForm && (
        <CardContent>
          <form className="grid gap-3 md:grid-cols-5" onSubmit={saveAi}>
            <div className="grid gap-2">
              <Label>Provider</Label>
              <Select value={aiForm.provider} onValueChange={(v) => setAiForm({ ...aiForm, provider: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['anthropic', 'xai', 'openai', 'openrouter', 'ollama', 'custom'].map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Model</Label>
              <Input placeholder="provider default" value={aiForm.model ?? ''} onChange={(e) => setAiForm({ ...aiForm, model: e.target.value || null })} />
            </div>
            <div className="grid gap-2">
              <Label>API key</Label>
              <Input type="password" value={aiForm.apiKey} onChange={(e) => setAiForm({ ...aiForm, apiKey: e.target.value })} placeholder="leave blank to keep" />
            </div>
            <div className="grid gap-2">
              <Label>Confidence threshold</Label>
              <Input type="number" min={0} max={1} step={0.05} value={aiForm.confidenceThreshold} onChange={(e) => setAiForm({ ...aiForm, confidenceThreshold: Number(e.target.value) })} />
            </div>
            <div className="grid gap-2">
              <Label>Monthly budget (USD)</Label>
              <Input type="number" min={0} value={aiForm.monthlyBudgetUsd ?? ''} onChange={(e) => setAiForm({ ...aiForm, monthlyBudgetUsd: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
            <div className="flex gap-2 md:col-span-5">
              <Button type="submit">Save</Button>
              <Button type="button" variant="ghost" onClick={() => setAiForm(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      )}
    </Card>
  );
}

function Workspace({ isAdmin }: { isAdmin: boolean }) {
  const ws = useApi<{ data: any }>('/v1/workspace');
  const [settings, setSettings] = useState<any>(null);
  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await api('/v1/workspace', { method: 'PATCH', json: { data: { settings } } });
    setSettings(null);
    toast('Workspace saved');
    ws.reload();
  };
  if (!ws.data) return null;
  const s = ws.data.data.settings;
  return (
    <Card className="mt-2">
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="grid gap-1">
          <CardTitle>Sending rules</CardTitle>
          <CardDescription>
            Time zone <strong>{s.timezone ?? 'UTC'}</strong> · send window {s.sendWindow ? `${s.sendWindow.start}–${s.sendWindow.end}` : '08:00–18:00 Mon–Fri'} · on reply <strong>{s.replyBehavior ?? 'finish'}</strong>
          </CardDescription>
        </div>
        {isAdmin && !settings && (
          <Button variant="outline" size="sm" onClick={() => setSettings({ timezone: s.timezone ?? 'UTC', replyBehavior: s.replyBehavior ?? 'finish', sendWindow: s.sendWindow ?? { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' } })}>
            Edit
          </Button>
        )}
      </CardHeader>
      {settings && (
        <CardContent>
          <form className="grid gap-3 md:grid-cols-4" onSubmit={saveSettings}>
            <div className="grid gap-2">
              <Label>Time zone (IANA)</Label>
              <Input value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label>Window start</Label>
              <Input value={settings.sendWindow.start} onChange={(e) => setSettings({ ...settings, sendWindow: { ...settings.sendWindow, start: e.target.value } })} />
            </div>
            <div className="grid gap-2">
              <Label>Window end</Label>
              <Input value={settings.sendWindow.end} onChange={(e) => setSettings({ ...settings, sendWindow: { ...settings.sendWindow, end: e.target.value } })} />
            </div>
            <div className="grid gap-2">
              <Label>When a prospect replies</Label>
              <Select value={settings.replyBehavior} onValueChange={(v) => setSettings({ ...settings, replyBehavior: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="finish">finish the sequence</SelectItem>
                  <SelectItem value="pause">pause the sequence</SelectItem>
                  <SelectItem value="continue">keep going</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 md:col-span-4">
              <Button type="submit">Save</Button>
              <Button type="button" variant="ghost" onClick={() => setSettings(null)}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      )}
    </Card>
  );
}

function ApiKeys() {
  const keys = useApi<{ data: any[] }>('/v1/apiKeys');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const createKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api('/v1/apiKeys', { method: 'POST', json: { data: { name: keyName } } });
    setNewKey(r.data.token);
    setKeyName('');
    keys.reload();
  };
  const snippet = (k: string) => `claude mcp add cooks -e COOKS_API_URL=${location.origin} -e COOKS_API_KEY=${k} -- npx -y ${RELEASE}`;
  return (
    <div className="grid gap-4 pt-2">
      <Card>
        <CardHeader>
          <CardTitle>API keys</CardTitle>
          <CardDescription>For MCP clients (Claude Code, Claude Desktop, Cursor, Grok) and integrations. A key is shown once, with the setup command.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {newKey && (
            <Alert data-testid="new-key">
              <AlertTitle>New key. Copy it now.</AlertTitle>
              <AlertDescription className="grid gap-2">
                <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{newKey}</pre>
                <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{snippet(newKey)}</pre>
              </AlertDescription>
            </Alert>
          )}
          {keys.data && keys.data.data.length > 0 && (
            <Table>
              <TableBody>
                {keys.data.data.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="font-medium">{k.name}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {k.prefix}-api-{k.keyId}-…
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">last used {fmtDate(k.lastUsedAt) || 'never'}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" variant="ghost" className="text-destructive" onClick={() => api(`/v1/apiKeys/${k.id}`, { method: 'DELETE' }).then(keys.reload)}>
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <form className="flex flex-wrap gap-2" onSubmit={createKey}>
            <Input className="w-64" required placeholder="Key name" value={keyName} onChange={(e) => setKeyName(e.target.value)} />
            <Button type="submit">Create key</Button>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Use Cooks from your bot</CardTitle>
          <CardDescription>No npm install. The MCP server ships as a tarball on GitHub Releases.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">{snippet('<your key>')}</pre>
        </CardContent>
      </Card>
    </div>
  );
}

function Webhooks() {
  const hooks = useApi<{ data: any[] }>('/v1/webhooks');
  const [hook, setHook] = useState({ url: '', secret: null as string | null });
  const addHook = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/v1/webhooks', { method: 'POST', json: { data: { url: hook.url } } });
      setHook({ url: '', secret: r.data.secret });
      hooks.reload();
    } catch (err: any) {
      toast(err.message, 'error');
    }
  };
  return (
    <Card className="mt-2">
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <CardDescription>Signed like the upstream API. The endpoint must answer 2xx to a verification ping.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {hook.secret && (
          <Alert>
            <AlertTitle>Signing secret. Copy it now.</AlertTitle>
            <AlertDescription>
              <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{hook.secret}</pre>
            </AlertDescription>
          </Alert>
        )}
        {hooks.data && hooks.data.data.length > 0 && (
          <Table>
            <TableBody>
              {hooks.data.data.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="font-medium">{h.url}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{h.events.join(', ')}</TableCell>
                  <TableCell>
                    <Badge variant={h.enabled ? 'default' : 'destructive'}>{h.enabled ? 'enabled' : 'disabled'}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => api(`/v1/webhooks/${h.id}`, { method: 'DELETE' }).then(hooks.reload)}>
                      Delete
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <form className="flex flex-wrap gap-2" onSubmit={addHook}>
          <Input className="min-w-80 flex-1" required placeholder="https://example.com/hooks/cooks" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} />
          <Button type="submit">Add webhook</Button>
        </form>
      </CardContent>
    </Card>
  );
}
