import { useState } from 'react';
import { api, currentSession, fmtDate } from '../api.js';
import { useApi, useToast } from '../hooks.js';

export function Settings() {
  const ws = useApi<{ data: any }>('/v1/workspace');
  const ai = useApi<{ data: any }>('/v1/workspace/ai');
  const keys = useApi<{ data: any[] }>('/v1/apiKeys');
  const mailboxes = useApi<{ data: any[] }>('/v1/mailboxes?include=user&page[size]=100');
  const hooks = useApi<{ data: any[] }>('/v1/webhooks');
  const stats = useApi<{ data: any }>('/v1/agentRuns/stats?days=30');
  const crm = useApi<{ data: any }>('/v1/workspace/crm');
  const seqs = useApi<{ data: any[] }>('/v1/sequences?page[size]=100');
  const users = useApi<{ data: any[] }>('/v1/users?page[size]=100');
  const [hsToken, setHsToken] = useState('');
  const [rule, setRule] = useState({ kind: 'list', listId: '', pipelineId: '', stageId: '', sequenceId: '', ownerId: '' });
  const [ruleResult, setRuleResult] = useState<string | null>(null);
  const [syncEmails, setSyncEmails] = useState('');
  const connectHubspot = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/workspace/crm/hubspot', { method: 'PUT', json: { data: { accessToken: hsToken.trim() } } });
      setHsToken('');
      toast('HubSpot connected');
      crm.reload();
    } catch (err: any) {
      toast(err.message);
    }
  };
  const addRule = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/workspace/crm/rules', { method: 'POST', json: { data: { kind: rule.kind, listId: rule.listId || undefined, pipelineId: rule.pipelineId || undefined, stageId: rule.stageId || undefined, sequenceId: rule.sequenceId, ownerId: rule.ownerId } } });
      toast('Rule added');
      crm.reload();
    } catch (err: any) {
      toast(err.message);
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
      toast(err.message);
    }
  };
  const { msg, toast } = useToast();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('');
  const [aiForm, setAiForm] = useState<any>(null);
  const [mb, setMb] = useState({ email: '', smtpUrl: '', imapUrl: '' });
  const [hook, setHook] = useState({ url: '', secret: null as string | null });
  const [settings, setSettings] = useState<any>(null);
  const session = currentSession();
  const isAdmin = session?.workspace.role === 'admin';
  const connected = new URLSearchParams(location.search).get('connected');

  const saveAi = async (e: React.FormEvent) => {
    e.preventDefault();
    const d: any = { ...aiForm };
    if (!d.apiKey) delete d.apiKey;
    await api('/v1/workspace/ai', { method: 'PATCH', json: { data: d } });
    setAiForm(null);
    toast('AI settings saved');
    ai.reload();
  };
  const createKey = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await api('/v1/apiKeys', { method: 'POST', json: { data: { name: keyName } } });
    setNewKey(r.data.token);
    setKeyName('');
    keys.reload();
  };
  const addMailbox = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api('/v1/mailboxes', { method: 'POST', json: { data: { email: mb.email, smtpUrl: mb.smtpUrl || undefined, imapUrl: mb.imapUrl || undefined, isDefault: true } } });
      setMb({ email: '', smtpUrl: '', imapUrl: '' });
      toast('Mailbox added');
      mailboxes.reload();
    } catch (err: any) {
      toast(err.message);
    }
  };
  const addHook = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await api('/v1/webhooks', { method: 'POST', json: { data: { url: hook.url } } });
      setHook({ url: '', secret: r.data.secret });
      hooks.reload();
    } catch (err: any) {
      toast(err.message);
    }
  };
  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    await api('/v1/workspace', { method: 'PATCH', json: { data: { settings } } });
    setSettings(null);
    toast('Workspace saved');
    ws.reload();
  };

  return (
    <>
      <h1>Settings</h1>
      {connected && <div className="card">Connected mailbox {connected}.</div>}

      <h2>Mailboxes</h2>
      <table>
        <tbody>
          {mailboxes.data?.data.map((m) => (
            <tr key={m.id}>
              <td>{m.email}</td>
              <td className="muted">{m.user?.name}</td>
              <td>{m.isDefault && <span className="pill ok">default</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row" style={{ margin: '.5rem 0' }}>
        <a className="btn" href="/connect/google/start">
          Connect Gmail
        </a>
        <a className="btn" href="/connect/microsoft/start">
          Connect Microsoft 365
        </a>
      </div>
      <form className="inline card" onSubmit={addMailbox}>
        <label>
          Address
          <input type="email" required value={mb.email} onChange={(e) => setMb({ ...mb, email: e.target.value })} />
        </label>
        <label>
          SMTP URL (optional)
          <input placeholder="smtp://user:pass@host:587" value={mb.smtpUrl} onChange={(e) => setMb({ ...mb, smtpUrl: e.target.value })} />
        </label>
        <label>
          IMAP URL (optional, for replies)
          <input placeholder="imaps://user:pass@host:993" value={mb.imapUrl} onChange={(e) => setMb({ ...mb, imapUrl: e.target.value })} />
        </label>
        <button className="primary">Add SMTP mailbox</button>
      </form>

      <h2>CRM</h2>
      {crm.data && crm.data.data.type !== 'hubspot' && (
        <div className="card stack" style={{ display: 'grid', gap: '.6rem' }}>
          <div>
            Not connected. Connect HubSpot to sync contacts and companies, write notes, log sent emails and calls on the contact timeline, and auto-enroll contacts from lists or deal stages.
          </div>
          <div className="row">
            <a className="btn" href="/connect/hubspot/start">
              Connect HubSpot (OAuth)
            </a>
            <span className="small muted">or paste a private-app access token:</span>
          </div>
          <form className="inline" onSubmit={connectHubspot}>
            <label style={{ flex: 1 }}>
              HubSpot private app token (Settings → Integrations → Private apps; scopes: contacts, companies, deals, owners, lists)
              <input type="password" required placeholder="pat-na1-…" value={hsToken} onChange={(e) => setHsToken(e.target.value)} />
            </label>
            <button className="primary" disabled={!isAdmin}>
              Connect with token
            </button>
          </form>
          {connected === 'hubspot' && <div className="small">HubSpot connected via OAuth.</div>}
        </div>
      )}
      {crm.data && crm.data.data.type === 'hubspot' && (
        <>
          <div className="card row between">
            <div>
              <div>
                <strong>HubSpot</strong> connected · portal {crm.data.data.hubspot?.portalId ?? '?'} · {crm.data.data.hubspot?.kind === 'oauth' ? 'OAuth' : 'private app'} · token …{crm.data.data.hubspot?.tokenLast4}
              </div>
              <div className="small muted">
                {crm.data.data.settings.ownerMapSize} owners matched to users · logging {crm.data.data.settings.logEmails ? 'emails' : ''} {crm.data.data.settings.logCalls ? 'calls' : ''} · last poll {fmtDate(crm.data.data.settings.lastPollAt) || 'never'}
              </div>
            </div>
            {isAdmin && (
              <button className="danger" onClick={() => api('/v1/workspace/crm', { method: 'DELETE' }).then(crm.reload)}>
                Disconnect
              </button>
            )}
          </div>
          <h2 style={{ fontSize: '.95rem' }}>Import contacts by email</h2>
          <form className="inline" onSubmit={importEmails}>
            <label style={{ flex: 1 }}>
              Emails (comma or space separated)
              <input value={syncEmails} onChange={(e) => setSyncEmails(e.target.value)} placeholder="ada@globex.com, grace@globex.com" />
            </label>
            <button className="primary">Import from HubSpot</button>
          </form>
          <h2 style={{ fontSize: '.95rem' }}>Auto-enroll rules</h2>
          <p className="small muted">Every 5 minutes the worker pulls the HubSpot list or deal stage, syncs the contacts, and enrolls new ones into the sequence.</p>
          <table>
            <tbody>
              {crm.data.data.settings.autoEnroll.map((r: any) => (
                <tr key={r.id}>
                  <td>
                    <span className="pill">{r.kind === 'list' ? `list ${r.listId}` : `deal stage ${r.pipelineId}/${r.stageId}`}</span>
                  </td>
                  <td className="small">→ {seqs.data?.data.find((s) => s.id === r.sequenceId)?.name ?? r.sequenceId}</td>
                  <td className="small muted">owner {users.data?.data.find((u) => u.id === r.ownerId)?.name ?? r.ownerId}</td>
                  <td className="row" style={{ justifyContent: 'flex-end' }}>
                    <button onClick={() => runRule(r.id)}>Run now</button>
                    {isAdmin && (
                      <button className="danger" onClick={() => api(`/v1/workspace/crm/rules/${r.id}`, { method: 'DELETE' }).then(crm.reload)}>
                        Remove
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {ruleResult && <div className="small" style={{ margin: '.4rem 0' }}>{ruleResult}</div>}
          {isAdmin && (
            <form className="inline card" onSubmit={addRule}>
              <label>
                Source
                <select value={rule.kind} onChange={(e) => setRule({ ...rule, kind: e.target.value })}>
                  <option value="list">HubSpot list</option>
                  <option value="dealStage">Deal stage</option>
                </select>
              </label>
              {rule.kind === 'list' ? (
                <label>
                  List id
                  <input required value={rule.listId} onChange={(e) => setRule({ ...rule, listId: e.target.value })} />
                </label>
              ) : (
                <>
                  <label>
                    Pipeline id
                    <input required value={rule.pipelineId} onChange={(e) => setRule({ ...rule, pipelineId: e.target.value })} placeholder="default" />
                  </label>
                  <label>
                    Stage id
                    <input required value={rule.stageId} onChange={(e) => setRule({ ...rule, stageId: e.target.value })} placeholder="appointmentscheduled" />
                  </label>
                </>
              )}
              <label>
                Sequence
                <select required value={rule.sequenceId} onChange={(e) => setRule({ ...rule, sequenceId: e.target.value })}>
                  <option value="">choose…</option>
                  {seqs.data?.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Owner
                <select required value={rule.ownerId} onChange={(e) => setRule({ ...rule, ownerId: e.target.value })}>
                  <option value="">choose…</option>
                  {users.data?.data.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary">Add rule</button>
            </form>
          )}
        </>
      )}

      <h2>Hosted AI</h2>
      {ai.data && !aiForm && (
        <div className="card row between">
          <div>
            <div>
              Provider <strong>{ai.data.data.provider ?? 'not set (server default)'}</strong> · model <strong>{ai.data.data.model ?? 'default'}</strong>
            </div>
            <div className="small muted">
              key {ai.data.data.hasKey ? `…${ai.data.data.keyLast4}` : 'none'} · confidence threshold {ai.data.data.confidenceThreshold} · budget {ai.data.data.monthlyBudgetUsd ?? 'none'} · auto-send {ai.data.data.autoSendAiEmail ? 'on' : 'off'}
            </div>
            {stats.data && <div className="small muted">Last 30 days: ${stats.data.data.totalCostUsd} across {stats.data.data.rows.reduce((a: number, r: any) => a + r.runs, 0)} runs</div>}
          </div>
          {isAdmin && <button onClick={() => setAiForm({ provider: ai.data!.data.provider ?? 'anthropic', model: ai.data!.data.model ?? '', apiKey: '', confidenceThreshold: ai.data!.data.confidenceThreshold, monthlyBudgetUsd: ai.data!.data.monthlyBudgetUsd })}>Edit</button>}
        </div>
      )}
      {aiForm && (
        <form className="card stack" onSubmit={saveAi}>
          <div className="row">
            <label className="field">
              Provider
              <select value={aiForm.provider} onChange={(e) => setAiForm({ ...aiForm, provider: e.target.value })}>
                {['anthropic', 'xai', 'openai', 'openrouter', 'ollama', 'custom'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            <label className="field">
              Model (blank = provider default)
              <input value={aiForm.model ?? ''} onChange={(e) => setAiForm({ ...aiForm, model: e.target.value || null })} />
            </label>
            <label className="field">
              API key (stored encrypted)
              <input type="password" value={aiForm.apiKey} onChange={(e) => setAiForm({ ...aiForm, apiKey: e.target.value })} placeholder="leave blank to keep" />
            </label>
            <label className="field">
              Confidence threshold
              <input type="number" min={0} max={1} step={0.05} value={aiForm.confidenceThreshold} onChange={(e) => setAiForm({ ...aiForm, confidenceThreshold: Number(e.target.value) })} />
            </label>
            <label className="field">
              Monthly budget (USD)
              <input type="number" min={0} value={aiForm.monthlyBudgetUsd ?? ''} onChange={(e) => setAiForm({ ...aiForm, monthlyBudgetUsd: e.target.value === '' ? null : Number(e.target.value) })} />
            </label>
          </div>
          <div className="row">
            <button className="primary">Save</button>
            <button type="button" onClick={() => setAiForm(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <h2>Workspace</h2>
      {ws.data && !settings && (
        <div className="card row between">
          <div className="small">
            Time zone <strong>{ws.data.data.settings.timezone ?? 'UTC'}</strong> · send window {ws.data.data.settings.sendWindow ? `${ws.data.data.settings.sendWindow.start}–${ws.data.data.settings.sendWindow.end}` : '08:00–18:00 Mon–Fri'} · on reply{' '}
            <strong>{ws.data.data.settings.replyBehavior ?? 'finish'}</strong>
          </div>
          {isAdmin && <button onClick={() => setSettings({ timezone: ws.data!.data.settings.timezone ?? 'UTC', replyBehavior: ws.data!.data.settings.replyBehavior ?? 'finish', sendWindow: ws.data!.data.settings.sendWindow ?? { days: [1, 2, 3, 4, 5], start: '08:00', end: '18:00' } })}>Edit</button>}
        </div>
      )}
      {settings && (
        <form className="card stack" onSubmit={saveSettings}>
          <div className="row">
            <label className="field">
              Time zone (IANA)
              <input value={settings.timezone} onChange={(e) => setSettings({ ...settings, timezone: e.target.value })} />
            </label>
            <label className="field">
              Window start
              <input value={settings.sendWindow.start} onChange={(e) => setSettings({ ...settings, sendWindow: { ...settings.sendWindow, start: e.target.value } })} />
            </label>
            <label className="field">
              Window end
              <input value={settings.sendWindow.end} onChange={(e) => setSettings({ ...settings, sendWindow: { ...settings.sendWindow, end: e.target.value } })} />
            </label>
            <label className="field">
              When a prospect replies
              <select value={settings.replyBehavior} onChange={(e) => setSettings({ ...settings, replyBehavior: e.target.value })}>
                <option value="finish">finish the sequence</option>
                <option value="pause">pause the sequence</option>
                <option value="continue">keep going</option>
              </select>
            </label>
          </div>
          <div className="row">
            <button className="primary">Save</button>
            <button type="button" onClick={() => setSettings(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {isAdmin && (
        <>
          <h2>API keys</h2>
          <p className="small muted">For MCP clients (`npx cooks-mcp`) and integrations. Shown once.</p>
          {newKey && (
            <div className="card">
              <strong>New key</strong> (copy it now)
              <pre>{newKey}</pre>
              <pre>{`claude mcp add cooks -e COOKS_API_URL=${location.origin} -e COOKS_API_KEY=${newKey} -- npx -y cooks-mcp`}</pre>
            </div>
          )}
          <table>
            <tbody>
              {keys.data?.data.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td>
                  <td className="small muted">{k.prefix}-api-{k.keyId}-…</td>
                  <td className="small muted">last used {fmtDate(k.lastUsedAt) || 'never'}</td>
                  <td>
                    <button className="danger" onClick={() => api(`/v1/apiKeys/${k.id}`, { method: 'DELETE' }).then(keys.reload)}>
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="inline" onSubmit={createKey}>
            <label>
              Name
              <input required value={keyName} onChange={(e) => setKeyName(e.target.value)} />
            </label>
            <button className="primary">Create key</button>
          </form>

          <h2>Webhooks</h2>
          {hook.secret && (
            <div className="card">
              <strong>Signing secret</strong> (copy it now)
              <pre>{hook.secret}</pre>
            </div>
          )}
          <table>
            <tbody>
              {hooks.data?.data.map((h) => (
                <tr key={h.id}>
                  <td>{h.url}</td>
                  <td className="small muted">{h.events.join(', ')}</td>
                  <td>
                    <span className={`pill ${h.enabled ? 'ok' : 'bad'}`}>{h.enabled ? 'enabled' : 'disabled'}</span>
                  </td>
                  <td>
                    <button className="danger" onClick={() => api(`/v1/webhooks/${h.id}`, { method: 'DELETE' }).then(hooks.reload)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <form className="inline" onSubmit={addHook}>
            <label>
              Endpoint URL (must answer 2xx to a verification ping)
              <input style={{ width: 360 }} required value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} />
            </label>
            <button className="primary">Add webhook</button>
          </form>
        </>
      )}
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}
