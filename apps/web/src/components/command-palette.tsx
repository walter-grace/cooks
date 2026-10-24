import { useEffect, useRef, useState } from 'react';
import { Phone, Users, Building2, Radar, Mail, StickyNote, CheckSquare, GitBranch, MessageSquareText, Search } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { api, q as qs } from '../api.js';
import { fmtDate } from '../api.js';
import { navigate } from '../router.js';

export interface Hit {
  id: string;
  type: 'prospect' | 'account' | 'call' | 'transcript' | 'signal' | 'email' | 'note' | 'task' | 'sequence';
  title: string;
  snippet: string;
  href: string;
  occurredAt: string;
  meta: Record<string, unknown>;
}

const KIND: Record<Hit['type'], { label: string; icon: typeof Phone }> = {
  prospect: { label: 'Prospect', icon: Users },
  account: { label: 'Account', icon: Building2 },
  call: { label: 'Call', icon: Phone },
  transcript: { label: 'Transcript', icon: MessageSquareText },
  signal: { label: 'Signal', icon: Radar },
  email: { label: 'Email', icon: Mail },
  note: { label: 'Note', icon: StickyNote },
  task: { label: 'Task', icon: CheckSquare },
  sequence: { label: 'Sequence', icon: GitBranch },
};

/** Render « » markers from ts_headline as emphasis. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g).filter(Boolean);
  return (
    <span className="line-clamp-2 text-xs text-muted-foreground">
      {parts.map((p, i) => (p.startsWith('«') ? <mark key={i} className="rounded-sm bg-foreground/10 px-0.5 font-medium text-foreground">{p.slice(1, -1)}</mark> : <span key={i}>{p}</span>))}
    </span>
  );
}

/** Opens on ⌘K / Ctrl+K and the sidebar button; searches everything in the workspace as you type. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setActive(0);
    setError(null);
  }, [open]);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setHits([]);
      setBusy(false);
      return;
    }
    const mine = ++seq.current;
    setBusy(true);
    const t = window.setTimeout(() => {
      api<{ data: Hit[] }>(`/v1/search${qs({ q: term, limit: 20 })}`)
        .then((r) => {
          if (seq.current !== mine) return;
          setHits(r.data);
          setActive(0);
          setError(null);
        })
        .catch((e: Error) => seq.current === mine && setError(e.message))
        .finally(() => seq.current === mine && setBusy(false));
    }, 140);
    return () => window.clearTimeout(t);
  }, [query]);

  const go = (h: Hit) => {
    onOpenChange(false);
    navigate(h.href);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(hits.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && hits[active]) {
      e.preventDefault();
      go(hits[active]);
    }
  };
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl" showCloseButton={false} onKeyDown={onKey} data-testid="palette">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex items-center gap-3 border-b px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search prospects, calls, emails, signals…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-testid="palette-input"
            aria-label="Search"
          />
          <kbd className="hidden rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:block">esc</kbd>
        </div>
        <ul ref={listRef} className="max-h-[60vh] overflow-y-auto py-2" role="listbox" data-testid="palette-results">
          {error && <li className="px-4 py-6 text-center text-sm">{error}</li>}
          {!error && query.trim() && !busy && hits.length === 0 && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing matches “{query.trim()}”.</li>}
          {!query.trim() && <li className="px-4 py-6 text-center text-sm text-muted-foreground">Type a name, a company, a phrase from a call, a subject line.</li>}
          {hits.map((h, i) => {
            const k = KIND[h.type] ?? KIND.prospect;
            const Icon = k.icon;
            return (
              <li
                key={h.id}
                data-i={i}
                role="option"
                aria-selected={i === active}
                onMouseMove={() => active !== i && setActive(i)}
                onClick={() => go(h)}
                className={cn('mx-2 flex cursor-pointer items-start gap-3 rounded-md px-3 py-2', i === active && 'bg-muted')}
                data-testid="palette-hit"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-sm font-medium">{h.title}</span>
                    <span className="ml-auto shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">{k.label}</span>
                  </div>
                  {h.snippet && h.snippet.replace(/[«»]/g, '').trim() !== h.title.replace(/…$/, '').trim() && <Snippet text={h.snippet} />}
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{[typeof h.meta.who === 'string' ? h.meta.who : null, fmtDate(h.occurredAt)].filter(Boolean).join(' · ')}</div>
                </div>
              </li>
            );
          })}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
