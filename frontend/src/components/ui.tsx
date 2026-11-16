import type { ReactNode } from 'react';
import type { ApiError } from '../api';

export const ANTENNA_STATUS: Record<string, { color: string; label: string; plural: string; icon: string }> = {
  NORMAL: { color: 'var(--good)', label: 'Normal', plural: 'normales', icon: '●' },
  SATURADA: { color: 'var(--warning)', label: 'Saturada', plural: 'saturadas', icon: '▲' },
  CAIDA: { color: 'var(--serious)', label: 'Caída', plural: 'caídas', icon: '▼' },
  INHABILITADA: { color: 'var(--critical)', label: 'Inhabilitada', plural: 'inhabilitadas', icon: '✕' },
  SIN_DATOS: { color: 'var(--nodata)', label: 'Sin datos', plural: 'sin datos', icon: '?' },
};

export function AntennaBadge({ status }: { status: string }) {
  const s = ANTENNA_STATUS[status] ?? ANTENNA_STATUS.SIN_DATOS;
  return (
    <span className="badge" title={`Estado de antena: ${s.label}`}>
      <span aria-hidden="true" style={{ color: s.color }}>
        {s.icon}
      </span>
      {s.label}
    </span>
  );
}

const CASE: Record<string, string> = { REGISTRADA: 'Registrada', EN_REVISION: 'En revisión', EN_ATENCION: 'En atención', SOLUCIONADA: 'Solucionada', CERRADA: 'Cerrada' };
export const caseLabel = (s: string) => CASE[s] ?? s;
export function CaseBadge({ status }: { status: string }) {
  const color = status === 'SOLUCIONADA' || status === 'CERRADA' ? 'var(--good)' : status === 'EN_ATENCION' ? 'var(--accent)' : 'var(--nodata)';
  return (
    <span className="badge">
      <span className="dot" style={{ background: color }} aria-hidden="true" />
      {caseLabel(status)}
    </span>
  );
}

const PRIO: Record<string, { color: string; icon: string }> = {
  CRITICA: { color: 'var(--critical)', icon: '‼' },
  ALTA: { color: 'var(--serious)', icon: '!' },
  MEDIA: { color: 'var(--warning)', icon: '•' },
  BAJA: { color: 'var(--nodata)', icon: '·' },
};
const PRIO_LABEL: Record<string, string> = { CRITICA: 'Crítica', ALTA: 'Alta', MEDIA: 'Media', BAJA: 'Baja' };
export function PriorityBadge({ level, score }: { level?: string; score?: number }) {
  if (!level) return <span className="badge">Sin calcular</span>;
  const p = PRIO[level];
  return (
    <span className="badge" title={`Prioridad ${level}${score !== undefined ? `, puntaje ${score}/100` : ''}`}>
      <span aria-hidden="true" style={{ color: p.color, fontWeight: 800 }}>
        {p.icon}
      </span>
      {PRIO_LABEL[level] ?? level}
      {score !== undefined && <span className="muted">· {score}</span>}
    </span>
  );
}

export function SyntheticBadge({ show = true }: { show?: boolean }) {
  return show ? <span className="badge synthetic" title="Dato sintético generado por el simulador">Sintético</span> : null;
}

export function Loading({ label = 'Cargando…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="state">{children}</div>;
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <p>{error.message}</p>
      {error.requestId && (
        <p className="muted">
          requestId: <code>{error.requestId}</code>
        </p>
      )}
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          Reintentar
        </button>
      )}
    </div>
  );
}

export function Kpi({ label, value, hint, icon }: { label: string; value: ReactNode; hint?: string; icon?: ReactNode }) {
  return (
    <div className="kpi">
      <div className="label">
        {icon}
        {label}
      </div>
      <div className="value">{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
