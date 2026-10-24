import { useEffect, useRef, useState } from 'react';
import { Sparkles, X, CornerDownLeft, Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { currentSession } from '../api.js';
import { Link, navigate } from '../router.js';

/**
 * The in-app assistant: a drawer that streams POST /v1/chat. It shows the model's steps as it
 * works, opens pages the reply points at, and keeps the conversation per workspace in the tab.
 */

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  steps?: Array<{ kind: 'thinking' | 'tool_call' | 'tool_result'; text: string; ok?: boolean }>;
  navigate?: string | null;
  error?: boolean;
}

const SUGGESTIONS = ['Who clicked a link this week?', 'Find the call where someone asked about pricing', 'What is due today?', 'Open the Globex account'];

async function* sse(res: Response): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (data) yield { event, data: JSON.parse(data) };
    }
  }
}

export function Assistant({ open, onOpenChange, path }: { open: boolean; onOpenChange: (o: boolean) => void; path: string }) {
  const session = currentSession();
  const key = `cooks.assistant.${session?.workspace.id ?? 'ws'}`;
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      return JSON.parse(sessionStorage.getItem(key) ?? '[]') as Msg[];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [unconfigured, setUnconfigured] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify(msgs.slice(-40)));
    } catch {}
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs, key]);
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
    else abort.current?.abort();
  }, [open]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy || !session) return;
    setInput('');
    const history = [...msgs.filter((m) => !m.error), { role: 'user' as const, content: q }];
    const draft: Msg = { role: 'assistant', content: '', steps: [] };
    setMsgs([...history, draft]);
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    const patch = (fn: (m: Msg) => Msg) => setMsgs((cur) => cur.map((m, i) => (i === cur.length - 1 ? fn(m) : m)));
    try {
      const res = await fetch('/v1/chat', {
        method: 'POST',
        headers: { authorization: `Bearer ${session.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ data: { messages: history.map((m) => ({ role: m.role, content: m.content })).slice(-20), page: path } }),
        signal: ctl.signal,
      });
      if (res.status === 422) {
        setUnconfigured(true);
        patch((m) => ({ ...m, content: 'No model is configured for this workspace yet.', error: true }));
        return;
      }
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        patch((m) => ({ ...m, content: j.error?.message ?? `Request failed (${res.status})`, error: true }));
        return;
      }
      for await (const ev of sse(res)) {
        const d = ev.data as Record<string, unknown>;
        if (ev.event === 'thinking') patch((m) => ({ ...m, steps: [...(m.steps ?? []), { kind: 'thinking', text: String(d.text) }] }));
        else if (ev.event === 'tool_call') patch((m) => ({ ...m, steps: [...(m.steps ?? []), { kind: 'tool_call', text: String(d.name).replace(/^cooks_/, '').replace(/_/g, ' ') }] }));
        else if (ev.event === 'tool_result') patch((m) => ({ ...m, steps: [...(m.steps ?? []), { kind: 'tool_result', text: String(d.summary), ok: Boolean(d.ok) }] }));
        else if (ev.event === 'reply') {
          const to = typeof d.navigate === 'string' ? d.navigate : null;
          patch((m) => ({ ...m, content: String(d.text), navigate: to }));
          if (to) navigate(to);
        } else if (ev.event === 'error') patch((m) => ({ ...m, content: String(d.message), error: true }));
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') patch((m) => ({ ...m, content: (e as Error).message, error: true }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };

  return (
    <aside
      className={cn('fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l bg-background shadow-xl transition-transform duration-200', open ? 'translate-x-0' : 'translate-x-full')}
      aria-hidden={!open}
      data-testid="assistant"
    >
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Sparkles className="size-4" />
        <span className="text-sm font-medium">Assistant</span>
        <span className="text-xs text-muted-foreground">works in your workspace, with your permissions</span>
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label="Close" onClick={() => onOpenChange(false)}>
          <X className="size-4" />
        </Button>
      </header>
      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4" data-testid="assistant-log">
        {msgs.length === 0 && (
          <div className="grid gap-2">
            <p className="text-sm text-muted-foreground">Ask about your pipeline or tell it what to do. It can look things up, open pages, and act with your account. Anything that sends, dials or deletes is confirmed with you first.</p>
            <div className="flex flex-wrap gap-2 pt-1">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => ask(s)} className="rounded-full border px-3 py-1 text-xs hover:bg-muted" data-testid="assistant-suggestion">
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={cn('text-sm', m.role === 'user' ? 'ml-8 rounded-lg bg-muted px-3 py-2' : '')} data-testid={`assistant-${m.role}`}>
            {m.steps && m.steps.length > 0 && (
              <ol className="mb-2 space-y-1 text-xs text-muted-foreground">
                {m.steps.map((s, j) => (
                  <li key={j} className="flex items-start gap-1.5">
                    {s.kind === 'tool_result' ? s.ok ? <CheckCircle2 className="mt-0.5 size-3 shrink-0" /> : <XCircle className="mt-0.5 size-3 shrink-0" /> : <span className="mt-0.5 inline-block size-3 shrink-0 text-center leading-none">{s.kind === 'tool_call' ? '→' : '·'}</span>}
                    <span className={cn('min-w-0', s.kind === 'tool_call' && 'font-medium text-foreground')}>{s.text}</span>
                  </li>
                ))}
              </ol>
            )}
            {m.content ? <p className={cn('whitespace-pre-wrap leading-relaxed', m.error && 'text-muted-foreground')}>{m.content}</p> : busy && i === msgs.length - 1 ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
            {m.navigate && (
              <Link to={m.navigate} className="mt-1 inline-block text-xs underline underline-offset-4">
                Open {m.navigate}
              </Link>
            )}
          </div>
        ))}
        {unconfigured && (
          <p className="text-xs text-muted-foreground">
            Add a model provider under{' '}
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={() => {
                onOpenChange(false);
                navigate('/settings?tab=ai');
              }}
            >
              Settings → Hosted AI
            </button>
            . Any provider works, including a local one.
          </p>
        )}
      </div>
      <form
        className="border-t p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <div className="flex items-end gap-2 rounded-lg border bg-background px-3 py-2 focus-within:ring-[3px] focus-within:ring-ring/50">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            rows={1}
            placeholder={busy ? 'Working…' : 'Ask or tell it what to do'}
            disabled={busy}
            className="max-h-32 min-h-6 w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            data-testid="assistant-input"
          />
          <Button type="submit" size="icon-sm" variant="ghost" disabled={busy || !input.trim()} aria-label="Send">
            <CornerDownLeft className="size-4" />
          </Button>
        </div>
        <div className="mt-1 flex justify-between px-1 text-[11px] text-muted-foreground">
          <span>Enter to send, Shift+Enter for a new line</span>
          {msgs.length > 0 && (
            <button type="button" className="underline-offset-4 hover:underline" onClick={() => setMsgs([])}>
              Clear
            </button>
          )}
        </div>
      </form>
    </aside>
  );
}
