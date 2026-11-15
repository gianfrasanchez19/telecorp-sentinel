import { Link } from 'react-router-dom';
import { fmtDate, fmtNum } from '../api';
import { ANTENNA_STATUS, AntennaBadge, CaseBadge, Empty, ErrorState, Kpi, Loading, PriorityBadge } from '../components/ui';
import { useApi } from '../hooks';
import type { AntennaView, Incident } from '../types';
import { NetworkMap } from './AntennasPage';

export default function Dashboard() {
  const inc = useApi<Incident[]>('/operator/incidents?active=true', { auth: true, refreshMs: 15_000 });
  const ants = useApi<AntennaView[]>('/operator/antennas', { auth: true, refreshMs: 15_000 });
  if ((inc.loading && !inc.data) || (ants.loading && !ants.data)) return <Loading />;
  if (inc.error) return <ErrorState error={inc.error} onRetry={inc.reload} />;
  if (ants.error) return <ErrorState error={ants.error} onRetry={ants.reload} />;
  const incidents = inc.data ?? [];
  const antennas = ants.data ?? [];
  const count = (s: string) => antennas.filter((a) => a.status === s).length;
  const pending = incidents.filter((i) => i.recovery?.pendingVerification);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Panel de operaciones</h1>
          <small>Actualización automática cada 15 s · datos persistidos (sintéticos)</small>
        </div>
        <Link className="btn" to="/operador/analitica">
          Ver analítica
        </Link>
      </div>
      <div className="kpis">
        <Kpi label="Incidentes activos" value={incidents.length} hint={`${incidents.filter((i) => i.priority?.level === 'CRITICA').length} críticos · ${incidents.filter((i) => i.priority?.level === 'ALTA').length} altos`} />
        {(['CAIDA', 'INHABILITADA', 'SATURADA', 'SIN_DATOS'] as const).map((s) => (
          <Kpi key={s} label={`Antenas ${ANTENNA_STATUS[s].label.toLowerCase()}`} value={count(s)} hint={`de ${antennas.length}`} icon={<span aria-hidden="true" style={{ color: ANTENNA_STATUS[s].color }}>{ANTENNA_STATUS[s].icon}</span>} />
        ))}
        <Kpi label="Pendientes de verificación" value={pending.length} hint="recuperación técnica detectada" />
      </div>

      <div className="grid grid-2" style={{ marginTop: '1rem' }}>
        <div className="card">
          <h2>Cola de incidentes (por prioridad)</h2>
          {incidents.length === 0 ? (
            <Empty>No hay incidentes activos.</Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Prioridad</th>
                    <th>Incidente</th>
                    <th className="num">Reportantes</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {incidents.slice(0, 12).map((i) => (
                    <tr key={i.incidentId}>
                      <td>
                        <PriorityBadge level={i.priority?.level} score={i.priority?.score} />
                      </td>
                      <td>
                        <Link to={`/operador/incidentes/${i.incidentId}`}>{i.title}</Link>
                        <div>
                          <small>
                            {i.kind === 'COLECTIVO' ? 'Colectivo' : 'Infraestructura'} · {i.zoneName} · desde {fmtDate(i.openedAt)}
                            {i.investigationPending && ' · investigación pendiente'}
                          </small>
                        </div>
                      </td>
                      <td className="num">{fmtNum(i.uniqueReporters)}</td>
                      <td>
                        <CaseBadge status={i.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="card">
          <h2>Mapa esquemático de la red</h2>
          <NetworkMap antennas={antennas} />
          <div className="row" style={{ marginTop: '0.5rem' }}>
            {Object.keys(ANTENNA_STATUS).map((s) => (
              <AntennaBadge key={s} status={s} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
