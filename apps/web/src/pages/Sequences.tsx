import { useState } from 'react';
import { api, fmtDate, q } from '../api.js';
import { useApi, useToast } from '../hooks.js';
import { Link, navigate } from '../router.js';

const ACTIONS = ['auto_email', 'manual_email', 'call', 'manual_email_reply', 'auto_email_reply', 'basic_task', 'linkedin_connection_request', 'manual_linkedin_message', 'manual_sms', 'auto_sms', 'manual_whatsapp'];

export function Sequences() {
  const { data, error, reload } = useApi<{ data: any[] }>('/v1/sequences?include=owner&page[size]=100');
  const [name, setName] = useState('');
  const { msg, toast } = useToast();
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
      <div className="row between">
        <h1>Sequences</h1>
        <form className="inline" onSubmit={create}>
          <input placeholder="New sequence name" value={name} onChange={(e) => setName(e.target.value)} required />
          <button className="primary">Create</button>
        </form>
      </div>
      {error && <div className="err">{error}</div>}
      {data && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Steps</th>
              <th>Owner</th>
              <th>Delivered</th>
              <th>Opened</th>
              <th>Replied</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((s) => (
              <tr key={s.id} className="clickable" onClick={() => navigate(`/sequences/${s.id}`)}>
                <td>{s.name}</td>
                <td>{s.sequenceSteps.length}</td>
                <td className="muted">{s.owner?.name ?? ''}</td>
                <td>{s.analytics.email.delivered}</td>
                <td>{s.analytics.email.opened}</td>
                <td>{s.analytics.email.replied}</td>
                <td>
                  <span className={`pill ${s.enabled ? 'ok' : 'warn'}`}>{s.enabled ? 'enabled' : 'disabled'}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}

export function SequenceDetail({ id }: { id: string }) {
  const { data, error, reload } = useApi<{ data: any }>(`/v1/sequences/${id}?include=sequenceSteps,owner`);
  const states = useApi<{ data: any[] }>(`/v1/sequenceStates${q({ 'filter[sequence][id]': id, include: 'prospect,sequenceStep', 'page[size]': 100 })}`);
  const { msg, toast } = useToast();
  const [step, setStep] = useState({ action: 'auto_email', intervalDays: '2', name: '', note: '', emailSubject: '', emailBody: '', aiPrompt: '' });
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
          },
        },
      });
      setStep({ ...step, name: '', note: '', emailSubject: '', emailBody: '', aiPrompt: '' });
      toast('Step added');
      reload();
    } catch (err: any) {
      toast(err.message);
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
  if (error) return <div className="err">{error}</div>;
  if (!s) return <p className="muted">Loading…</p>;
  const isEmail = step.action.includes('email');
  return (
    <>
      <p className="small">
        <Link to="/sequences">← Sequences</Link>
      </p>
      <div className="row between">
        <h1>{s.name}</h1>
        <div className="row">
          <span className="muted small">{s.owner?.name}</span>
          <button onClick={() => api(`/v1/sequences/${id}`, { method: 'PATCH', json: { data: { enabled: !s.enabled } } }).then(reload)}>{s.enabled ? 'Disable' : 'Enable'}</button>
        </div>
      </div>
      <div className="grid">
        {[
          ['Delivered', s.analytics.email.delivered],
          ['Opened', s.analytics.email.opened],
          ['Clicked', s.analytics.email.clicked],
          ['Replied', s.analytics.email.replied],
          ['Bounced', s.analytics.email.bounced],
          ['Unsubscribed', s.analytics.email.unsubscribed],
        ].map(([k, v]) => (
          <div className="card" key={String(k)}>
            <div className="muted small">{k}</div>
            <div className="stat">{v}</div>
          </div>
        ))}
      </div>
      <h2>Steps</h2>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Action</th>
            <th>Wait</th>
            <th>Name / template</th>
            <th>Delivered</th>
            <th>Replied</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {s.sequenceSteps.map((st: any, i: number) => (
            <tr key={st.id}>
              <td>{st.order}</td>
              <td>
                <span className="pill">{st.action.replace(/_/g, ' ')}</span>
              </td>
              <td className="small">{st.interval === 0 ? 'immediately' : `${Math.round((st.interval / 1440) * 10) / 10} d`}</td>
              <td>
                {st.name ?? ''} {st.template?.subject ? <span className="muted small">“{st.template.subject}”</span> : null}
              </td>
              <td>{st.analytics.email.delivered}</td>
              <td>{st.analytics.email.replied}</td>
              <td className="row" style={{ justifyContent: 'flex-end' }}>
                <button onClick={() => move(i, -1)} disabled={i === 0}>
                  ↑
                </button>
                <button onClick={() => move(i, 1)} disabled={i === s.sequenceSteps.length - 1}>
                  ↓
                </button>
                <button className="danger" onClick={() => del(st.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="card stack" onSubmit={addStep} style={{ marginTop: '1rem' }}>
        <div className="row">
          <label className="field">
            Action
            <select value={step.action} onChange={(e) => setStep({ ...step, action: e.target.value })}>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a.replace(/_/g, ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Wait (days after previous)
            <input type="number" min={0} step={0.5} value={step.intervalDays} onChange={(e) => setStep({ ...step, intervalDays: e.target.value })} />
          </label>
          <label className="field" style={{ flex: 1 }}>
            Name
            <input value={step.name} onChange={(e) => setStep({ ...step, name: e.target.value })} />
          </label>
        </div>
        {isEmail && (
          <>
            <label className="field">
              Subject (Liquid merge fields: {'{{ prospect.firstName }}'}, {'{{ account.name }}'}, {'{{ owner.name }}'})
              <input value={step.emailSubject} onChange={(e) => setStep({ ...step, emailSubject: e.target.value })} />
            </label>
            <label className="field">
              Body (HTML)
              <textarea value={step.emailBody} onChange={(e) => setStep({ ...step, emailBody: e.target.value })} />
            </label>
            <label className="field">
              AI drafting instructions (optional; the worker drafts this email per prospect and attaches it to the task)
              <input value={step.aiPrompt} onChange={(e) => setStep({ ...step, aiPrompt: e.target.value })} placeholder="e.g. Reference their recent funding and ask for 15 minutes." />
            </label>
          </>
        )}
        {!isEmail && (
          <label className="field">
            Instructions for the rep
            <input value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} />
          </label>
        )}
        <div>
          <button className="primary">Add step</button>
        </div>
      </form>
      <h2>Enrollments</h2>
      <table>
        <thead>
          <tr>
            <th>Prospect</th>
            <th>State</th>
            <th>Current step</th>
            <th>Since</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {states.data?.data.map((e) => (
            <tr key={e.id}>
              <td>
                <Link to={`/prospects/${e.prospect.id}`}>{e.prospect.name ?? e.prospect.id}</Link>
              </td>
              <td>
                <span className={`pill ${e.state === 'active' ? 'ok' : e.state === 'paused' ? 'warn' : ''}`}>{e.state}</span>
              </td>
              <td className="small">{e.sequenceStep?.action?.replace(/_/g, ' ') ?? '—'}</td>
              <td className="small muted">{fmtDate(e.createdAt)}</td>
              <td className="row" style={{ justifyContent: 'flex-end' }}>
                {e.state === 'active' && <button onClick={() => api(`/v1/sequenceStates/${e.id}/actions/pause`, { method: 'POST' }).then(states.reload)}>Pause</button>}
                {e.state === 'paused' && <button onClick={() => api(`/v1/sequenceStates/${e.id}/actions/resume`, { method: 'POST' }).then(states.reload)}>Resume</button>}
                {e.state !== 'finished' && (
                  <button className="danger" onClick={() => api(`/v1/sequenceStates/${e.id}/actions/finish`, { method: 'POST' }).then(states.reload)}>
                    Finish
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}
