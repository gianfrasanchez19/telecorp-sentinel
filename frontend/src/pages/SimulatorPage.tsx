import { useState, type FormEvent } from 'react';
import { api, ApiError, fmtDate } from '../api';
import { Empty, ErrorState, Loading } from '../components/ui';
import { useApi } from '../hooks';
import type { Catalog, Health } from '../types';

interface SimStatus {
  overrides: Record<string, { mode: string; until: string }>;
  scenarios: { id: string; label: string; params: string[] }[];
  scheduleNote: string;
}
interface Processing {
  byStatus: Record<string, number>;
  pendingOutbox: number;
  recentFailures: { eventId: string; type: string; error?: { name: string; message: string }; updatedAt: string }[];
}
interface Pipeline {
  queues: { name: string; pending: number; inflight: number; processed: number; failedAttempts: number; dlq: number }[];
  executions: { name: string; status: string; startedAt: string; error?: { Error: string }; states: string[] }[];
}

export default function SimulatorPage() {
  const health = useApi<Health>('/health');
  const sim = useApi<SimStatus>('/operator/simulator', { auth: true });
  const proc = useApi<Processing>('/operator/processing', { auth: true, refreshMs: 5000 });
  const pipe = useApi<Pipeline>(health.data?.mode === 'local' ? '/operator/local/pipeline' : null, { auth: true, refreshMs: 5000 });
  const cat = useApi<Catalog>('/catalog');
  const [scenario, setScenario] = useState('reportes-usuarios');
  const [params, setParams] = useState<Record<string, string>>({ zoneId: 'Z-LPA', count: '10', startIndex: '0', antennaId: 'ANT-SRN-01', minutes: '30', problemType: 'SIN_SENAL' });
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; text: string }>();

  async function run(e?: FormEvent, override?: string) {
    e?.preventDefault();
    setBusy(true);
    setOut(undefined);
    try {
      const sc = override ?? scenario;
      const def = sim.data?.scenarios.find((s) => s.id === sc);
      const p: Record<string, unknown> = {};
      for (const k of def?.params ?? []) if (params[k] !== undefined && params[k] !== '') p[k] = ['count', 'startIndex', 'minutes', 'repeatIndex'].includes(k) ? Number(params[k]) : params[k];
      const r = await api(`/operator/simulator/scenarios`, { method: 'POST', auth: true, body: { scenario: sc, params: p } });
      setOut({ ok: true, text: JSON.stringify(r, null, 2) });
      sim.reload();
      proc.reload();
    } catch (err) {
      setOut({ ok: false, text: (err as ApiError).message });
    } finally {
      setBusy(false);
    }
  }

  async function replay(eventId: string) {
    try {
      await api(`/operator/processing/${encodeURIComponent(eventId)}/replay`, { method: 'POST', auth: true });
      proc.reload();
    } catch (err) {
      setOut({ ok: false, text: (err as ApiError).message });
    }
  }

  if (sim.loading && !sim.data) return <Loading />;
  if (sim.error) return <ErrorState error={sim.error} onRetry={sim.reload} />;
  const def = sim.data!.scenarios.find((s) => s.id === scenario);
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Laboratorio de simulación</h1>
          <small>Genera datos SINTÉTICOS a través de la misma API y flujo que los datos reales. {sim.data!.scheduleNote}</small>
        </div>
      </div>
      <div className="grid grid-2">
        <form className="card" onSubmit={run}>
          <h2>Ejecutar escenario</h2>
          <div className="field">
            <label htmlFor="sc">Escenario</label>
            <select id="sc" value={scenario} onChange={(e) => setScenario(e.target.value)}>
              {sim.data!.scenarios.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          {def?.params.includes('antennaId') && (
            <div className="field">
              <label htmlFor="an">Antena</label>
              <select id="an" value={params.antennaId} onChange={(e) => setParams({ ...params, antennaId: e.target.value })}>
                {cat.data?.antennas.map((a) => (
                  <option key={a.antennaId} value={a.antennaId}>
                    {a.antennaId} · {a.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {def?.params.includes('zoneId') && (
            <div className="field">
              <label htmlFor="zn">Zona</label>
              <select id="zn" value={params.zoneId} onChange={(e) => setParams({ ...params, zoneId: e.target.value })}>
                {cat.data?.zones.map((z) => (
                  <option key={z.zoneId} value={z.zoneId}>
                    {z.name} ({z.criticality})
                  </option>
                ))}
              </select>
            </div>
          )}
          {def?.params.includes('problemType') && (
            <div className="field">
              <label htmlFor="pt">Tipo de problema</label>
              <select id="pt" value={params.problemType} onChange={(e) => setParams({ ...params, problemType: e.target.value })}>
                {cat.data?.problemTypes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.family})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="grid grid-3">
            {(['count', 'startIndex', 'repeatIndex', 'minutes'] as const)
              .filter((k) => def?.params.includes(k))
              .map((k) => (
                <div className="field" key={k}>
                  <label htmlFor={k}>{{ count: 'Usuarios', startIndex: 'Índice inicial', repeatIndex: 'Repetir usuario #', minutes: 'Minutos' }[k]}</label>
                  <input id={k} type="number" min={0} value={params[k] ?? ''} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
                </div>
              ))}
          </div>
          {scenario === 'reportes-usuarios' && <small>Cada índice es una identidad sintética distinta; "Repetir usuario" agrega un reporte extra de una identidad ya usada (no aumenta el conteo).</small>}
          <div className="row" style={{ marginTop: '0.75rem' }}>
            <button className="btn primary" disabled={busy}>
              {busy ? 'Ejecutando…' : 'Ejecutar'}
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void run(undefined, 'tick')}>
              Emitir un minuto de telemetría
            </button>
          </div>
          {out && <pre className={`alert ${out.ok ? 'ok' : 'err'}`} style={{ whiteSpace: 'pre-wrap', maxHeight: 260, overflow: 'auto', fontSize: 12 }}>{out.text}</pre>}
        </form>
        <div className="card">
          <h2>Procesamiento (Step Functions)</h2>
          {proc.data ? (
            <>
              <div className="kpis">
                {Object.entries(proc.data.byStatus).map(([k, v]) => (
                  <div className="kpi" key={k}>
                    <div className="label">{k.replace('_', ' ').toLowerCase()}</div>
                    <div className="value">{v}</div>
                  </div>
                ))}
                <div className="kpi">
                  <div className="label">Outbox pendiente</div>
                  <div className="value">{proc.data.pendingOutbox}</div>
                </div>
              </div>
              <h3 style={{ marginTop: '1rem' }}>Fallos recientes (replay específico)</h3>
              {proc.data.recentFailures.length === 0 ? (
                <Empty>Sin ejecuciones fallidas.</Empty>
              ) : (
                <table>
                  <tbody>
                    {proc.data.recentFailures.map((f) => (
                      <tr key={f.eventId}>
                        <td className="mono">{f.eventId}</td>
                        <td>
                          {f.error?.name}
                          <div>
                            <small>{f.error?.message}</small>
                          </div>
                        </td>
                        <td>
                          <button className="btn sm" onClick={() => void replay(f.eventId)}>
                            Replay
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : proc.error ? (
            <ErrorState error={proc.error} />
          ) : (
            <Loading />
          )}
          <h3 style={{ marginTop: '1rem' }}>Modos forzados activos</h3>
          {Object.keys(sim.data!.overrides).length === 0 ? (
            <Empty>Ninguno: todas las antenas en modo normal.</Empty>
          ) : (
            <ul>
              {Object.entries(sim.data!.overrides).map(([a, o]) => (
                <li key={a}>
                  <span className="mono">{a}</span>: {o.mode} hasta {fmtDate(o.until)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {pipe.data && (
        <div className="card">
          <h2>Pipeline local (EMULADO — no es AWS)</h2>
          <div className="kpis">
            {pipe.data.queues.map((q) => (
              <div className="kpi" key={q.name}>
                <div className="label">Cola {q.name}</div>
                <div className="value">{q.processed}</div>
                <div className="hint">
                  pend. {q.pending} · en vuelo {q.inflight} · reintentos {q.failedAttempts} · DLQ {q.dlq}
                </div>
              </div>
            ))}
          </div>
          <h3 style={{ marginTop: '1rem' }}>Últimas ejecuciones de la state machine (intérprete ASL local)</h3>
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table>
              <tbody>
                {pipe.data.executions.slice(0, 20).map((e) => (
                  <tr key={e.name}>
                    <td className="mono">{e.name}</td>
                    <td>{e.status}</td>
                    <td>
                      <small>{e.states.filter((s) => s.endsWith('StateEntered')).map((s) => s.split(':')[0]).join(' → ')}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
