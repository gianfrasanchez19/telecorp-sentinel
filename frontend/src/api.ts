/** Cliente de la API (contrato uniforme { data, meta } / { error, meta }). */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
    public requestId?: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'tcs.operator';

export interface Session {
  token: string;
  expiresAt: string;
  user: { username: string; displayName: string; role: string };
}

export function getSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (new Date(s.expiresAt).getTime() < Date.now()) {
      sessionStorage.removeItem(TOKEN_KEY);
      return null;
    }
    return s;
  } catch {
    return null;
  }
}
export function setSession(s: Session | null): void {
  try {
    if (s) sessionStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

export async function api<T>(path: string, opts: { method?: string; body?: unknown; auth?: boolean; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.auth) {
    const s = getSession();
    if (s) headers.authorization = `Bearer ${s.token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: opts.method ?? 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new ApiError(0, 'NETWORK', 'No se pudo conectar con la API. Verifique su conexión o que el servicio esté activo.');
  }
  const json = (await res.json().catch(() => null)) as { data?: T; error?: { code: string; message: string; details?: unknown }; meta?: { requestId: string } } | null;
  if (!res.ok) {
    if (res.status === 401 && opts.auth) setSession(null);
    throw new ApiError(res.status, json?.error?.code ?? 'HTTP', json?.error?.message ?? (res.status === 401 ? 'Sesión expirada o no autorizada' : `Error HTTP ${res.status}`), json?.error?.details, json?.meta?.requestId);
  }
  return json?.data as T;
}

export const fmtDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' }) : '—');
export const fmtNum = (n?: number | null, d = 0) => (n === null || n === undefined ? '—' : n.toLocaleString('es-PE', { maximumFractionDigits: d }));
