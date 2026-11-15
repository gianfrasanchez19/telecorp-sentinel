import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export interface Async<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  reload: () => void;
}

/** Carga datos de la API con estados de carga/error y recarga opcional periódica. */
export function useApi<T>(path: string | null, opts: { auth?: boolean; refreshMs?: number } = {}): Async<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(!!path);
  const [n, setN] = useState(0);
  const alive = useRef(true);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    alive.current = true;
    if (!path) return;
    setLoading(true);
    api<T>(path, { auth: opts.auth })
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError(undefined);
      })
      .catch((e: ApiError) => alive.current && setError(e))
      .finally(() => alive.current && setLoading(false));
    return () => {
      alive.current = false;
    };
  }, [path, n, opts.auth]);
  useEffect(() => {
    if (!opts.refreshMs) return;
    const t = setInterval(reload, opts.refreshMs);
    return () => clearInterval(t);
  }, [opts.refreshMs, reload]);
  return { data, error, loading, reload };
}
