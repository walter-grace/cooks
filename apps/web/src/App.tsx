import { useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { loadSession, logout, type Session } from './api.js';
import { useAuthConfig } from './hooks.js';
import { match, navigate, useRoute } from './router.js';
import { Shell } from './components/layout.js';
import { Login } from './pages/Login.js';
import { Forgot, Join, Reset, Signup, Verify } from './pages/Account.js';
import { Practice } from './pages/Practice.js';
import { Tasks } from './pages/Tasks.js';
import { ProspectDetail, Prospects } from './pages/Prospects.js';
import { SequenceDetail, Sequences } from './pages/Sequences.js';
import { Emails } from './pages/Emails.js';
import { Settings } from './pages/Settings.js';
import { Signals } from './pages/Signals.js';
import { CallDetail, Calls } from './pages/Calls.js';
import { Inbox } from './pages/Inbox.js';
import { PowerDialer } from './pages/PowerDialer.js';

const ACCOUNT_PATHS = new Set(['/login', '/signup', '/forgot', '/reset', '/join', '/verify']);

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
    if (session === null && !ACCOUNT_PATHS.has(path)) navigate('/login');
    if (session && path === '/login') navigate('/');
  }, [session, path]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const cockpit = path === '/dialer';
    const apply = () => {
      document.documentElement.classList.toggle('dark', mq.matches || cockpit);
      document.documentElement.classList.toggle('cockpit-mode', cockpit);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [path]);

  if (session === undefined || auth === null) return <main className="p-8 text-sm text-muted-foreground">Loading…</main>;
  if (path === '/verify') {
    return (
      <Verify
        onDone={() => {
          loadSession(undefined, true).then((s) => {
            setSession(s);
            navigate(s ? '/' : '/login');
          });
        }}
      />
    );
  }
  if (!session || ACCOUNT_PATHS.has(path)) {
    const signupOpen = auth.mode === 'password' && auth.signup === 'open';
    let gate: React.ReactNode;
    if (path === '/signup' && signupOpen) gate = <Signup onLogin={setSession} />;
    else if (path === '/forgot' && auth.mode === 'password') gate = <Forgot />;
    else if (path === '/reset' && auth.mode === 'password') gate = <Reset onLogin={setSession} />;
    else if (path === '/join') gate = <Join onLogin={setSession} />;
    else gate = <Login onLogin={setSession} mode={auth.mode} clerkKey={auth.clerkPublishableKey} signup={auth.signup ?? 'off'} />;
    return (
      <>
        {gate}
        <Toaster />
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
  else if ((p = match(path, '/calls/:id'))) page = <CallDetail id={p.id!} />;
  else if (path === '/calls') page = <Calls />;
  else if (path === '/dialer') page = <PowerDialer />;
  else if (path === '/practice') page = <Practice />;
  else if (path === '/inbox') page = <Inbox />;
  else if (path === '/signals') page = <Signals />;
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
      <Toaster />
    </>
  );
}
