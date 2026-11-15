/**
 * Servidor HTTP LOCAL (modo emulado). Usa EXACTAMENTE las mismas rutas y
 * servicios que las Lambdas; reemplaza sólo los adaptadores de infraestructura
 * (tabla en memoria con persistencia en .local/db.json, colas, Step Functions y
 * buzón de correo emulados). No equivale a la nube real.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { dispatch, envelope, errorToRes, matchRoute, parseBody, type Req } from '../handlers/api/http.js';
import { ALL_ROUTES } from '../handlers/api/routes.js';
import { HttpError } from '../lib/errors.js';
import { verifyJwt } from '../services/auth.js';
import { reconcileOutbox } from '../services/pipeline.js';
import { simulatorTick } from '../services/simulator.js';
import { createLocalEnv, loadOrCreateLocalMasterKey, type LocalEnv } from './localRuntime.js';
import { LOCAL_DB, LOCAL_DIR, LOCAL_MAIL } from './paths.js';

const PORT = Number(process.env.PORT ?? 3001);
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',');

export function startServer(env: LocalEnv, port = PORT) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    const cors: Record<string, string> =
      origin && ALLOWED_ORIGINS.includes(origin)
        ? { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type,authorization,idempotency-key', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS', vary: 'Origin' }
        : {};
    if (req.method === 'OPTIONS') {
      res.writeHead(origin && cors['access-control-allow-origin'] ? 204 : 403, cors).end();
      return;
    }
    const requestId = randomUUID();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (r: { status: number; body: string; headers: Record<string, string> }) => {
      res.writeHead(r.status, { ...r.headers, ...cors, 'x-mode': 'LOCAL-EMULADO' }).end(r.body);
    };
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of req) {
        size += (c as Buffer).length;
        if (size > 64 * 1024) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Cuerpo demasiado grande');
        chunks.push(c as Buffer);
      }
      const path = url.pathname;
      if (path === '/operator/local/pipeline' && req.method === 'GET') {
        await requireAuth(req.headers.authorization, 'OPERADOR');
        const execs = [...env.orchestrator.executions.values()].slice(-50).reverse().map((e) => ({ name: e.name, status: e.status, startedAt: e.startedAt, stoppedAt: e.stoppedAt, error: e.error, states: e.events.map((x) => `${x.state}:${x.type}${x.detail ? `(${x.detail})` : ''}`) }));
        send(envelope({ status: 200, body: { emulated: true, queues: [env.events.stats(), env.notifications.stats()], executions: execs } }, requestId));
        return;
      }
      const m = matchRoute(ALL_ROUTES, req.method ?? 'GET', path);
      if (!m) throw new HttpError(404, 'NOT_FOUND', 'Ruta no encontrada');
      const r: Req = {
        method: req.method ?? 'GET',
        path,
        params: m.params,
        query: Object.fromEntries(url.searchParams.entries()),
        body: parseBody(Buffer.concat(chunks).toString('utf8') || undefined),
        headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
        requestId,
        sourceIp: req.socket.remoteAddress ?? '127.0.0.1',
      };
      if (m.route.auth !== 'public') {
        const c = await requireAuth(req.headers.authorization, m.route.auth === 'ingest' ? 'ANY' : 'OPERADOR');
        r.auth = { sub: c.sub, role: c.role };
      }
      send(await dispatch(m.route, r));
    } catch (e) {
      send(envelope(errorToRes(e, requestId), requestId));
    }
  });
  server.listen(port);
  return server;
}

async function requireAuth(header: string | undefined, role: 'OPERADOR' | 'ANY') {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'UNAUTHORIZED', 'No autenticado');
  const c = await verifyJwt(token);
  if (role === 'OPERADOR' && c.role !== 'OPERADOR') throw new HttpError(403, 'FORBIDDEN', 'Se requiere rol OPERADOR');
  return c;
}

const isMain = process.argv[1] && /server\.(ts|js|mjs)$/.test(process.argv[1]);
if (isMain) {
  const env = createLocalEnv({ dataFile: LOCAL_DB, mailDir: LOCAL_MAIL, masterKey: loadOrCreateLocalMasterKey(LOCAL_DIR) });
  startServer(env);
  const simOn = process.env.LOCAL_SIMULATOR !== 'off';
  if (simOn) {
    void simulatorTick().catch(() => undefined);
    setInterval(() => void simulatorTick().catch(() => undefined), 60_000);
  }
  setInterval(() => void reconcileOutbox().catch(() => undefined), 120_000);
  process.on('SIGINT', () => {
    env.store.flush();
    process.exit(0);
  });
  console.log(`TeleCorp Sentinel API LOCAL (EMULADA) en http://localhost:${PORT} — simulador ${simOn ? 'activo (cada 60 s)' : 'apagado'}; datos en .local/`);
}
