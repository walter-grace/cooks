import { useEffect, useState } from 'react';
import { ClerkProvider, SignIn, useAuth, useUser } from '@clerk/clerk-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { loadSession, type Session } from '../api.js';
import { Link, navigate } from '../router.js';
import { AccountShell } from '../components/account-shell.js';

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

export function Login({ onLogin, mode, clerkKey, signup = 'off' }: { onLogin: (s: Session) => void; mode: 'password' | 'clerk'; clerkKey: string | null; signup?: 'open' | 'invite' | 'off' | 'clerk' }) {
  if (mode === 'clerk' && clerkKey) {
    return (
      <ClerkProvider publishableKey={clerkKey} afterSignOutUrl="/app/login" signInUrl="/app/login" signInFallbackRedirectUrl={location.pathname + location.search}>
        <ClerkBridge onLogin={onLogin} />
      </ClerkProvider>
    );
  }
  return <PasswordLogin onLogin={onLogin} signup={signup} />;
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
    <AccountShell>
      <div className="grid justify-items-center gap-4">
        {!isSignedIn && <SignIn routing="hash" />}
        {isSignedIn && !err && <p className="text-sm text-muted-foreground">Signed in as {user?.primaryEmailAddress?.emailAddress}. Opening Cooks…</p>}
        {err && (
          <Alert variant="destructive">
            <AlertDescription>{err}</AlertDescription>
          </Alert>
        )}
      </div>
    </AccountShell>
  );
}

function PasswordLogin({ onLogin, signup }: { onLogin: (s: Session) => void; signup: 'open' | 'invite' | 'off' | 'clerk' }) {
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
    <AccountShell>
      <Card className="w-full">
        <CardHeader>
          <CardTitle className="text-xl">Sign in</CardTitle>
          <CardDescription>Welcome back. Use the email and password you signed up with.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={submit} data-testid="login-form">
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus autoComplete="email" />
            </div>
            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">Password</Label>
                <Link to="/forgot" className="text-xs text-muted-foreground underline underline-offset-4" data-testid="login-forgot">Forgot password?</Link>
              </div>
              <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
            </div>
            {err && (
              <Alert variant="destructive">
                <AlertDescription>{err}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy}>
              Sign in
            </Button>
          </form>
          {signup === 'open' ? (
            <div className="mt-6 border-t pt-5">
              <p className="text-sm font-medium">New to Cooks?</p>
              <p className="mt-1 text-xs text-muted-foreground">Create a workspace for your team. It takes a minute, you will be its admin, and you can invite people right after.</p>
              <Button asChild variant="outline" className="mt-3 w-full">
                <Link to="/signup" data-testid="login-signup">Create a workspace</Link>
              </Button>
            </div>
          ) : (
            <p className="mt-6 border-t pt-5 text-xs text-muted-foreground">
              {signup === 'invite' ? 'New here? Ask a workspace admin for an invite link; it creates your account and adds you to their workspace.' : <>No account yet? Run <code>pnpm bootstrap --email you@example.com --password …</code> on the server, or set COOKS_SIGNUP=open.</>}
            </p>
          )}
        </CardContent>
      </Card>
    </AccountShell>
  );
}
