import { useState } from 'react';
import { loadSession, type Session } from '../api.js';
import { navigate } from '../router.js';

export function Login({ onLogin }: { onLogin: (s: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, next: '/app' }), redirect: 'manual', credentials: 'same-origin' });
    if (res.status === 401) {
      setErr('Email or password is incorrect');
      setBusy(false);
      return;
    }
    const s = await loadSession(undefined, true);
    setBusy(false);
    if (s) {
      onLogin(s);
      navigate('/');
    }
    else setErr('Signed in, but no workspace membership was found.');
  };
  return (
    <div className="login card">
      <h1>Sign in to Cooks</h1>
      <form className="stack" onSubmit={submit}>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        </label>
        <label className="field">
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {err && <div className="err">{err}</div>}
        <button className="primary" disabled={busy}>
          Sign in
        </button>
      </form>
      <p className="small muted">
        No password yet? Run <code>pnpm bootstrap --email you@example.com --password ...</code> on the server.
      </p>
    </div>
  );
}
