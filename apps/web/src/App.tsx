import { useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { loadSession, logout, type Session } from './api.js';
import { useAuthConfig } from './hooks.js';
import { match, navigate, useRoute } from './router.js';
import { Shell } from './components/layout.js';
import { Login } from './pages/Login.js';
import { Tasks } from './pages/Tasks.js';
import { ProspectDetail, Prospects } from './pages/Prospects.js';
import { SequenceDetail, Sequences } from './pages/Sequences.js';
import { Emails } from './pages/Emails.js';
import { Settings } from './pages/Settings.js';

export function App() {
  const path = useRoute();
  const auth = useAuthConfig();
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
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => document.documentElement.classList.toggle('dark', mq.matches);
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  if (session === undefined || auth === null) return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;
  if (!session || path === '/login') {
    return (
      <>
        <Login onLogin={setSession} mode={auth.mode} clerkKey={auth.clerkPublishableKey} />
        <Toaster richColors />
      </>
    );
  }

  let page: React.ReactNode;
  let p: Record<string, string> | null;
  if ((p = match(path, '/prospects/:id'))) page = <ProspectDetail id={p.id!} />;
  else if ((p = match(path, '/sequences/:id'))) page = <SequenceDetail id={p.id!} />;
  else if (path === '/prospects') page = <Prospects />;
  else if (path === '/sequences') page = <Sequences />;
  else if (path === '/emails') page = <Emails />;
  else if (path === '/settings') page = <Settings authMode={auth.mode} />;
  else page = <Tasks />;

  return (
    <>
      <Shell
        session={session}
        path={path}
        onSwitchWorkspace={async (id) => {
          setSession(await loadSession(id));
          location.reload();
        }}
        onLogout={logout}
      >
        {page}
      </Shell>
      <Toaster richColors />
    </>
  );
}
