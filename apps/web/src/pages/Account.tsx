import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { loadSession, type Session } from '../api.js';
import { Link, navigate } from '../router.js';

/** Sign-up, password reset, invite acceptance and email verification. All talk to /auth/* directly, no bearer token. */

async function post(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
  const json = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string; [k: string]: unknown };
  if (!res.ok) throw new Error(json.error_description ?? `Request failed (${res.status})`);
  return json;
}
const tokenParam = () => new URLSearchParams(location.search).get('token') ?? '';

function Frame({ title, description, children, testid }: { title: string; description?: string; children: React.ReactNode; testid?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm" data-testid={testid}>
        <CardHeader>
          <CardTitle className="text-xl">{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}
const Err = ({ msg }: { msg: string | null }) =>
  msg ? (
    <Alert variant="destructive">
      <AlertDescription>{msg}</AlertDescription>
    </Alert>
  ) : null;

export function Signup({ onLogin }: { onLogin: (s: Session) => void }) {
  const [f, setF] = useState({ name: '', email: '', password: '', workspaceName: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post('/auth/signup', f);
      const s = await loadSession(undefined, true);
      if (s) {
        onLogin(s);
        navigate('/');
      } else setErr('Account created, but the session could not be opened. Try signing in.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Create your workspace" description="You will be its admin. Invite the team from Settings afterwards." testid="signup">
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-2">
          <Label htmlFor="su-name">Your name</Label>
          <Input id="su-name" value={f.name} onChange={set('name')} required autoFocus autoComplete="name" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="su-ws">Workspace name</Label>
          <Input id="su-ws" value={f.workspaceName} onChange={set('workspaceName')} placeholder="Acme Sales" required autoComplete="organization" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="su-email">Work email</Label>
          <Input id="su-email" type="email" value={f.email} onChange={set('email')} required autoComplete="email" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="su-pw">Password</Label>
          <Input id="su-pw" type="password" value={f.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />
          <p className="text-xs text-muted-foreground">At least 10 characters.</p>
        </div>
        <Err msg={err} />
        <Button type="submit" disabled={busy}>
          Create workspace
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Already have an account? <Link to="/login" className="underline underline-offset-4">Sign in</Link>
        </p>
      </form>
    </Frame>
  );
}

export function Forgot() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await post('/auth/password/forgot', { email }).catch(() => undefined);
    setBusy(false);
    setDone(true);
  };
  return (
    <Frame title="Reset your password" description="We will email you a link that works for one hour." testid="forgot">
      {done ? (
        <p className="text-sm">If an account exists for {email}, the link is on its way. Check your inbox.</p>
      ) : (
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="fg-email">Email</Label>
            <Input id="fg-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <Button type="submit" disabled={busy}>
            Send the link
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            <Link to="/login" className="underline underline-offset-4">Back to sign in</Link>
          </p>
        </form>
      )}
    </Frame>
  );
}

export function Reset({ onLogin }: { onLogin: (s: Session) => void }) {
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post('/auth/password/reset', { token: tokenParam(), password });
      const s = await loadSession(undefined, true);
      if (s) onLogin(s);
      navigate('/');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Frame title="Choose a new password" testid="reset">
      <form className="grid gap-4" onSubmit={submit}>
        <div className="grid gap-2">
          <Label htmlFor="rs-pw">New password</Label>
          <Input id="rs-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoFocus autoComplete="new-password" />
        </div>
        <Err msg={err} />
        <Button type="submit" disabled={busy}>
          Save and sign in
        </Button>
      </form>
    </Frame>
  );
}

export function Join({ onLogin }: { onLogin: (s: Session) => void }) {
  const [info, setInfo] = useState<{ email: string; role: string; workspaceName: string; existingUser: boolean } | null | undefined>(undefined);
  const [f, setF] = useState({ name: '', password: '' });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    fetch(`/auth/invite/${encodeURIComponent(tokenParam())}`, { credentials: 'same-origin' })
      .then(async (r) => setInfo(r.ok ? await r.json() : null))
      .catch(() => setInfo(null));
  }, []);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = (await post('/auth/invite/accept', { token: tokenParam(), ...f })) as { workspaceId: string };
      const s = await loadSession(r.workspaceId, true);
      if (s) onLogin(s);
      navigate('/');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (info === undefined) return <Frame title="Checking your invite…"> </Frame>;
  if (info === null)
    return (
      <Frame title="This invite is not valid" description="It may have expired or been used already. Ask the person who invited you for a new link." testid="join-invalid">
        <Link to="/login" className="text-sm underline underline-offset-4">Sign in instead</Link>
      </Frame>
    );
  return (
    <Frame title={`Join ${info.workspaceName}`} description={`${info.email} · ${info.role}`} testid="join">
      <form className="grid gap-4" onSubmit={submit}>
        {!info.existingUser && (
          <>
            <div className="grid gap-2">
              <Label htmlFor="jn-name">Your name</Label>
              <Input id="jn-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus autoComplete="name" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="jn-pw">Choose a password</Label>
              <Input id="jn-pw" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={10} autoComplete="new-password" />
            </div>
          </>
        )}
        {info.existingUser && <p className="text-sm text-muted-foreground">You already have a Cooks account with this address. Accepting adds {info.workspaceName} to it.</p>}
        <Err msg={err} />
        <Button type="submit" disabled={busy}>
          {info.existingUser ? 'Join workspace' : 'Create account and join'}
        </Button>
      </form>
    </Frame>
  );
}

export function Verify({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<'working' | 'ok' | 'bad'>('working');
  useEffect(() => {
    post('/auth/verify', { token: tokenParam() })
      .then(() => setState('ok'))
      .catch(() => setState('bad'));
  }, []);
  useEffect(() => {
    if (state !== 'ok') return;
    const t = setTimeout(onDone, 1200);
    return () => clearTimeout(t);
  }, [state, onDone]);
  return (
    <Frame title={state === 'working' ? 'Confirming your email…' : state === 'ok' ? 'Email confirmed' : 'That link did not work'} testid={`verify-${state}`}>
      {state === 'ok' && <p className="text-sm text-muted-foreground">Taking you to Cooks.</p>}
      {state === 'bad' && (
        <p className="text-sm text-muted-foreground">
          The link may have expired or been used already. <Link to="/login" className="underline underline-offset-4">Sign in</Link> and request a new one from the banner.
        </p>
      )}
    </Frame>
  );
}
