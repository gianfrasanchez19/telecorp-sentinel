import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fmtDate, fmtNum } from '../api';
import { ANTENNA_STATUS, AntennaBadge, Empty, ErrorState, Loading } from '../components/ui';
import { useApi } from '../hooks';
import type { AntennaView } from '../types';

/** Mapa ESQUEMÁTICO con coordenadas de ejemplo (sintéticas), sin teselas externas. */
export function NetworkMap({ antennas, selected, onSelect }: { antennas: AntennaView[]; selected?: string; onSelect?: (id: string) => void }) {
  const W = 560;
  const H = 360;
  const lats = antennas.map((a) => a.lat);
  const lons = antennas.map((a) => a.lon);
  const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats) - 0.015, Math.max(...lats) + 0.015, Math.min(...lons) - 0.02, Math.max(...lons) + 0.02];
  const x = (lon: number) => ((lon - minLon) / (maxLon - minLon)) * (W - 40) + 20;
  const y = (lat: number) => ((maxLat - lat) / (maxLat - minLat)) * (H - 40) + 20;
  const zones = useMemo(() => {
    const m = new Map<string, { name: string; xs: number[]; ys: number[] }>();
    for (const a of antennas) {
      const z = m.get(a.zoneId) ?? { name: a.zoneName, xs: [], ys: [] };
      z.xs.push(x(a.lon));
      z.ys.push(y(a.lat));
      m.set(a.zoneId, z);
    }
    return [...m.entries()];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [antennas]);
  if (!antennas.length) return <Empty>Sin antenas.</Empty>;
  return (
    <div className="map">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Mapa esquemático de antenas por zona con coordenadas de ejemplo">
        {zones.map(([id, z]) => {
          const cx = z.xs.reduce((a, b) => a + b, 0) / z.xs.length;
          const cy = z.ys.reduce((a, b) => a + b, 0) / z.ys.length;
          return (
            <g key={id}>
              <circle cx={cx} cy={cy} r={34} fill="none" stroke="var(--border-strong)" strokeDasharray="4 4" />
              <text className="zone-label" x={cx} y={cy - 40} textAnchor="middle">
                {z.name}
              </text>
            </g>
          );
        })}
        {antennas.map((a) => {
          const s = ANTENNA_STATUS[a.status] ?? ANTENNA_STATUS.SIN_DATOS;
          const sel = selected === a.antennaId;
          return (
            <g key={a.antennaId} transform={`translate(${x(a.lon)},${y(a.lat)})`} style={{ cursor: onSelect ? 'pointer' : 'default' }} onClick={() => onSelect?.(a.antennaId)} tabIndex={onSelect ? 0 : -1} onKeyDown={(e) => e.key === 'Enter' && onSelect?.(a.antennaId)} role={onSelect ? 'button' : undefined} aria-label={`${a.name}: ${s.label}`}>
              <title>{`${a.antennaId} · ${a.name}\n${s.label} · ${a.lastValue ?? '—'} GB/min`}</title>
              <circle r={sel ? 11 : 8} fill={s.color} stroke="var(--surface-1)" strokeWidth={2} />
              {a.recurrence.structuralReview && <circle r={13} fill="none" stroke="var(--critical)" strokeWidth={1.5} strokeDasharray="2 2" />}
            </g>
          );
        })}
        <text x={W - 8} y={H - 8} textAnchor="end" className="zone-label">
          Coordenadas de ejemplo (sintéticas)
        </text>
      </svg>
    </div>
  );
}

interface Metrics {
  unit: string;
  metrics: { observedAt: string; gbPerMinute: number; status: string; late: boolean }[];
  episodes: { episodeId: string; startedAt: string; endedAt: string | null; worstStatus: string; anomalousReadings: number; durationMinutes: number }[];
}

function AntennaDetail({ a }: { a: AntennaView }) {
  const [hours, setHours] = useState(2);
  const from = useMemo(() => new Date(Date.now() - hours * 3_600_000).toISOString(), [hours]);
  const m = useApi<Metrics>(`/operator/antennas/${a.antennaId}/metrics?from=${encodeURIComponent(from)}`, { auth: true });
  const data = (m.data?.metrics ?? []).map((x) => ({ t: new Date(x.observedAt).getTime(), v: x.gbPerMinute, status: x.status }));
  return (
    <div className="card">
      <div className="page-head">
        <div>
          <h2>
            {a.name} <small className="mono">{a.antennaId}</small>
          </h2>
          <div className="secondary">
            {a.zoneName} · {a.technology} · celdas {a.cells.join(', ')}
          </div>
        </div>
        <AntennaBadge status={a.status} />
      </div>
      <div className="kpis">
        <div className="kpi">
          <div className="label">Última medición</div>
          <div className="value">{a.lastValue === null ? '—' : fmtNum(a.lastValue, 2)}</div>
          <div className="hint">GB/min · {fmtDate(a.lastObservedAt)}</div>
        </div>
        <div className="kpi">
          <div className="label">Tendencia</div>
          <div className="value" style={{ fontSize: '1.2rem' }}>
            {a.trend === 'SUBE' ? '↗ Sube' : a.trend === 'BAJA' ? '↘ Baja' : a.trend === 'ESTABLE' ? '→ Estable' : '—'}
          </div>
          <div className="hint">últimas 10 lecturas</div>
        </div>
        <div className="kpi">
          <div className="label">Episodios (7 días)</div>
          <div className="value">{a.recurrence.episodesInWindow}</div>
          <div className="hint">{a.recurrence.structuralReview ? '⚠ Revisión estructural' : `${a.recurrence.totalAnomalousMinutes} min anómalos`}</div>
        </div>
        <div className="kpi">
          <div className="label">Recuperación</div>
          <div className="value" style={{ fontSize: '1.2rem' }}>
            {a.openEpisode ? `${a.consecutiveNormal} normales` : 'Sin episodio'}
          </div>
          <div className="hint">Política: {a.recoveryPolicy}</div>
        </div>
      </div>
      <div className="filters" style={{ marginTop: '1rem' }}>
        <div className="field">
          <label htmlFor="rng">Intervalo</label>
          <select id="rng" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            <option value={1}>Última hora</option>
            <option value={2}>Últimas 2 h</option>
            <option value={6}>Últimas 6 h</option>
            <option value={24}>Últimas 24 h</option>
          </select>
        </div>
      </div>
      {m.loading && !m.data ? (
        <Loading />
      ) : m.error ? (
        <ErrorState error={m.error} onRetry={m.reload} />
      ) : data.length === 0 ? (
        <Empty>No hay mediciones en el intervalo seleccionado (falta de datos ≠ valor 0).</Empty>
      ) : (
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--grid)" vertical={false} />
              <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={(t) => new Date(t).toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' })} stroke="var(--text-muted)" fontSize={12} />
              <YAxis stroke="var(--text-muted)" fontSize={12} width={44} unit="" label={{ value: 'GB/min', angle: -90, position: 'insideLeft', fill: 'var(--text-muted)', fontSize: 11 }} />
              <ReferenceLine y={60} stroke="var(--serious)" strokeDasharray="4 4" label={{ value: '60 (caída <)', fill: 'var(--text-secondary)', fontSize: 11, position: 'insideBottomRight' }} />
              <ReferenceLine y={129} stroke="var(--warning)" strokeDasharray="4 4" label={{ value: '129 (saturada >)', fill: 'var(--text-secondary)', fontSize: 11, position: 'insideTopRight' }} />
              <Tooltip labelFormatter={(t) => new Date(Number(t)).toLocaleString('es-PE')} formatter={(v, _n, p) => [`${v} GB/min · ${(p.payload as { status: string }).status}`, 'Medición']} contentStyle={{ background: 'var(--surface-2)', border: '1px solid var(--border)' }} />
              <Line type="monotone" dataKey="v" stroke="var(--series-1)" strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 5 }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <h3 style={{ marginTop: '1rem' }}>Episodios de anomalía (30 días)</h3>
      {(m.data?.episodes ?? []).length === 0 ? (
        <Empty>Sin episodios registrados.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Inicio</th>
                <th>Fin</th>
                <th>Peor estado</th>
                <th className="num">Lecturas anómalas</th>
                <th className="num">Duración (min)</th>
              </tr>
            </thead>
            <tbody>
              {m.data!.episodes.map((e) => (
                <tr key={e.episodeId}>
                  <td>{fmtDate(e.startedAt)}</td>
                  <td>{e.endedAt ? fmtDate(e.endedAt) : <em>abierto</em>}</td>
                  <td>
                    <AntennaBadge status={e.worstStatus} />
                  </td>
                  <td className="num">{e.anomalousReadings}</td>
                  <td className="num">{e.durationMinutes}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function AntennasPage() {
  const ants = useApi<AntennaView[]>('/operator/antennas', { auth: true, refreshMs: 20_000 });
  const [sel, setSel] = useState<string>();
  const [zone, setZone] = useState('');
  const [status, setStatus] = useState('');
  if (ants.loading && !ants.data) return <Loading />;
  if (ants.error) return <ErrorState error={ants.error} onRetry={ants.reload} />;
  const list = (ants.data ?? []).filter((a) => (!zone || a.zoneId === zone) && (!status || a.status === status));
  const selected = ants.data?.find((a) => a.antennaId === sel);
  const zones = [...new Map((ants.data ?? []).map((a) => [a.zoneId, a.zoneName])).entries()];
  return (
    <div>
      <div className="page-head">
        <h1>Antenas</h1>
        <small>Telemetría sintética cada minuto · umbrales: 0 inhabilitada · &lt;60 caída · 60–129 normal · &gt;129 saturada</small>
      </div>
      <div className="filters">
        <div className="field">
          <label htmlFor="fz">Zona</label>
          <select id="fz" value={zone} onChange={(e) => setZone(e.target.value)}>
            <option value="">Todas</option>
            {zones.map(([id, n]) => (
              <option key={id} value={id}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="fs">Estado</label>
          <select id="fs" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Todos</option>
            {Object.entries(ANTENNA_STATUS).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <NetworkMap antennas={list} selected={sel} onSelect={setSel} />
          <small>Clic en una antena para ver su historial. Círculo punteado rojo = revisión estructural por recurrencia.</small>
        </div>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Antena</th>
                <th>Zona</th>
                <th>Estado</th>
                <th className="num">GB/min</th>
                <th className="num">Episodios 7d</th>
              </tr>
            </thead>
            <tbody>
              {list.map((a) => (
                <tr key={a.antennaId} className="clickable" onClick={() => setSel(a.antennaId)} aria-selected={sel === a.antennaId}>
                  <td>
                    <strong>{a.name}</strong>
                    <div>
                      <small className="mono">{a.antennaId}</small>
                    </div>
                  </td>
                  <td>{a.zoneName}</td>
                  <td>
                    <AntennaBadge status={a.status} />
                  </td>
                  <td className="num">{a.lastValue === null ? '—' : fmtNum(a.lastValue, 2)}</td>
                  <td className="num">
                    {a.recurrence.episodesInWindow}
                    {a.recurrence.structuralReview && ' ⚠'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {selected ? <AntennaDetail key={selected.antennaId} a={selected} /> : <Empty>Selecciona una antena para ver medición, tendencia, episodios e historial.</Empty>}
    </div>
  );
}
