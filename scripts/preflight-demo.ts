/**
 * PRE-VUELO de la demo (solo lectura, sin coste apreciable): verifica la plataforma
 * desplegada y recomienda datos para grabar.
 *  - Salud de AWS (API, DynamoDB, Step Functions, SQS) y de la integración con GCP/Gemini.
 *  - Recorre TODAS las rutas del operador y las públicas de lectura.
 *  - Sugiere una zona + familia LIMPIAS (sin colectivo activo ni reportes en 24 h) para
 *    demostrar la regla 9 + 1, una antena sin incidente activo y un índice inicial nuevo.
 * Uso: API_URL=... OPERATOR_USER=... OPERATOR_PASSWORD=... [AI_SERVICE_URL=...] npx tsx scripts/preflight-demo.ts
 */
const API = (process.env.API_URL ?? '').replace(/\/$/, '');
if (!API || !process.env.OPERATOR_USER || !process.env.OPERATOR_PASSWORD) {
  console.error('Defina API_URL, OPERATOR_USER y OPERATOR_PASSWORD');
  process.exit(2);
}
const rows: { check: string; ok: boolean; detail: string }[] = [];
const rec = (check: string, ok: boolean, detail = '') => rows.push({ check, ok, detail });

async function get(path: string, tok?: string) {
  const t0 = Date.now();
  const r = await fetch(`${API}${path}`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
  const body = (await r.json().catch(() => null)) as { data?: any } | null;
  return { status: r.status, data: body?.data, ms: Date.now() - t0 };
}

const health = await get('/health');
rec('API y modo nube', health.status === 200 && health.data?.mode === 'aws', `${health.data?.storage} · ${health.data?.orchestrator} · ${health.data?.queues}`);
rec('IA configurada en GCP', health.data?.ai === 'gcp-cloud-run-vertex-ai', String(health.data?.ai));
const portal = await fetch(`${API}/`);
rec('Portal HTTPS con CSP', portal.status === 200 && !!portal.headers.get('content-security-policy') && !!portal.headers.get('strict-transport-security'), `${portal.status}`);
const cat = await get('/catalog');
rec('Catálogo sintético', cat.status === 200 && cat.data?.zones?.length >= 5 && cat.data?.antennas?.length >= 12, `${cat.data?.zones?.length} zonas · ${cat.data?.antennas?.length} antenas`);
const lk = await fetch(`${API}/reports/lookup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'x'.repeat(43) }) });
rec('Consulta de ticket (token inválido => 404)', lk.status === 404, String(lk.status));
const noAuth = await get('/operator/incidents');
rec('Rutas de operador protegidas (sin token => 401)', noAuth.status === 401, String(noAuth.status));

const login = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.OPERATOR_USER, password: process.env.OPERATOR_PASSWORD }) });
const T = ((await login.json()) as { data?: { token: string } }).data?.token;
rec('Login de operador', login.status === 200 && !!T, String(login.status));
if (!T) {
  console.table(rows);
  process.exit(1);
}

const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
const [reports, antennas, metrics, active, closed, analytics, sim, proc] = await Promise.all([
  get(`/operator/reports?from=${encodeURIComponent(since)}&limit=1000`, T),
  get('/operator/antennas', T),
  get('/operator/antennas/ANT-SRN-01/metrics', T),
  get('/operator/incidents?active=true', T),
  get('/operator/incidents?active=false', T),
  get('/operator/analytics', T),
  get('/operator/simulator', T),
  get('/operator/processing', T),
]);
rec('GET /operator/reports', reports.status === 200, `${reports.data?.length} reportes en 24 h · ${reports.ms} ms`);
rec('GET /operator/antennas', antennas.status === 200 && antennas.data?.length >= 12, `${antennas.ms} ms`);
rec('GET /operator/antennas/{id}/metrics', metrics.status === 200, `${metrics.data?.metrics?.length} mediciones · ${metrics.data?.episodes?.length} episodios`);
rec('GET /operator/incidents (activos/cerrados)', active.status === 200 && closed.status === 200, `${active.data?.length} activos · ${closed.data?.length} cerrados`);
rec('GET /operator/analytics', analytics.status === 200 && analytics.data?.hasData, `MTTD ${analytics.data?.mttd?.avgMinutes ?? '—'} min · MTTR ${analytics.data?.mttr?.avgMinutes ?? '—'} min · ${analytics.ms} ms`);
rec('GET /operator/simulator', sim.status === 200, `${sim.data?.scenarios?.length} escenarios`);
rec('Step Functions sin fallos', proc.status === 200 && proc.data?.byStatus?.FALLIDO === 0, JSON.stringify(proc.data?.byStatus));
if (active.data?.[0]) {
  const id = active.data[0].incidentId;
  const [det, hist] = await Promise.all([get(`/operator/incidents/${id}`, T), get(`/operator/incidents/${id}/history`, T)]);
  rec('GET detalle + historial de incidente', det.status === 200 && hist.status === 200, `${hist.data?.length} eventos`);
}
const withAi = (active.data ?? []).filter((i: any) => i.ai);
const gemini = withAi.filter((i: any) => i.ai.source === 'VERTEX_AI_GEMINI');
rec('Análisis reales de Gemini presentes', gemini.length > 0, `${gemini.length}/${withAi.length} incidentes activos con IA usan Vertex AI`);

if (process.env.AI_SERVICE_URL) {
  const anon = await fetch(`${process.env.AI_SERVICE_URL.replace(/\/$/, '')}/v1/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  rec('Cloud Run rechaza llamadas anónimas', anon.status === 403, String(anon.status));
}

// ---- Recomendaciones para grabar ----
const families = [
  { problemType: 'SMS_NO_LLEGAN', family: 'MENSAJERIA', label: 'SMS no llegan' },
  { problemType: 'SIN_SENAL', family: 'CONECTIVIDAD', label: 'Sin señal / sin cobertura' },
];
const clean: string[] = [];
for (const z of cat.data.zones as { zoneId: string; name: string; criticality: string }[]) {
  for (const f of families) {
    const hasColl = (active.data ?? []).some((i: any) => i.kind === 'COLECTIVO' && i.zoneId === z.zoneId && i.family === f.family);
    const recent = (reports.data ?? []).filter((r: any) => r.zoneId === z.zoneId && r.family === f.family).length;
    if (!hasColl && recent === 0) clean.push(`${z.name} (${z.zoneId}, ${z.criticality}) + "${f.label}"`);
  }
}
const busyAntennas = new Set((active.data ?? []).filter((i: any) => i.kind === 'INFRAESTRUCTURA').map((i: any) => i.antennaIds[0]));
const freeAntennas = (antennas.data ?? []).filter((a: any) => !busyAntennas.has(a.antennaId) && !a.openEpisode).map((a: any) => `${a.antennaId} (${a.zoneName})`);
rec('Hay zona+familia limpia para la demo 9+1', clean.length > 0, `${clean.length} opciones`);

console.table(rows.map((r) => ({ '': r.ok ? '✅' : '❌', verificación: r.check, detalle: r.detail })));
console.log('\nRECOMENDACIONES PARA GRABAR');
console.log(' • Zona + tipo de problema LIMPIOS para la regla 9 + 1 (elija uno):');
for (const c of clean.slice(0, 6)) console.log(`     - ${c}`);
console.log(` • Antenas sin incidente activo (para "Antena inhabilitada"): ${freeAntennas.slice(0, 6).join(', ')}`);
console.log(` • Índice inicial sugerido (personas ficticias nuevas): ${3_000_000 + Math.floor(Math.random() * 900_000)}`);
const failed = rows.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} verificación(es) fallaron: revise antes de grabar.` : '\nTodo listo para grabar.');
process.exit(failed ? 1 : 0);
export {};
