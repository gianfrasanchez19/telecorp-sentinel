/**
 * Smoke test contra una API desplegada (o la local). Sólo datos SINTÉTICOS.
 * Uso: API_URL=https://xxx.execute-api.us-east-1.amazonaws.com [OPERATOR_USER=.. OPERATOR_PASSWORD=..] npx tsx scripts/smoke-test.ts
 */
import { randomUUID } from 'node:crypto';

const API = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const results: { check: string; ok: boolean; detail: string }[] = [];
const rec = (check: string, ok: boolean, detail = '') => results.push({ check, ok, detail });
const j = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${API}${path}`, init);
  return { status: r.status, body: (await r.json().catch(() => null)) as any, headers: r.headers };
};

const h = await j('/health');
rec('GET /health', h.status === 200, `modo=${h.body?.data?.mode} ia=${h.body?.data?.ai}`);

const rep = await j('/reports', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ documentType: 'DNI', documentNumber: String(70000000 + Math.floor(Math.random() * 999999)), serviceNumber: '999000111', zoneId: 'Z-MIR', occurredAt: new Date(Date.now() - 60_000).toISOString(), problemType: 'INTERNET_LENTO', description: 'Prueba de humo (dato sintético)', idempotencyKey: randomUUID().replace(/-/g, ''), synthetic: true }),
});
rec('POST /reports (durable)', rep.status === 201, `ticket=${rep.body?.data?.ticketId}`);
const bad = await j('/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ zoneId: 'NOPE' }) });
rec('POST /reports inválido => 400', bad.status === 400, `code=${bad.body?.error?.code}`);
if (rep.body?.data?.token) {
  await new Promise((r) => setTimeout(r, 4000));
  const lk = await j('/reports/lookup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: rep.body.data.token }) });
  rec('POST /reports/lookup (token en body)', lk.status === 200 && !JSON.stringify(lk.body).includes('999000111'), `estado=${lk.body?.data?.status}`);
}
const noAuth = await j('/operator/incidents');
rec('GET /operator/incidents sin token => 401/403', noAuth.status === 401 || noAuth.status === 403, `status=${noAuth.status}`);
const cors = await fetch(`${API}/reports`, { method: 'OPTIONS', headers: { Origin: 'https://origen-no-permitido.example', 'Access-Control-Request-Method': 'POST' } });
rec('CORS rechaza origen no permitido', !cors.headers.get('access-control-allow-origin'), `allow-origin=${cors.headers.get('access-control-allow-origin') ?? '(ninguno)'}`);

if (process.env.OPERATOR_USER && process.env.OPERATOR_PASSWORD) {
  const l = await j('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: process.env.OPERATOR_USER, password: process.env.OPERATOR_PASSWORD }) });
  rec('POST /auth/login', l.status === 200, '');
  const tok = l.body?.data?.token;
  if (tok) {
    const inc = await j('/operator/incidents', { headers: { authorization: `Bearer ${tok}` } });
    rec('GET /operator/incidents con token', inc.status === 200, `${inc.body?.data?.length} activos`);
    const pr = await j('/operator/processing', { headers: { authorization: `Bearer ${tok}` } });
    rec('GET /operator/processing', pr.status === 200, JSON.stringify(pr.body?.data?.byStatus));
  }
}

console.table(results);
const failed = results.filter((r) => !r.ok).length;
console.log(`${API} — ${results.length - failed}/${results.length} verificaciones OK (${new Date().toISOString()})`);
process.exit(failed ? 1 : 0);
