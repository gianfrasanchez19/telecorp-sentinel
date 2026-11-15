import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, fmtNum } from '../api';
import { AntennaBadge, CaseBadge, Empty, ErrorState, Loading, PriorityBadge, SyntheticBadge } from '../components/ui';
import { useApi } from '../hooks';
import type { Catalog, Incident } from '../types';

export default function IncidentsPage() {
  const [active, setActive] = useState('true');
  const [zone, setZone] = useState('');
  const [level, setLevel] = useState('');
  const [kind, setKind] = useState('');
  const qs = new URLSearchParams({ active, ...(zone && { zone }), ...(level && { level }), ...(kind && { kind }) }).toString();
  const inc = useApi<Incident[]>(`/operator/incidents?${qs}`, { auth: true, refreshMs: 20_000 });
  const cat = useApi<Catalog>('/catalog');
  return (
    <div>
      <div className="page-head">
        <h1>Incidentes</h1>
        <small>Activos ordenados por prioridad determinista; cerrados por fecha de cierre.</small>
      </div>
      <div className="filters" role="search">
        <div className="field">
          <label htmlFor="a">Vista</label>
          <select id="a" value={active} onChange={(e) => setActive(e.target.value)}>
            <option value="true">Activos</option>
            <option value="false">Cerrados</option>
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
          <label htmlFor="l">Prioridad</label>
          <select id="l" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">Todas</option>
            <option value="CRITICA">Crítica</option>
            <option value="ALTA">Alta</option>
            <option value="MEDIA">Media</option>
            <option value="BAJA">Baja</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="k">Tipo</label>
          <select id="k" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">Todos</option>
            <option value="INFRAESTRUCTURA">Infraestructura</option>
            <option value="COLECTIVO">Colectivo</option>
          </select>
        </div>
      </div>
      <div className="card">
        {inc.loading && !inc.data ? (
          <Loading />
        ) : inc.error ? (
          <ErrorState error={inc.error} onRetry={inc.reload} />
        ) : (inc.data ?? []).length === 0 ? (
          <Empty>No hay incidentes con estos filtros.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Prioridad</th>
                  <th>Incidente</th>
                  <th>Antena</th>
                  <th className="num">Reportantes únicos</th>
                  <th className="num">Usuarios estimados*</th>
                  <th>Estado</th>
                  <th>IA</th>
                </tr>
              </thead>
              <tbody>
                {inc.data!.map((i) => (
                  <tr key={i.incidentId}>
                    <td>
                      <PriorityBadge level={i.priority?.level} score={i.priority?.score} />
                    </td>
                    <td>
                      <Link to={`/operador/incidentes/${i.incidentId}`}>{i.title}</Link>
                      <div>
                        <small>
                          <span className="mono">{i.incidentId}</span> · {i.kind === 'COLECTIVO' ? 'Colectivo' : 'Infraestructura'} · {i.zoneName} · {fmtDate(i.openedAt)}
                        </small>{' '}
                        <SyntheticBadge show={i.synthetic} />
                        {i.investigationPending && <span className="badge">Investigación pendiente</span>}
                        {i.recovery?.pendingVerification && <span className="badge">Recuperación por verificar</span>}
                      </div>
                    </td>
                    <td>{i.currentAntennaStatus ? <AntennaBadge status={i.currentAntennaStatus} /> : '—'}</td>
                    <td className="num">{fmtNum(i.uniqueReporters)}</td>
                    <td className="num">{fmtNum(i.estimatedUsers)}</td>
                    <td>
                      <CaseBadge status={i.status} />
                    </td>
                    <td>{i.ai ? <span className={`badge ${i.ai.source === 'VERTEX_AI_GEMINI' ? 'ai' : 'fallback'}`}>{i.ai.source === 'VERTEX_AI_GEMINI' ? 'Gemini' : 'Respaldo'}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <small>* Usuarios estimados: dato de catálogo sintético por celdas (sin duplicar coberturas solapadas). No es un dato medido ni equivale a reportantes.</small>
      </div>
    </div>
  );
}
