import { useEffect, useState } from 'react';
import { ClerkProvider, SignIn, useAuth, useUser } from '@clerk/clerk-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { loadSession, type Session } from '../api.js';
import { navigate } from '../router.js';

/** `?next=` is set when an OAuth consent screen (a Claude or Grok connector) sent the user here to sign in. Same-origin paths only. */
function nextAfterLogin(): string | null {
  const n = new URLSearchParams(location.search).get('next');
  return n && n.startsWith('/') && !n.startsWith('//') ? n : null;
}
function finishLogin() {
  const n = nextAfterLogin();
  if (n) location.assign(n);
  else navigate('/');
}

export function Login({ onLogin, mode, clerkKey }: { onLogin: (s: Session) => void; mode: 'password' | 'clerk'; clerkKey: string | null }) {
  if (mode === 'clerk' && clerkKey) {
    return (
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/app/login" signInUrl="/app/login" signInFallbackRedirectUrl={location.pathname + location.search}>
        <ClerkBridge onLogin={onLogin} />
      </ClerkProvider>
    );
  }
  return <PasswordLogin onLogin={onLogin} />;
}

/** After Clerk sign-in, exchange the Clerk session for a Cooks session cookie. */
function ClerkBridge({ onLogin }: { onLogin: (s: Session) => void }) {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    (async () => {
      const token = await getToken();
      const res = await fetch('/auth/clerk/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }), credentials: 'same-origin' });
      if (!res.ok) {
        setErr((await res.json().catch(() => ({}))).error_description ?? 'Could not establish a Cooks session');
        return;
      }
      const s = await loadSession(undefined, true);
      if (s) {
        onLogin(s);
        finishLogin();
      }
    })();
  }, [isLoaded, isSignedIn, getToken, onLogin]);
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 p-4">
      {!isSignedIn && <SignIn routing="hash" />}
      {isSignedIn && !err && <p className="text-sm text-muted-foreground">Signed in as {user?.primaryEmailAddress?.emailAddress}. Opening Cooks…</p>}
      {err && (
        <Alert variant="destructive">
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

function PasswordLogin({ onLogin }: { onLogin: (s: Session) => void }) {
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
      finishLogin();
    } else setErr('Signed in, but no workspace membership was found.');
  };
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign in to Cooks</CardTitle>
          <CardDescription>Open-source sales engagement</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={submit} data-testid="login-form">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {err && (
              <Alert variant="destructive">
                <AlertDescription>{err}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy}>
              Sign in
            </Button>
            <p className="text-xs text-muted-foreground">
              No password yet? Run <code>pnpm bootstrap --email you@example.com --password …</code> on the server, or configure Clerk SSO.
            </p>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
