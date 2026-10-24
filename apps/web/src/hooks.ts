import { useCallback, useEffect, useState } from 'react';
import { toast as sonner } from 'sonner';
import { api, ApiError } from './api.js';

export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    api<T>(path)
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: ApiError) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, tick, ...deps]);
  return { data, error, loading, reload };
}

export const toast = (msg: string, kind: 'success' | 'error' | 'info' = 'success') => (kind === 'error' ? sonner.error(msg) : kind === 'info' ? sonner.info(msg) : sonner.success(msg));

export function useAuthConfig() {
  const [cfg, setCfg] = useState<{ mode: 'password' | 'clerk'; clerkPublishableKey: string | null; signup?: 'open' | 'invite' | 'off' | 'clerk' } | null>(null);
  useEffect(() => {
    fetch('/auth/config')
      .then((r) => r.json())
      .then(setCfg)
      .catch(() => setCfg({ mode: 'password', clerkPublishableKey: null, signup: 'off' }));
  }, []);
  return cfg;
}
