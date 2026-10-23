import { CheckSquare, Users, GitBranch, Mail, Phone, PhoneForwarded, Radar, Inbox as InboxIcon, Settings as SettingsIcon, BookOpen, LogOut } from 'lucide-react';
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
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
] as const;

export function Shell({ session, path, onSwitchWorkspace, onLogout, children }: { session: Session; path: string; onSwitchWorkspace: (id: string) => void; onLogout: () => void; children: React.ReactNode }) {
  const active = (to: string) => (to === '/' ? path === '/' : path.startsWith(to));
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
        <nav className="flex flex-row flex-wrap gap-1 md:flex-col" data-testid="nav">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link key={to} to={to} className={cn('flex items-center gap-2 rounded-md px-2.5 py-2 text-sm transition-colors hover:bg-sidebar-accent', active(to) ? 'bg-sidebar-accent font-medium' : 'text-muted-foreground')}>
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
          <a href="/docs" target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-sidebar-accent">
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
      <main className="mx-auto w-full min-w-0 max-w-6xl p-4 md:p-8">{children}</main>
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

export function StateBadge({ state }: { state: string }) {
  const tone = state === 'active' || state === 'sent' || state === 'finished' && false ? 'default' : state === 'paused' || state === 'queued' || state === 'draft' ? 'secondary' : state === 'rejected' || state === 'failed' ? 'destructive' : 'outline';
  return <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', tone === 'default' && 'border-transparent bg-emerald-600/15 text-emerald-700 dark:text-emerald-300', tone === 'secondary' && 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300', tone === 'destructive' && 'border-transparent bg-destructive/15 text-destructive', tone === 'outline' && 'text-muted-foreground')}>{state}</span>;
}
