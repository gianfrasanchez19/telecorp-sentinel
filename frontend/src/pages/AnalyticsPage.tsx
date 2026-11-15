import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtNum } from '../api';
import { ANTENNA_STATUS, Empty, ErrorState, Kpi, Loading } from '../components/ui';
import { useApi } from '../hooks';
import type { Catalog } from '../types';

interface Analytics {
  range: { from: string; to: string };
  hasData: boolean;
  antennas: { kpis: Record<string, number>; recurrent: { antennaId: string; name: string; zoneName: string; episodes: number; anomalousMinutes: number }[]; episodesRanking: { antennaId: string; name: string; zoneName: string; episodes: number; anomalousMinutes: number }[] };
  incidents: { activeTotal: number; activeByPriority: { level: string; count: number }[]; openedInRange: number; byKind: Record<string, number>; zonesRanking: { zoneName: string; incidents: number; active: number }[] };
  reports: { total: number; uniqueReporters: number; byZone: { zoneName: string; reports: number; uniqueReporters: number }[]; byType: { label: string; count: number }[]; synthetic: number };
  estimatedUsersAffectedActive: number;
  timeSeries: { day: string; reports: number; uniqueReporters: number; incidentsOpened: number }[];
  mttd: { count: number; avgMinutes: number | null; p50Minutes: number | null; p90Minutes: number | null };
  mttr: { count: number; avgMinutes: number | null; p50Minutes: number | null; p90Minutes: number | null };
  definitions: Record<string, string>;
}

const tip = { contentStyle: { background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text-primary)' } };
const axis = { stroke: 'var(--text-muted)', fontSize: 12 };
// Rampa ordinal secuencial (azul) para niveles de prioridad: más oscuro = más severo.
const PRIO_FILL: Record<string, string> = { CRITICA: '#184f95', ALTA: '#256abf', MEDIA: '#3987e5', BAJA: '#86b6ef' };

function ChartTable({ rows, cols }: { rows: Record<string, unknown>[]; cols: [string, string][] }) {
  return (
    <details>
      <summary>
        <small>Ver como tabla</small>
      </summary>
      <table>
        <thead>
          <tr>
            {cols.map(([, l]) => (
              <th key={l}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, k) => (
            <tr key={k}>
              {cols.map(([c]) => (
                <td key={c}>{String(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const [zone, setZone] = useState('');
  const to = useMemo(() => new Date(), []);
  const from = new Date(to.getTime() - days * 86_400_000).toISOString();
  const a = useApi<Analytics>(`/operator/analytics?${new URLSearchParams({ from, to: to.toISOString(), ...(zone && { zone }) })}`, { auth: true });
  const cat = useApi<Catalog>('/catalog');
  const d = a.data;
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Analítica</h1>
          <small>Calculada sobre datos persistidos (sintéticos de demo). Fechas UTC.</small>
        </div>
      </div>
      <div className="filters">
        <div className="field">
          <label htmlFor="d">Intervalo</label>
          <select id="d" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={1}>Último día</option>
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
      </div>
      {a.loading && !d ? (
        <Loading />
      ) : a.error ? (
        <ErrorState error={a.error} onRetry={a.reload} />
      ) : !d?.hasData ? (
        <Empty>No hay datos en el intervalo. Use el laboratorio de simulación para generar datos sintéticos.</Empty>
      ) : (
        <>
          <div className="kpis">
            {(['CAIDA', 'SATURADA', 'INHABILITADA', 'SIN_DATOS'] as const).map((s) => (
              <Kpi key={s} label={`Antenas ${ANTENNA_STATUS[s].label.toLowerCase()}`} value={d.antennas.kpis[s] ?? 0} hint={`de ${d.antennas.kpis.total} (estado actual)`} icon={<span aria-hidden="true" style={{ color: ANTENNA_STATUS[s].color }}>{ANTENNA_STATUS[s].icon}</span>} />
            ))}
            <Kpi label="Incidentes activos" value={d.incidents.activeTotal} hint={`${d.incidents.openedInRange} abiertos en el intervalo`} />
            <Kpi label="Reportantes únicos" value={fmtNum(d.reports.uniqueReporters)} hint={`${d.reports.total} reportes (${d.reports.synthetic} sintéticos)`} />
            <Kpi label="Usuarios estimados (activos)" value={fmtNum(d.estimatedUsersAffectedActive)} hint="estimado de catálogo, no medido" />
            <Kpi label="MTTD" value={d.mttd.avgMinutes === null ? '—' : `${d.mttd.avgMinutes} min`} hint={d.mttd.count ? `p50 ${d.mttd.p50Minutes} · n=${d.mttd.count}` : 'sin incidentes'} />
            <Kpi label="MTTR" value={d.mttr.avgMinutes === null ? '—' : `${d.mttr.avgMinutes} min`} hint={d.mttr.count ? `p50 ${d.mttr.p50Minutes} · n=${d.mttr.count}` : 'sin incidentes solucionados'} />
          </div>

          <div className="grid grid-2" style={{ marginTop: '1rem' }}>
            <div className="card">
              <h2>Reportes vs. reportantes únicos por día</h2>
              <div style={{ height: 240 }}>
                <ResponsiveContainer>
                  <LineChart data={d.timeSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="day" {...axis} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis {...axis} allowDecimals={false} width={36} />
                    <Tooltip {...tip} />
                    <Legend />
                    <Line name="Reportes" dataKey="reports" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                    <Line name="Reportantes únicos" dataKey="uniqueReporters" stroke="var(--series-2)" strokeWidth={2} dot={{ r: 3 }} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <ChartTable rows={d.timeSeries} cols={[['day', 'Día'], ['reports', 'Reportes'], ['uniqueReporters', 'Únicos'], ['incidentsOpened', 'Incidentes']]} />
            </div>
            <div className="card">
              <h2>Incidentes abiertos por día</h2>
              <div style={{ height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={d.timeSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="day" {...axis} tickFormatter={(v: string) => v.slice(5)} />
                    <YAxis {...axis} allowDecimals={false} width={36} />
                    <Tooltip {...tip} cursor={{ fill: 'var(--grid)' }} />
                    <Bar name="Incidentes abiertos" dataKey="incidentsOpened" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <h2>Incidentes activos por prioridad</h2>
              <div style={{ height: 220 }}>
                <ResponsiveContainer>
                  <BarChart data={d.incidents.activeByPriority} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="level" {...axis} />
                    <YAxis {...axis} allowDecimals={false} width={36} />
                    <Tooltip {...tip} cursor={{ fill: 'var(--grid)' }} />
                    <Bar name="Incidentes" dataKey="count" radius={[4, 4, 0, 0]} isAnimationActive={false} fill="var(--series-1)" shape={(p: any) => <rect x={p.x} y={p.y} width={p.width} height={p.height} rx={4} fill={PRIO_FILL[p.payload.level]} />} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <h2>Reportes y reportantes únicos por zona</h2>
              <div style={{ height: 240 }}>
                <ResponsiveContainer>
                  <BarChart data={d.reports.byZone} margin={{ top: 8, right: 16, left: 0, bottom: 0 }} barGap={2}>
                    <CartesianGrid stroke="var(--grid)" vertical={false} />
                    <XAxis dataKey="zoneName" {...axis} interval={0} fontSize={11} />
                    <YAxis {...axis} allowDecimals={false} width={36} />
                    <Tooltip {...tip} cursor={{ fill: 'var(--grid)' }} />
                    <Legend />
                    <Bar name="Reportes" dataKey="reports" fill="var(--series-1)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                    <Bar name="Reportantes únicos" dataKey="uniqueReporters" fill="var(--series-2)" radius={[4, 4, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <h2>Distribución por tipo de problema</h2>
              <div style={{ height: 260 }}>
                <ResponsiveContainer>
                  <BarChart data={d.reports.byType} layout="vertical" margin={{ top: 8, right: 24, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke="var(--grid)" horizontal={false} />
                    <XAxis type="number" {...axis} allowDecimals={false} />
                    <YAxis type="category" dataKey="label" {...axis} width={150} fontSize={11} />
                    <Tooltip {...tip} cursor={{ fill: 'var(--grid)' }} />
                    <Bar name="Reportes" dataKey="count" fill="var(--series-1)" radius={[0, 4, 4, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="card">
              <h2>Zonas con más incidentes</h2>
              <table>
                <thead>
                  <tr>
                    <th>Zona</th>
                    <th className="num">Abiertos en intervalo</th>
                    <th className="num">Activos</th>
                  </tr>
                </thead>
                <tbody>
                  {d.incidents.zonesRanking.map((z) => (
                    <tr key={z.zoneName}>
                      <td>{z.zoneName}</td>
                      <td className="num">{z.incidents}</td>
                      <td className="num">{z.active}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3 style={{ marginTop: '1rem' }}>Antenas recurrentes (revisión estructural)</h3>
              {d.antennas.episodesRanking.length === 0 ? (
                <Empty>Sin episodios en la ventana.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>Antena</th>
                      <th className="num">Episodios 7 d</th>
                      <th className="num">Min. anómalos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.antennas.episodesRanking.map((x) => (
                      <tr key={x.antennaId}>
                        <td>
                          {x.name} <small>· {x.zoneName}</small> {d.antennas.recurrent.some((r) => r.antennaId === x.antennaId) && <span className="badge">⚠ revisión</span>}
                        </td>
                        <td className="num">{x.episodes}</td>
                        <td className="num">{x.anomalousMinutes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          <div className="card">
            <h2>Definiciones</h2>
            <ul>
              {Object.entries(d.definitions).map(([k, v]) => (
                <li key={k}>
                  <strong>{k}:</strong> {v}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
