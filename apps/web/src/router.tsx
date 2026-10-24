import { useEffect, useState } from 'react';

const BASE = '/app';

export function useRoute() {
  const [path, setPath] = useState(() => location.pathname.replace(new RegExp(`^${BASE}`), '') || '/');
  useEffect(() => {
    const onPop = () => setPath(location.pathname.replace(new RegExp(`^${BASE}`), '') || '/');
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

export function navigate(to: string) {
  history.pushState(null, '', `${BASE}${to}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function Link({ to, children, className, ...rest }: { to: string; children: React.ReactNode; className?: string } & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick' | 'className' | 'children'>) {
  return (
    <a
      {...rest}
      href={`${BASE}${to}`}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function match(path: string, pattern: string): Record<string, string> | null {
  const a = path.split('/').filter(Boolean);
  const b = pattern.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < b.length; i++) {
    const seg = b[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(a[i]!);
    else if (seg !== a[i]) return null;
  }
  return params;
}
