/**
 * Prueba de carga REPRODUCIBLE (ráfaga controlada) contra la API local o desplegada.
 * Mide: enviados, aceptados (201), duplicados, rechazados, errores, p50/p95 de
 * latencia de ingesta y la CONVERGENCIA del procesamiento (Step Functions COMPLETADO)
 * con timeout. No declara "pérdida cero" sin medirla.
 *
 * Uso:
 *   API_URL=http://localhost:3001 OPERATOR_USER=operador.demo OPERATOR_PASSWORD=... \
 *   LOAD_TOTAL=500 LOAD_CONCURRENCY=50 npx tsx scripts/load-test.ts
 * En la nube use cargas graduales (100 -> 500) y suba temporalmente reportsPerMinutePerIp.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync } from 'node:fs';

const API = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const TOTAL = Number(process.env.LOAD_TOTAL ?? 500);
const CONC = Number(process.env.LOAD_CONCURRENCY ?? 50);
const TIMEOUT = Number(process.env.LOAD_CONVERGENCE_TIMEOUT_S ?? 300) * 1000;
const zones = ['Z-SRN', 'Z-CCV', 'Z-CSU', 'Z-VIN', 'Z-LPA', 'Z-MIR'];
const runId = Date.now().toString(36);

async function token(): Promise<string | undefined> {
  if (!process.env.OPERATOR_USER || !process.env.OPERATOR_PASSWORD) return undefined;
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.OPERATOR_USER, password: process.env.OPERATOR_PASSWORD }) });
  return ((await r.json()) as { data?: { token: string } }).data?.token;
}
async function stats(tok?: string): Promise<Record<string, number> | undefined> {
  if (!tok) return undefined;
  const r = await fetch(`${API}/operator/processing`, { headers: { authorization: `Bearer ${tok}` } });
  const d = ((await r.json()) as { data?: { byStatus: Record<string, number>; pendingOutbox: number } }).data;
  return d ? { ...d.byStatus, pendingOutbox: d.pendingOutbox } : undefined;
}

const tok = await token();
const before = await stats(tok);
const lat: number[] = [];
const counts = { sent: 0, accepted: 0, duplicate: 0, rejected4xx: 0, throttled429: 0, errors5xxOrNetwork: 0 };
let next = 0;
const t0 = Date.now();
async function worker() {
  while (next < TOTAL) {
    const i = next++;
    const body = {
      documentType: 'DNI',
      documentNumber: String(60_000_000 + ((Date.now() + i * 7919) % 39_999_999)).slice(0, 8),
      serviceNumber: `9${String(10_000_000 + i).slice(-8)}`,
      zoneId: zones[i % zones.length],
      occurredAt: new Date(Date.now() - 120_000).toISOString(),
      problemType: 'SIN_DATOS_MOVILES',
      description: `Carga ${runId} #${i} (sintético)`,
      idempotencyKey: `load-${runId}-${i}-${randomUUID().slice(0, 8)}`,
      synthetic: true,
    };
    const s = performance.now();
    counts.sent++;
    try {
      const r = await fetch(`${API}/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      lat.push(performance.now() - s);
      if (r.status === 201) counts.accepted++;
      else if (r.status === 200) counts.duplicate++;
      else if (r.status === 429) counts.throttled429++;
      else if (r.status < 500) counts.rejected4xx++;
      else counts.errors5xxOrNetwork++;
      await r.arrayBuffer();
    } catch {
      counts.errors5xxOrNetwork++;
    }
  }
}
await Promise.all(Array.from({ length: CONC }, worker));
const ingestMs = Date.now() - t0;
lat.sort((a, b) => a - b);
const q = (p: number) => Math.round(lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))] ?? 0);

let after = await stats(tok);
let converged = false;
const target = (before?.COMPLETADO ?? 0) + counts.accepted;
const c0 = Date.now();
while (tok && Date.now() - c0 < TIMEOUT) {
  after = await stats(tok);
  if ((after?.COMPLETADO ?? 0) >= target && (after?.pendingOutbox ?? 0) === 0) {
    converged = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const report = {
  api: API,
  runId,
  at: new Date().toISOString(),
  total: TOTAL,
  concurrency: CONC,
  counts,
  ingestDurationMs: ingestMs,
  throughputPerSec: Math.round((counts.sent / ingestMs) * 1000),
  latencyMs: { p50: q(0.5), p95: q(0.95), max: Math.round(lat[lat.length - 1] ?? 0) },
  processing: tok
    ? { before, after, expectedCompleted: target, processedThisRun: (after?.COMPLETADO ?? 0) - (before?.COMPLETADO ?? 0), failed: (after?.FALLIDO ?? 0) - (before?.FALLIDO ?? 0), pendingOutbox: after?.pendingOutbox, converged, convergenceMs: Date.now() - c0 }
    : 'sin credenciales de operador: no se midió la convergencia',
};
console.log(JSON.stringify(report, null, 2));
mkdirSync('docs/evidence', { recursive: true });
const f = `docs/evidence/load-${API.includes('localhost') ? 'local' : 'cloud'}-${runId}.json`;
// El repositorio es público: no se publica el identificador del endpoint desplegado.
writeFileSync(f, JSON.stringify(report, null, 2).replace(/https:\/\/[a-z0-9]+\.execute-api/g, 'https://<api-id>.execute-api'));
console.log(`Resultado guardado en ${f}`);
