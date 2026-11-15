import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { hmacHex, randomId } from '../../lib/crypto.js';
import { HttpError } from '../../lib/errors.js';
import { log, setLogContext } from '../../lib/logger.js';
import { getKeys } from '../../lib/secrets.js';
import type { Claims } from '../../services/auth.js';

export interface Req {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  requestId: string;
  sourceIp: string;
  auth?: Pick<Claims, 'sub' | 'role'>;
}

export interface Res {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: Req) => Promise<Res>;

export interface Route {
  method: 'GET' | 'POST' | 'PATCH';
  path: string; // con {param}
  handler: Handler;
  auth: 'public' | 'operator' | 'ingest';
}

const MAX_BODY = 32 * 1024;

export function matchRoute(routes: Route[], method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
  for (const r of routes) {
    if (r.method !== method) continue;
    const names: string[] = [];
    const re = new RegExp(`^${r.path.replace(/\{(\w+)\}/g, (_, n) => (names.push(n), '([^/]+)'))}$`);
    const m = re.exec(path);
    if (m) return { route: r, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return undefined;
}

export function ok(body: unknown, status = 200): Res {
  return { status, body };
}

export function envelope(res: Res, requestId: string): { status: number; body: string; headers: Record<string, string> } {
  const payload = res.status >= 400 ? { ...(res.body as object), meta: { requestId } } : { data: res.body, meta: { requestId } };
  return {
    status: res.status,
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': requestId, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...(res.headers ?? {}) },
  };
}

export function errorToRes(e: unknown, requestId: string): Res {
  if (e instanceof HttpError) return { status: e.status, body: { error: { code: e.code, message: e.message, details: e.details } } };
  log.error('error_no_controlado', e, { requestId });
  return { status: 500, body: { error: { code: 'INTERNAL', message: 'Error interno. Use el requestId para soporte.' } } };
}

export async function ipHashOf(ip: string): Promise<string> {
  const keys = await getKeys();
  return hmacHex(keys.ipHash, ip || 'desconocida');
}

/** Ejecuta una ruta ya resuelta (común a Lambda y servidor local). */
export async function dispatch(route: Route, req: Req): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  setLogContext({ requestId: req.requestId, route: `${route.method} ${route.path}` });
  const started = Date.now();
  let res: Res;
  try {
    res = await route.handler(req);
  } catch (e) {
    res = errorToRes(e, req.requestId);
  }
  log.info('http', { status: res.status, ms: Date.now() - started });
  return envelope(res, req.requestId);
}

export function parseBody(raw: string | undefined, isBase64?: boolean): unknown {
  if (!raw) return undefined;
  const txt = isBase64 ? Buffer.from(raw, 'base64').toString('utf8') : raw;
  if (Buffer.byteLength(txt) > MAX_BODY) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Cuerpo demasiado grande');
  try {
    return JSON.parse(txt);
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'El cuerpo no es JSON válido');
  }
}

/** Adaptador API Gateway HTTP API (payload v2) -> rutas. */
export function lambdaApi(routes: Route[]) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const requestId = event.requestContext?.requestId ?? randomId(8);
    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/^\/(dev|test|prod)(?=\/)/, '');
    const m = matchRoute(routes, method, path);
    if (!m) {
      const r = envelope({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'Ruta no encontrada' } } }, requestId);
      return { statusCode: r.status, body: r.body, headers: r.headers };
    }
    let body: unknown;
    try {
      body = parseBody(event.body, event.isBase64Encoded);
    } catch (e) {
      const r = envelope(errorToRes(e, requestId), requestId);
      return { statusCode: r.status, body: r.body, headers: r.headers };
    }
    const authCtx = (event.requestContext as unknown as { authorizer?: { lambda?: { sub?: string; role?: string } } }).authorizer?.lambda;
    const req: Req = {
      method,
      path,
      params: { ...(event.pathParameters ?? {}), ...m.params } as Record<string, string>,
      query: (event.queryStringParameters ?? {}) as Record<string, string>,
      body,
      headers: Object.fromEntries(Object.entries(event.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      requestId,
      sourceIp: event.requestContext.http.sourceIp,
      auth: authCtx?.sub ? { sub: authCtx.sub, role: authCtx.role as Claims['role'] } : undefined,
    };
    if (m.route.auth !== 'public' && !req.auth) {
      const r = envelope({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'No autenticado' } } }, requestId);
      return { statusCode: r.status, body: r.body, headers: r.headers };
    }
    const r = await dispatch(m.route, req);
    return { statusCode: r.status, body: r.body, headers: r.headers };
  };
}
