/**
 * Prueba E2E de aceptación contra la API DESPLEGADA (datos sintéticos, pocos eventos).
 * Ejecuta escenarios por el laboratorio autenticado, espera la convergencia del
 * pipeline real (Streams -> SQS -> Step Functions) y verifica los resultados.
 * Uso: API_URL=... OPERATOR_USER=... OPERATOR_PASSWORD=... npx tsx scripts/e2e-cloud.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';

const API = (process.env.API_URL ?? '').replace(/\/$/, '');
if (!API || !process.env.OPERATOR_USER || !process.env.OPERATOR_PASSWORD) throw new Error('API_URL, OPERATOR_USER y OPERATOR_PASSWORD requeridos');
const runId = Date.now().toString(36);
const base = Number(process.env.E2E_INDEX_BASE ?? (Date.now() % 100_000) * 10);

async function call<T>(path: string, init: RequestInit = {}, tok?: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init.headers ?? {}) } });
  const j = (await r.json()) as { data?: T; error?: { message: string } };
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${j.error?.message}`);
  return j.data as T;
}
const login = await call<{ token: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ username: process.env.OPERATOR_USER, password: process.env.OPERATOR_PASSWORD }) });
const T = login.token;
const ZONE = process.env.E2E_ZONE ?? 'Z-CSU';
const ANT = process.env.E2E_ANTENNA ?? 'ANT-CSU-01';
const scenario = (scenario: string, params: Record<string, unknown>) => call<Record<string, unknown>>('/operator/simulator/scenarios', { method: 'POST', body: JSON.stringify({ scenario, params }) }, T);

/**
 * Espera la convergencia REAL: que el número de ejecuciones COMPLETADO aumente en
 * `expectedNew` (cada reporte / episodio / cambio de estado es una ejecución) y que
 * no queden ejecuciones en curso ni outbox pendiente.
 */
let completedBase = -1;
async function settle(label: string, expectedNew: number, timeoutMs = 300_000) {
  const t0 = Date.now();
  if (completedBase < 0) completedBase = (await call<{ byStatus: Record<string, number> }>('/operator/processing', {}, T)).byStatus.COMPLETADO;
  const target = completedBase + expectedNew;
  while (Date.now() - t0 < timeoutMs) {
    const p = await call<{ byStatus: Record<string, number>; pendingOutbox: number }>('/operator/processing', {}, T);
    const busy = p.byStatus.INICIADO + p.byStatus.EN_EJECUCION + p.pendingOutbox;
    if (p.byStatus.COMPLETADO >= target && busy === 0) {
      completedBase = p.byStatus.COMPLETADO;
      return { label, ms: Date.now() - t0, ...p.byStatus };
    }
    if (p.byStatus.FALLIDO > 0) throw new Error(`Ejecución FALLIDA durante ${label}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`Timeout esperando convergencia (${label})`);
}

type Inc = { incidentId: string; kind: string; zoneId: string; uniqueReporters: number; reportCount: number; investigationPending: boolean; relatedIncidentIds: string[]; status: string; priority?: { level: string; score: number }; ai?: { source: string }; recovery?: { pendingVerification: boolean }; antennaIds: string[] };
await settle('inicio', 0);
const incidents = () => call<Inc[]>('/operator/incidents', {}, T);
const rows: { escenario: string; esperado: string; obtenido: string; ok: boolean }[] = [];
const check = (escenario: string, esperado: string, obtenido: unknown, ok: boolean) => rows.push({ escenario, esperado, obtenido: String(obtenido), ok });
const timings: unknown[] = [];

// 1) 9 usuarios distintos + 1 repetido (Centro Cívico) => sin colectivo
await scenario('reportes-usuarios', { zoneId: ZONE, count: 9, startIndex: base, repeatIndex: base + 3, problemType: 'SIN_DATOS_MOVILES' });
timings.push(await settle('9+1', 10));
let coll = (await incidents()).filter((i) => i.kind === 'COLECTIVO' && i.zoneId === ZONE);
check('9 usuarios + 1 repetido', 'sin colectivo', coll.length, coll.length === 0);

// 2) décimo usuario distinto => exactamente un colectivo
await scenario('reportes-usuarios', { zoneId: ZONE, count: 1, startIndex: base + 9, problemType: 'SIN_DATOS_MOVILES' });
timings.push(await settle('10.º', 1));
coll = (await incidents()).filter((i) => i.kind === 'COLECTIVO' && i.zoneId === ZONE);
check('Décimo usuario distinto', '1 colectivo, 10 reportantes', `${coll.length} / ${coll[0]?.uniqueReporters}`, coll.length === 1 && coll[0].uniqueReporters === 10);
check('Colectivo con antenas normales', 'investigación pendiente', coll[0]?.investigationPending, coll[0]?.investigationPending === true);

// 3) antena inhabilitada en la misma zona => incidente de infraestructura relacionado
await scenario('antena-inhabilitada', { antennaId: ANT, minutes: 5 });
timings.push(await settle('antena', 1));
const all = await incidents();
const infra = all.filter((i) => i.kind === 'INFRAESTRUCTURA' && i.antennaIds[0] === ANT);
coll = all.filter((i) => i.kind === 'COLECTIVO' && i.zoneId === ZONE);
check('Antena inhabilitada', '1 incidente de infraestructura', infra.length, infra.length === 1);
check('Relación colectivo↔infraestructura', 'relacionados, usuarios sin duplicar (10)', `${coll[0]?.relatedIncidentIds.length} rel · ${coll[0]?.uniqueReporters} usuarios`, (coll[0]?.relatedIncidentIds.length ?? 0) >= 1 && coll[0]?.uniqueReporters === 10);
check('Prioridad determinista', 'calculada y explicable', `${infra[0]?.priority?.level} ${infra[0]?.priority?.score}`, !!infra[0]?.priority);
check('IA', 'respaldo etiquetado (GCP aún no desplegado)', infra[0]?.ai?.source, infra[0]?.ai?.source === 'AI_UNAVAILABLE');

// 4) recuperación técnica => pendiente de verificación (no se cierra solo)
await scenario('recuperar', { antennaId: ANT });
timings.push(await settle('recuperación', 1));
const rec = (await incidents()).find((i) => i.kind === 'INFRAESTRUCTURA' && i.antennaIds[0] === ANT);
check('Recuperación (3 normales)', 'verificación pendiente, no SOLUCIONADA', `${rec?.status} · pendiente=${rec?.recovery?.pendingVerification}`, rec?.status !== 'SOLUCIONADA' && rec?.recovery?.pendingVerification === true);

// 5) cambio de estado del operador => historial + propagación (Step Functions PropagateStatus)
if (rec) {
  await call(`/operator/incidents/${rec.incidentId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'EN_ATENCION', reason: `E2E ${runId}: cuadrilla asignada` }) }, T);
  await call(`/operator/incidents/${rec.incidentId}/status`, { method: 'PATCH', body: JSON.stringify({ status: 'SOLUCIONADA', reason: `E2E ${runId}: verificado por operador` }) }, T);
  timings.push(await settle('estado', 2));
  const h = await call<{ type: string; fromStatus?: string; toStatus?: string }[]>(`/operator/incidents/${rec.incidentId}/history`, {}, T);
  const changes = h.filter((x) => x.type === 'CAMBIO_ESTADO').map((x) => `${x.fromStatus}->${x.toStatus}`);
  check('Cambio de estado auditado', 'REGISTRADA->EN_ATENCION->SOLUCIONADA', changes.join(' '), changes.join(' ') === 'REGISTRADA->EN_ATENCION EN_ATENCION->SOLUCIONADA');
}

// 6) transición inválida (SOLUCIONADA -> EN_REVISION sin reapertura explícita) => 409
const bad = await fetch(`${API}/operator/incidents/${rec?.incidentId}/status`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${T}` }, body: JSON.stringify({ status: 'EN_REVISION', reason: 'retroceder sin reabrir' }) });
check('Transición inválida', '409 (SOLUCIONADA→EN_REVISION sin reabrir)', bad.status, bad.status === 409);

const final = await call<{ byStatus: Record<string, number> }>('/operator/processing', {}, T);
check('Ejecuciones Step Functions', '0 FALLIDO, 0 pendientes', JSON.stringify(final.byStatus), final.byStatus.FALLIDO === 0 && final.byStatus.INICIADO === 0 && final.byStatus.EN_EJECUCION === 0);

console.table(rows.map((r) => ({ '': r.ok ? '✅' : '❌', escenario: r.escenario, esperado: r.esperado, obtenido: r.obtenido })));
const failed = rows.filter((r) => !r.ok).length;
const report = { api: API, runId, at: new Date().toISOString(), environment: 'AWS (cuenta AWS Academy, us-east-1)', results: rows, convergence: timings, failed };
mkdirSync('docs/evidence', { recursive: true });
writeFileSync(`docs/evidence/e2e-cloud-${runId}.json`, JSON.stringify(report, null, 2).replace(/https:\/\/[a-z0-9]+\.execute-api/g, 'https://<api-id>.execute-api'));
console.log(failed ? `${failed} verificación(es) fallaron` : 'Todas las verificaciones E2E en la nube se cumplieron.', `Evidencia: docs/evidence/e2e-cloud-${runId}.json`);
process.exit(failed ? 1 : 0);
