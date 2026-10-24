import { useEffect, useState } from 'react';
import { CheckSquare, Users, GitBranch, Mail, Mic, Phone, PhoneForwarded, Radar, Inbox as InboxIcon, Settings as SettingsIcon, BookOpen, LogOut, Search, Sparkles } from 'lucide-react';
import { CommandPalette } from '@/components/command-palette';
import { Assistant } from '@/components/assistant';
import { toast } from '../hooks.js';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';
import { Link } from '../router.js';
import type { Session } from '../api.js';

const NAV = [
  { to: '/', label: 'Tasks', icon: CheckSquare },
  { to: '/prospects', label: 'Prospects', icon: Users },
  { to: '/sequences', label: 'Sequences', icon: GitBranch },
  { to: '/emails', label: 'Emails', icon: Mail },
  { to: '/inbox', label: 'Inbox', icon: InboxIcon },
  { to: '/signals', label: 'Signals', icon: Radar },
  { to: '/calls', label: 'Calls', icon: Phone },
  { to: '/dialer', label: 'Power dialer', icon: PhoneForwarded },
  { to: '/practice', label: 'Practice', icon: Mic },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function Shell({ session, path, onSwitchWorkspace, onLogout, children }: { session: Session; path: string; onSwitchWorkspace: (id: string) => void; onLogout: () => void; children: React.ReactNode }) {
  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
  const [searchOpen, setSearchOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setAssistantOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const initials = session.user.name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="min-h-screen md:grid md:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="sticky top-0 flex h-auto flex-col gap-1 border-b bg-sidebar p-3 text-sidebar-foreground md:h-screen md:border-r md:border-b-0">
        <div className="flex items-center gap-2 px-2 py-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-bold">C</div>
          <span className="font-semibold tracking-tight">Cooks</span>
        </div>
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="mb-1 flex h-9 shrink-0 items-center gap-2 rounded-md border bg-background px-2.5 text-sm text-muted-foreground hover:bg-sidebar-accent md:w-full"
          data-testid="search-open"
        >
          <Search className="size-4" />
          <span>Search</span>
          <kbd className="ml-auto hidden rounded border px-1.5 font-mono text-[10px] md:block">⌘K</kbd>
        </button>
        <button
          type="button"
          onClick={() => setAssistantOpen(true)}
          className="mb-1 flex h-9 shrink-0 items-center gap-2 rounded-md border bg-background px-2.5 text-sm text-muted-foreground hover:bg-sidebar-accent md:w-full"
          data-testid="assistant-open"
        >
          <Sparkles className="size-4" />
          <span>Assistant</span>
          <kbd className="ml-auto hidden rounded border px-1.5 font-mono text-[10px] md:block">⌘J</kbd>
        </button>
        <nav className="flex flex-row gap-1 overflow-x-auto [scrollbar-width:none] md:flex-col md:overflow-visible" data-testid="nav">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className={cn('flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-sidebar-accent', active(to) ? 'bg-sidebar-accent font-medium' : 'text-muted-foreground')}>
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
          <a href="/docs" target="_blank" rel="noreferrer" className="flex shrink-0 items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent">
            <BookOpen className="size-4" />
            API docs
          </a>
        </nav>
        <div className="hidden flex-1 md:block" />
        <Separator className="my-2 hidden md:block" />
        <div className="hidden md:block">
          {session.workspaces.length > 1 && (
            <Select value={session.workspace.id} onValueChange={onSwitchWorkspace}>
              <SelectTrigger className="mb-2 w-full" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {session.workspaces.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <div className="flex items-center gap-2 px-1 py-1">
            <Avatar className="size-8">
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 text-xs">
              <div className="truncate font-medium">{session.user.name}</div>
              <div className="truncate text-muted-foreground">
                {session.workspace.name} · {session.workspace.role}
              </div>
            </div>
            <Button variant="ghost" size="icon" aria-label="Sign out" onClick={onLogout}>
              <LogOut className="size-4" />
            </Button>
          </div>
        </div>
      </aside>
      <div className="min-w-0">
        {session.user.emailVerified === false && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted px-4 py-2 text-sm md:px-8" data-testid="verify-banner">
            <span>Confirm your email address. We sent a link to {session.user.email}.</span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                fetch('/auth/verify/resend', { method: 'POST', credentials: 'same-origin' })
                  .then((r) => (r.ok ? toast('Sent. Check your inbox.') : toast('Could not send right now', 'error')))
                  .catch(() => toast('Could not send right now', 'error'))
              }
            >
              Resend
            </Button>
          </div>
        )}
        <main className="mx-auto w-full min-w-0 max-w-6xl p-4 md:p-8">{children}</main>
      </div>
      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <Assistant open={assistantOpen} onOpenChange={setAssistantOpen} path={path} />
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div data-testid="empty" className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

const GOOD = new Set(['active', 'sent', 'delivered', 'connected', 'ready', 'completed', 'replied', 'enabled', 'answered', 'meeting_booked']);
const WAIT = new Set(['paused', 'queued', 'draft', 'pending', 'pending_start', 'scheduled', 'in_progress', 'ringing', 'dialing', 'processing']);
const BAD = new Set(['rejected', 'failed', 'bounced', 'dropped', 'disabled', 'error', 'canceled', 'cancelled', 'do_not_call', 'busy']);

/** State as weight: filled for good, soft for waiting, outlined for bad, quiet for the rest. */
export function StateBadge({ state }: { state: string }) {
  const tone = GOOD.has(state) ? 'solid' : WAIT.has(state) ? 'soft' : BAD.has(state) ? 'strong' : 'quiet';
  return (
    <span
      data-state={state}
      className={cn(
        'inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium',
        tone === 'solid' && 'border-transparent bg-foreground text-background',
        tone === 'soft' && 'border-transparent bg-muted text-foreground',
        tone === 'strong' && 'border-foreground text-foreground',
        tone === 'quiet' && 'text-muted-foreground',
      )}
    >
      {state.replace(/_/g, ' ')}
    </span>
  );
}
