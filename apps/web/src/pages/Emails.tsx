import { useState } from 'react';
import { fmtDate, q } from '../api.js';
import { useApi } from '../hooks.js';
import { Link } from '../router.js';

export function Emails() {
  const [status, setStatus] = useState('');
  const { data, error } = useApi<{ data: any[] }>(`/v1/emails${q({ 'filter[status]': status, include: 'prospect', 'page[size]': 100 })}`, [status]);
  return (
    <>
      <div className="row between">
        <h1>Emails</h1>
        <select style={{ width: 180 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {['draft', 'queued', 'sent', 'received', 'rejected', 'failed'].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      {error && <div className="err">{error}</div>}
      {data && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Status</th>
              <th>Prospect</th>
              <th>Subject</th>
              <th>Engagement</th>
            </tr>
          </thead>
          <tbody>
            {data.data.map((e) => (
              <tr key={e.id}>
                <td className="small muted">{fmtDate(e.date ?? e.createdAt)}</td>
                <td>
                  <span className={`pill ${e.status === 'sent' ? 'ok' : e.status === 'rejected' || e.status === 'failed' ? 'bad' : ''}`}>{e.status}</span>
                </td>
                <td>{e.prospect?.id ? <Link to={`/prospects/${e.prospect.id}`}>{e.prospect.name ?? e.to}</Link> : e.from}</td>
                <td>{e.subject}</td>
                <td className="small muted">
                  {e.openCount ? `${e.openCount} opens ` : ''}
                  {e.clickCount ? `${e.clickCount} clicks ` : ''}
                  {e.repliedAt ? 'replied ' : ''}
                  {e.bouncedAt ? 'bounced' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
