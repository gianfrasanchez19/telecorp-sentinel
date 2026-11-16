import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

/**
 * Sirve la SPA (portal + consola) desde el MISMO API Gateway HTTPS.
 * Motivo: AWS Academy bloquea CloudFront y el sitio web de S3 sólo ofrece HTTP; así
 * el portal viaja con TLS, comparte origen con la API (sin CORS) y lleva cabeceras
 * de seguridad estrictas (CSP, HSTS, anti-framing).
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};
const TEXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.txt']);

export const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
};

const cache = new Map<string, Buffer>();
function load(file: string): Buffer | undefined {
  if (cache.has(file)) return cache.get(file);
  if (!existsSync(file)) return undefined;
  const b = readFileSync(file);
  cache.set(file, b);
  return b;
}

export function resolveAsset(rawPath: string): { file: string; spaFallback: boolean } {
  const clean = decodeURIComponent(rawPath.split('?')[0]).replace(/\\/g, '/');
  const rel = normalize(clean).replace(/^([/\\])+/, '');
  const full = join(ROOT, rel);
  // Bloquea path traversal: el archivo debe quedar dentro de ROOT.
  if (!full.startsWith(ROOT + sep) && full !== ROOT) return { file: join(ROOT, 'index.html'), spaFallback: true };
  if (rel && extname(rel) && existsSync(full)) return { file: full, spaFallback: false };
  return { file: join(ROOT, 'index.html'), spaFallback: true }; // rutas del cliente (/reportar, /operador/…)
}

export async function webApp(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const path = event.rawPath || '/';
  const { file, spaFallback } = resolveAsset(path);
  const ext = extname(file);
  // Un recurso con extensión que no existe => 404 real (no devolver HTML como JS).
  if (spaFallback && extname(path)) {
    return { statusCode: 404, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }, body: 'No encontrado' };
  }
  const body = load(file);
  if (!body) return { statusCode: 503, headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS }, body: 'Frontend no empaquetado' };
  const immutable = path.startsWith('/assets/');
  return {
    statusCode: 200,
    headers: {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...SECURITY_HEADERS,
    },
    body: TEXT.has(ext) ? body.toString('utf8') : body.toString('base64'),
    isBase64Encoded: !TEXT.has(ext),
  };
}
