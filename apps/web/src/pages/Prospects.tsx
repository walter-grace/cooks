import { useState } from 'react';
import { api, fmtDate, q } from '../api.js';
import { useApi, useToast } from '../hooks.js';
import { Link, navigate } from '../router.js';

export function Prospects() {
  const [search, setSearch] = useState('');
  const [after, setAfter] = useState<string | undefined>();
  const path = `/v1/prospects${q({ 'filter[primaryEmail]': search.includes('@') ? search : undefined, 'filter[name]': search && !search.includes('@') ? search : undefined, 'page[size]': 50, 'page[after]': after, include: 'sequenceStates' })}`;
  const { data, error, reload } = useApi<{ data: any[]; links: any }>(path, [search, after]);
  const { msg, toast } = useToast();
  const [form, setForm] = useState({ firstName: '', lastName: '', title: '', primaryEmail: '', accountName: '' });

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    let accountId: string | undefined;
    if (form.accountName) {
      const found = await api<{ data: any[] }>(`/v1/accounts${q({ 'filter[name]': form.accountName })}`);
      accountId = found.data[0]?.id ?? (await api('/v1/accounts', { method: 'POST', json: { data: { name: form.accountName } } })).data.id;
    }
    await api('/v1/prospects', { method: 'POST', json: { data: { firstName: form.firstName, lastName: form.lastName || undefined, title: form.title || undefined, primaryEmail: form.primaryEmail || undefined, account: accountId ? { id: accountId } : undefined } } });
    setForm({ firstName: '', lastName: '', title: '', primaryEmail: '', accountName: '' });
    toast('Prospect created');
    reload();
  };

  return (
    <>
      <div className="row between">
        <h1>Prospects</h1>
        <input style={{ width: 280 }} placeholder="Exact name or email" value={search} onChange={(e) => (setAfter(undefined), setSearch(e.target.value))} />
      </div>
      <form className="inline card" onSubmit={create}>
        <label>
          First name
          <input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        </label>
        <label>
          Last name
          <input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </label>
        <label>
          Title
          <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </label>
        <label>
          Email
          <input type="email" value={form.primaryEmail} onChange={(e) => setForm({ ...form, primaryEmail: e.target.value })} />
        </label>
        <label>
          Company
          <input value={form.accountName} onChange={(e) => setForm({ ...form, accountName: e.target.value })} />
        </label>
        <button className="primary">Add</button>
      </form>
      {error && <div className="err">{error}</div>}
      {data && (
        <>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th>Email</th>
                <th>Enrollments</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/prospects/${p.id}`)}>
                  <td>{p.name ?? '—'}</td>
                  <td className="muted">{p.title}</td>
                  <td className="small">{p.primaryEmail}</td>
                  <td>
                    {p.sequenceStates.map((s: any) => (
                      <span key={s.id} className={`pill ${s.state === 'active' ? 'ok' : s.state === 'paused' ? 'warn' : ''}`}>
                        {s.state}
                      </span>
                    ))}
                  </td>
                  <td className="small muted">{fmtDate(p.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: '.75rem' }}>
            {data.links.next && <button onClick={() => setAfter(new URL(data.links.next, location.origin).searchParams.get('page[after]') ?? undefined)}>Next page</button>}
            {after && <button onClick={() => setAfter(undefined)}>First page</button>}
          </div>
        </>
      )}
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}

export function ProspectDetail({ id }: { id: string }) {
  const { data, error, reload } = useApi<{ data: any }>(`/v1/prospects/${id}?include=sequenceStates&includeCRMCustomFields=true`);
  const emails = useApi<{ data: any[] }>(`/v1/emails${q({ 'filter[prospect][id]': id, 'page[size]': 20 })}`);
  const tasks = useApi<{ data: any[] }>(`/v1/tasks${q({ 'filter[prospect][id]': id, 'page[size]': 20 })}`);
  const seqs = useApi<{ data: any[] }>('/v1/sequences?page[size]=100');
  const research = useApi<{ data: any }>(`/v1/prospects/${id}/research`);
  const [researching, setResearching] = useState(false);
  const runResearch = async () => {
    setResearching(true);
    const prev = research.data?.data?.researchedAt;
    await api(`/v1/prospects/${id}/actions/research`, { method: 'POST', json: { data: { force: true } } });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const now = await api(`/v1/prospects/${id}/research`);
      if (now.data.status === 'ready' && now.data.researchedAt !== prev) break;
    }
    research.reload();
    setResearching(false);
  };
  const { msg, toast } = useToast();
  const [seqId, setSeqId] = useState('');
  const p = data?.data;
  const enroll = async () => {
    const me = await api('/v1/me');
    const owner = me.data.userId ?? (await api('/v1/users?page[size]=1')).data[0]?.id;
    try {
      await api('/v1/sequenceStates', { method: 'POST', json: { data: { prospect: { id }, sequence: { id: seqId }, owner: { id: owner } } } });
      toast('Enrolled');
      reload();
    } catch (e: any) {
      toast(e.message);
    }
  };
  if (error) return <div className="err">{error}</div>;
  if (!p) return <p className="muted">Loading…</p>;
  return (
    <>
      <p className="small">
        <Link to="/prospects">← Prospects</Link>
      </p>
      <h1>{p.name ?? p.primaryEmail}</h1>
      <div className="grid">
        <div className="card">
          <div className="muted small">Title</div>
          {p.title ?? '—'}
          <div className="muted small" style={{ marginTop: '.5rem' }}>Email</div>
          {p.primaryEmail ?? '—'}
          <div className="muted small" style={{ marginTop: '.5rem' }}>LinkedIn</div>
          {p.linkedInUrl ? <a href={p.linkedInUrl}>{p.linkedInUrl}</a> : '—'}
        </div>
        <div className="card">
          <div className="muted small">Enrollments</div>
          {p.sequenceStates.length === 0 && <div className="muted">None</div>}
          {p.sequenceStates.map((s: any) => (
            <div key={s.id} className="row between" style={{ marginTop: '.3rem' }}>
              <Link to={`/sequences/${s.sequence.id}`}>{s.sequence.id.slice(0, 8)}…</Link>
              <span className={`pill ${s.state === 'active' ? 'ok' : s.state === 'paused' ? 'warn' : ''}`}>{s.state}</span>
              {s.state === 'active' && (
                <button onClick={() => api(`/v1/sequenceStates/${s.id}/actions/pause`, { method: 'POST' }).then(reload)}>Pause</button>
              )}
              {s.state === 'paused' && (
                <button onClick={() => api(`/v1/sequenceStates/${s.id}/actions/resume`, { method: 'POST' }).then(reload)}>Resume</button>
              )}
              {s.state !== 'finished' && (
                <button className="danger" onClick={() => api(`/v1/sequenceStates/${s.id}/actions/finish`, { method: 'POST' }).then(reload)}>
                  Finish
                </button>
              )}
            </div>
          ))}
          <div className="row" style={{ marginTop: '.75rem' }}>
            <select value={seqId} onChange={(e) => setSeqId(e.target.value)}>
              <option value="">Enroll in…</option>
              {seqs.data?.data.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <button className="primary" disabled={!seqId} onClick={enroll}>
              Enroll
            </button>
          </div>
        </div>
      </div>
      <h2>Research</h2>
      <div className="card">
        {research.data?.data?.status !== 'ready' && <p className="muted small">No brief yet. Research uses the workspace AI provider; with OpenRouter it searches the live web and cites sources.</p>}
        {research.data?.data?.status === 'ready' && (
          <>
            <p style={{ marginTop: 0 }}>{research.data.data.summary}</p>
            {research.data.data.talkingPoints?.length > 0 && (
              <ul className="steps">
                {research.data.data.talkingPoints.map((t: string, i: number) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            )}
            {research.data.data.signals?.length > 0 && (
              <table>
                <tbody>
                  {research.data.data.signals.map((sg: any) => (
                    <tr key={sg.id}>
                      <td>
                        <span className="pill">{sg.kind}</span>
                      </td>
                      <td className="small">{sg.text}</td>
                      <td className="small muted">{sg.date ?? ''}</td>
                      <td className="small">{sg.sourceUrl ? <a href={sg.sourceUrl} target="_blank" rel="noreferrer">source</a> : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="small muted" style={{ marginTop: '.5rem' }}>
              confidence {Math.round((research.data.data.confidence ?? 0) * 100)}% · {fmtDate(research.data.data.researchedAt)} · {research.data.data.source}
              {research.data.data.citations?.length > 0 && <> · sources: {research.data.data.citations.map((c: any, i: number) => <a key={i} href={c.url} target="_blank" rel="noreferrer" style={{ marginRight: 6 }}>{new URL(c.url).hostname}</a>)}</>}
            </div>
          </>
        )}
        <div style={{ marginTop: '.6rem' }}>
          <button className="primary" disabled={researching} onClick={runResearch}>
            {researching ? 'Researching…' : research.data?.data?.status === 'ready' ? 'Refresh research' : 'Research this prospect'}
          </button>
        </div>
      </div>
      <h2>Emails</h2>
      <table>
        <tbody>
          {emails.data?.data.map((e) => (
            <tr key={e.id}>
              <td className="small muted">{fmtDate(e.date ?? e.createdAt)}</td>
              <td>
                <span className="pill">{e.status}</span>
              </td>
              <td>{e.subject}</td>
              <td className="small muted">{e.openCount ? `${e.openCount} opens` : ''} {e.clickCount ? `· ${e.clickCount} clicks` : ''} {e.repliedAt ? '· replied' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Tasks</h2>
      <table>
        <tbody>
          {tasks.data?.data.map((t) => (
            <tr key={t.id}>
              <td className="small muted">{fmtDate(t.dueAt)}</td>
              <td>
                <span className="pill">{t.action.replace(/_/g, ' ')}</span>
              </td>
              <td className="small" style={{ whiteSpace: 'pre-wrap' }}>
                {t.note}
              </td>
              <td>
                <span className={`pill ${t.completed ? 'ok' : ''}`}>{t.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {msg && <div className="toast">{msg}</div>}
    </>
  );
}
