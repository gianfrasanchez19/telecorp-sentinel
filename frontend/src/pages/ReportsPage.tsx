import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate } from '../api';
import { CaseBadge, Empty, ErrorState, Loading, SyntheticBadge } from '../components/ui';
import { useApi } from '../hooks';
import type { Catalog, OperatorReport } from '../types';

export default function ReportsPage() {
  const [days, setDays] = useState(7);
  const [zone, setZone] = useState('');
  const [status, setStatus] = useState('');
  const from = new Date(Math.floor((Date.now() - days * 86_400_000) / 60_000) * 60_000).toISOString();
  const qs = new URLSearchParams({ from, ...(zone && { zone }), ...(status && { status }) }).toString();
  const r = useApi<OperatorReport[]>(`/operator/reports?${qs}`, { auth: true });
  const cat = useApi<Catalog>('/catalog');
  const label = (t: string) => cat.data?.problemTypes.find((p) => p.id === t)?.label ?? t;
  return (
    <div>
      <div className="page-head">
        <h1>Reportes</h1>
        <small>Datos personales enmascarados; descripción redactada; seudónimo no reversible.</small>
      </div>
      <div className="filters">
        <div className="field">
          <label htmlFor="d">Período</label>
          <select id="d" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Últimas 24 h</option>
            <option value={7}>Últimos 7 días</option>
            <option value={30}>Últimos 30 días</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="z">Zona</label>
          <select id="z" value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">Todas</option>
            {cat.data?.zones.map((z) => (
              <option key={z.zoneId} value={z.zoneId}>
                {z.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="s">Estado</label>
          <select id="s" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {cat.data?.statuses.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <button className="btn" onClick={r.reload}>
          Actualizar
        </button>
      </div>
      <div className="card">
        {r.loading && !r.data ? (
          <Loading />
        ) : r.error ? (
          <ErrorState error={r.error} onRetry={r.reload} />
        ) : (r.data ?? []).length === 0 ? (
          <Empty>No hay reportes en el período.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Problema</th>
                  <th>Zona</th>
                  <th>Ocurrido / recibido</th>
                  <th>Descripción (redactada)</th>
                  <th>Contacto</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                {r.data!.map((x) => (
                  <tr key={x.ticketId}>
                    <td>
                      <span className="mono">{x.ticketId}</span>
                      <div>
                        <small className="mono muted">ref {x.reporterRef}</small> <SyntheticBadge show={x.synthetic} />
                      </div>
                    </td>
                    <td>{label(x.problemType)}</td>
                    <td>{x.zoneName}</td>
                    <td>
                      {fmtDate(x.occurredAt)}
                      <div>
                        <small>rec. {fmtDate(x.receivedAt)}</small>
                      </div>
                      {x.lateForOpening && <span className="badge">tardío</span>}
                    </td>
                    <td style={{ maxWidth: 280 }}>{x.description}</td>
                    <td>{x.contact.consent ? [x.contact.email, x.contact.phone].filter(Boolean).join(' · ') : <small>sin avisos</small>}</td>
                    <td>
                      <CaseBadge status={x.status} />
                      {x.incidentIds.map((i) => (
                        <div key={i}>
                          <Link className="mono" to={`/operador/incidentes/${i}`}>
                            {i}
                          </Link>
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
