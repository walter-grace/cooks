import { useEffect, useState } from 'react';
import { currentSession, loadSession, logout, type Session } from './api.js';
import { Link, match, navigate, useRoute } from './router.js';
import { Login } from './pages/Login.js';
import { Tasks } from './pages/Tasks.js';
import { ProspectDetail, Prospects } from './pages/Prospects.js';
import { SequenceDetail, Sequences } from './pages/Sequences.js';
import { Emails } from './pages/Emails.js';
import { Settings } from './pages/Settings.js';

const NAV = [
  ['/', 'Tasks'],
  ['/prospects', 'Prospects'],
  ['/sequences', 'Sequences'],
  ['/emails', 'Emails'],
  ['/settings', 'Settings'],
] as const;

export function App() {
  const path = useRoute();
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => {
    let ws: string | undefined;
    try {
      ws = localStorage.getItem('cooks.workspace') ?? undefined;
    } catch {}
    loadSession(ws).then(setSession);
  }, []);
  useEffect(() => {
    if (session === null && path !== '/login') navigate('/login');
    if (session && path === '/login') navigate('/');
  }, [session, path]);
  if (session === undefined) return <main className="muted">Loading…</main>;
  if (!session || path === '/login') return <Login onLogin={setSession} />;

  let page: React.ReactNode;
  let p: Record<string, string> | null;
  if ((p = match(path, '/prospects/:id'))) page = <ProspectDetail id={p.id!} />;
  else if ((p = match(path, '/sequences/:id'))) page = <SequenceDetail id={p.id!} />;
  else if (path === '/prospects') page = <Prospects />;
  else if (path === '/sequences') page = <Sequences />;
  else if (path === '/emails') page = <Emails />;
  else if (path === '/settings') page = <Settings />;
  else page = <Tasks />;

  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
  const switchWs = async (id: string) => {
    setSession(await loadSession(id));
    location.reload();
  };
  return (
    <div className="shell">
      <nav>
        <div className="brand">Cooks</div>
        {NAV.map(([to, label]) => (
          <Link key={to} to={to} className={active(to) ? 'active' : ''}>
            {label}
          </Link>
        ))}
        <a href="/docs" target="_blank" rel="noreferrer">
          API docs ↗
        </a>
        <div className="spacer" />
        {session.workspaces.length > 1 && (
          <select value={session.workspace.id} onChange={(e) => switchWs(e.target.value)}>
            {session.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        )}
        <div className="who">
          {session.user.name}
          <br />
          {session.workspace.name} · {session.workspace.role}
        </div>
        <button onClick={logout}>Sign out</button>
      </nav>
      <main>{page}</main>
    </div>
  );
}

export { currentSession };
