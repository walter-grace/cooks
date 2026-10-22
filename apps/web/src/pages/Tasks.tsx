import { useMemo, useState } from 'react';
import { api, fmtDate, q } from '../api.js';
import { useApi, useToast } from '../hooks.js';
import { Link } from '../router.js';

export function Tasks() {
  const [scope, setScope] = useState<'due' | 'open' | 'done'>('due');
  const now = useMemo(() => new Date().toISOString(), [scope]);
  const path = `/v1/tasks${q({ 'filter[completed]': scope === 'done' ? 'true' : 'false', 'filter[dueAt][lte]': scope === 'due' ? now : undefined, 'filter[status]': scope === 'open' ? 'ready' : undefined, include: 'prospect', 'page[size]': 100 })}`;
  const { data, error, loading, reload } = useApi<{ data: any[] }>(path, [scope]);
  const { msg, toast } = useToast();
  const [draft, setDraft] = useState<any | null>(null);

  const act = async (id: string, verb: 'complete' | 'skip') => {
    await api(`/v1/tasks/${id}/${verb}`, { method: 'POST' });
    toast(verb === 'complete' ? 'Task completed' : 'Task skipped');
    reload();
  };
  const openDraft = async (t: any) => {
    const emails = await api<{ data: any[] }>(`/v1/emails${q({ 'filter[task][id]': t.id })}`);
    setDraft({ task: t, email: emails.data[0] ?? null });
  };
  const sendDraft = async () => {
    if (!draft?.email) return;
    await api('/v1/emails', { method: 'POST', json: { data: { prospectId: draft.task.prospect.id ?? draft.task.prospect, ownerId: draft.task.owner.id, subject: draft.email.subject, bodyHtml: draft.email.bodyHtml, send: true } } });
    await api(`/v1/tasks/${draft.task.id}/complete`, { method: 'POST' });
    setDraft(null);
    toast('Sent');
    reload();
  };

  return (
    <>
      <div className="row between">
        <h1>Tasks</h1>
        <div className="row">
          {(['due', 'open', 'done'] as const).map((s) => (
            <button key={s} className={scope === s ? 'primary' : ''} onClick={() => setScope(s)}>
              {s === 'due' ? 'Due now' : s === 'open' ? 'All open' : 'Done'}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="err">{error}</div>}
      {loading && !data && <p className="muted">Loading…</p>}
      {data && data.data.length === 0 && <p className="muted">Nothing here. Enroll prospects in a sequence and tasks will show up when steps come due.</p>}
      {data && data.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Due</th>
              <th>Action</th>
              <th>Prospect</th>
              <th>Note</th>
              <th>Priority</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((t) => (
              <tr key={t.id}>
                <td className="small">{fmtDate(t.dueAt)}</td>
                <td>
                  <span className="pill">{t.action.replace(/_/g, ' ')}</span>
                </td>
                <td>
                  {t.prospect?.name ? (
                    <Link to={`/prospects/${t.prospect.id}`}>
                      {t.prospect.name}
                    </Link>
                  ) : (
                    '—'
                  )}
                  <div className="small muted">{t.prospect?.title}</div>
                </td>
                <td className="small" style={{ maxWidth: 420, whiteSpace: 'pre-wrap' }}>
                  {t.note}
                </td>
                <td>
                  <span className={`pill ${t.priority === 'urgent' || t.priority === 'high' ? 'warn' : ''}`}>{t.priority}</span>
                </td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  {!t.completed && t.status !== 'skipped' && (
                    <>
                      {t.action.includes('email') && <button onClick={() => openDraft(t)}>Draft</button>}
                      <button className="primary" onClick={() => act(t.id, 'complete')}>
                        Done
                      </button>
                      <button onClick={() => act(t.id, 'skip')}>Skip</button>
                    </>
                  )}
                  {(t.completed || t.status === 'skipped') && <span className="pill ok">{t.status}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {draft && (
        <div className="card" style={{ marginTop: '1rem' }}>
          <div className="row between">
            <h2 style={{ margin: 0 }}>Email draft</h2>
            <button onClick={() => setDraft(null)}>Close</button>
          </div>
          {!draft.email && <p className="muted">No draft attached yet. If the step uses AI drafting, it will appear once the worker runs.</p>}
          {draft.email && (
            <form className="stack" onSubmit={(e) => (e.preventDefault(), sendDraft())}>
              <label className="field">
                Subject
                <input value={draft.email.subject ?? ''} onChange={(e) => setDraft({ ...draft, email: { ...draft.email, subject: e.target.value } })} />
              </label>
              <label className="field">
                Body (HTML)
                <textarea value={draft.email.bodyHtml ?? ''} onChange={(e) => setDraft({ ...draft, email: { ...draft.email, bodyHtml: e.target.value } })} />
              </label>
              <div className="row">
                <button className="primary">Send and complete task</button>
                <span className="small muted">Sends through your connected mailbox via the worker.</span>
              </div>
            </form>
          )}
        </div>
      )}
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}
