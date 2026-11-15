import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, fmtDate, fmtNum } from '../api';
import { AntennaBadge, CaseBadge, caseLabel, Empty, ErrorState, Loading, PriorityBadge, SyntheticBadge } from '../components/ui';
import { useApi } from '../hooks';
import type { IncidentDetail } from '../types';

const FACTOR_LABEL: Record<string, string> = {
  REPORTANTES_UNICOS: 'Reportantes únicos',
  USUARIOS_ESTIMADOS: 'Usuarios potencialmente afectados (estimado)',
  CRITICIDAD_ZONA: 'Criticidad de la zona',
  GRAVEDAD_ANTENAS: 'Gravedad de antenas',
  DURACION: 'Duración',
};

const NOTIF_LABEL: Record<string, string> = {
  PENDIENTE: 'Pendiente',
  ENVIANDO: 'Enviando',
  ACEPTADA_PROVEEDOR: 'Aceptada por el proveedor',
  FALLIDA_REINTENTABLE: 'Falló (se reintentará)',
  FALLIDA: 'Fallida',
  INCIERTA: 'Incierta (respuesta perdida)',
  OMITIDA: 'Omitida',
};

export default function IncidentDetailPage() {
  const { id } = useParams();
  const d = useApi<IncidentDetail>(`/operator/incidents/${id}`, { auth: true, refreshMs: 15_000 });
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();

  if (d.loading && !d.data) return <Loading />;
  if (d.error) return <ErrorState error={d.error} onRetry={d.reload} />;
  const { incident: i, history, reports, aiAnalyses, notifications, allowedTransitions, allowedReopen } = d.data!;
  const options = [...allowedTransitions.map((s) => ({ s, reopen: false })), ...allowedReopen.map((s) => ({ s, reopen: true }))];
  const ai = aiAnalyses[0];

  async function change(e: FormEvent) {
    e.preventDefault();
    const opt = options.find((o) => `${o.s}|${o.reopen}` === to);
    if (!opt) return;
    setBusy(true);
    setMsg(undefined);
    try {
      await api(`/operator/incidents/${i.incidentId}/status`, { method: 'PATCH', auth: true, body: { status: opt.s, reason, reopen: opt.reopen, expectedVersion: i.version } });
      setMsg({ ok: true, text: `Estado actualizado a ${caseLabel(opt.s)}. Las notificaciones y la propagación a reportes se procesan en el flujo.` });
      setReason('');
      setTo('');
      d.reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p>
        <Link to="/operador/incidentes">← Incidentes</Link>
      </p>
      <div className="page-head">
        <div>
          <h1>{i.title}</h1>
          <div className="row">
            <span className="mono muted">{i.incidentId}</span>
            <CaseBadge status={i.status} />
            <PriorityBadge level={i.priority?.level} score={i.priority?.score} />
            <span className="badge">{i.kind === 'COLECTIVO' ? 'Posible incidente colectivo' : 'Infraestructura'}</span>
            <SyntheticBadge show={i.synthetic} />
          </div>
        </div>
      </div>

      {i.investigationPending && <div className="alert warn">Investigación pendiente: hay reportes coincidentes pero ninguna antena de la zona muestra anomalía. La correlación no implica causalidad.</div>}
      {i.recovery?.pendingVerification && (
        <div className="alert warn">
          Recuperación técnica detectada el {fmtDate(i.recovery.detectedAt)} ({i.recovery.policy}). El incidente NO se declara solucionado hasta que un operador lo verifique.
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <div className="label">Reportantes únicos</div>
          <div className="value">{fmtNum(i.uniqueReporters)}</div>
          <div className="hint">{i.reportCount} reportes vinculados</div>
        </div>
        <div className="kpi">
          <div className="label">Usuarios estimados</div>
          <div className="value">{fmtNum(i.estimatedUsers)}</div>
          <div className="hint">estimado de catálogo, no medido</div>
        </div>
        <div className="kpi">
          <div className="label">Zona</div>
          <div className="value" style={{ fontSize: '1.15rem' }}>
            {i.zoneName}
          </div>
          <div className="hint">{i.zoneCriticality}</div>
        </div>
        <div className="kpi">
          <div className="label">Antena(s)</div>
          <div className="value" style={{ fontSize: '1rem' }}>
            {i.currentAntennaStatus ? <AntennaBadge status={i.currentAntennaStatus} /> : '—'}
          </div>
          <div className="hint">peor: {i.worstAntennaStatus ?? '—'} · {i.antennaIds.length} vinculada(s)</div>
        </div>
        <div className="kpi">
          <div className="label">Detección</div>
          <div className="value" style={{ fontSize: '1rem' }}>
            {fmtDate(i.openedAt)}
          </div>
          <div className="hint">1.ª evidencia {fmtDate(i.firstEvidenceAt)}</div>
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: '1rem' }}>
        <div className="stack">
          <div className="card">
            <h2>Acciones del operador</h2>
            {msg && <div className={`alert ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
            {options.length === 0 ? (
              <Empty>No hay transiciones disponibles desde {caseLabel(i.status)}.</Empty>
            ) : (
              <form onSubmit={change}>
                <div className="field">
                  <label htmlFor="st">Nuevo estado</label>
                  <select id="st" value={to} onChange={(e) => setTo(e.target.value)} required>
                    <option value="">Selecciona…</option>
                    {options.map((o) => (
                      <option key={`${o.s}|${o.reopen}`} value={`${o.s}|${o.reopen}`}>
                        {o.reopen ? `Reabrir → ${caseLabel(o.s)}` : caseLabel(o.s)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="rs">Motivo (queda en el historial)</label>
                  <textarea id="rs" value={reason} onChange={(e) => setReason(e.target.value)} minLength={5} maxLength={500} required />
                </div>
                <button className="btn primary" disabled={busy || !to || reason.trim().length < 5}>
                  {busy ? 'Guardando…' : 'Aplicar cambio'}
                </button>
              </form>
            )}
          </div>

          <div className="card">
            <h2>Prioridad explicada</h2>
            {i.priority ? (
              <>
                <p>
                  Puntaje <strong>{i.priority.score}/100</strong> → <PriorityBadge level={i.priority.level} /> <small>(calculado {fmtDate(i.priority.computedAt)}; la IA no interviene)</small>
                </p>
                <table>
                  <tbody>
                    {i.priority.factors.map((f) => (
                      <tr key={f.factor}>
                        <td style={{ width: '45%' }}>
                          <strong>{FACTOR_LABEL[f.factor] ?? f.factor}</strong>
                          <div>
                            <small>{f.explanation}</small>
                          </div>
                        </td>
                        <td>
                          <div className="factor-track" aria-hidden="true">
                            <div className="factor-bar" style={{ width: `${Math.round(f.normalized * 100)}%` }} />
                          </div>
                        </td>
                        <td className="num">+{f.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <Empty>Aún sin calcular.</Empty>
            )}
          </div>

          <div className="card">
            <h2>Análisis y recomendaciones</h2>
            {!ai ? (
              <Empty>Sin análisis todavía.</Empty>
            ) : (
              <>
                <div className="row" style={{ marginBottom: '0.5rem' }}>
                  {ai.source === 'VERTEX_AI_GEMINI' ? <span className="badge ai">Google Vertex AI · {ai.model}</span> : <span className="badge fallback">AI_UNAVAILABLE · respaldo por reglas locales</span>}
                  {ai.cached && <span className="badge">desde caché</span>}
                  <small>{fmtDate(ai.generatedAt)}</small>
                </div>
                <p>{ai.summary}</p>
                <h3>Causas probables (hipótesis)</h3>
                <ul>{ai.probableCauses.map((c, k) => <li key={k}>{c}</li>)}</ul>
                <h3>Acciones recomendadas</h3>
                <ul>{ai.recommendedActions.map((c, k) => <li key={k}>{c}</li>)}</ul>
                <h3>Incertidumbres</h3>
                <ul>{ai.uncertainties.map((c, k) => <li key={k}>{c}</li>)}</ul>
                <small>La IA apoya al operador; no decide la detección, la prioridad ni los cambios de estado.</small>
              </>
            )}
          </div>
        </div>

        <div className="stack">
          <div className="card">
            <h2>Cronología</h2>
            <ol className="timeline">
              {history.map((h, k) => (
                <li key={k}>
                  <div className="when">
                    {fmtDate(h.at)} · {h.actor}
                  </div>
                  <div>
                    <strong>{h.type.replace(/_/g, ' ').toLowerCase()}</strong>
                    {h.toStatus && (
                      <>
                        {' '}
                        · {h.fromStatus ? `${caseLabel(h.fromStatus)} → ` : ''}
                        {caseLabel(h.toStatus)}
                      </>
                    )}
                  </div>
                  {h.reason && <small>{h.reason}</small>}
                </li>
              ))}
            </ol>
          </div>
          <div className="card">
            <h2>Evidencia: reportes vinculados ({reports.length})</h2>
            {reports.length === 0 ? (
              <Empty>Sin reportes vinculados.</Empty>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ticket</th>
                      <th>Ocurrido</th>
                      <th>Seudónimo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((r) => (
                      <tr key={r.ticketId}>
                        <td className="mono">{r.ticketId}</td>
                        <td>{fmtDate(r.occurredAt)}</td>
                        <td className="mono muted">{r.reporterRef}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {i.relatedIncidentIds.length > 0 && (
              <p style={{ marginTop: '0.5rem' }}>
                Relacionado con:{' '}
                {i.relatedIncidentIds.map((r) => (
                  <Link key={r} to={`/operador/incidentes/${r}`} className="mono" style={{ marginRight: 8 }}>
                    {r}
                  </Link>
                ))}
                <small>(correlación por zona y tiempo; no implica causalidad)</small>
              </p>
            )}
          </div>
          <div className="card">
            <h2>Notificaciones</h2>
            {notifications.length === 0 ? (
              <Empty>Sin notificaciones para este incidente.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Canal</th>
                      <th>Estado</th>
                      <th className="num">Intentos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {notifications.map((n) => (
                      <tr key={n.notificationId}>
                        <td>{n.kind.replace(/_/g, ' ').toLowerCase()}</td>
                        <td>
                          {n.channel} <small>· {n.provider}</small>
                        </td>
                        <td>
                          {NOTIF_LABEL[n.status] ?? n.status}
                          {n.lastError && (
                            <div>
                              <small>{n.lastError}</small>
                            </div>
                          )}
                        </td>
                        <td className="num">{n.attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <small>"Aceptada por el proveedor" no garantiza que el destinatario la haya recibido.</small>
          </div>
        </div>
      </div>
    </div>
  );
}
