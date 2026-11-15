import { randomBytes, scryptSync } from 'node:crypto';
import { hmacB64u, randomId, safeEqual } from '../lib/crypto.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { getKeys } from '../lib/secrets.js';
import { K } from '../repo/keys.js';
import { checkRateLimit } from './reports.js';
import { rt } from './runtime.js';

/**
 * Autenticación de operadores equivalente a Cognito/JWT.
 * Motivo: el material del curso (Semana 10, Serverless Taller 1) indica que
 * Cognito NO está disponible en AWS Academy; se sigue el patrón enseñado
 * (usuarios en DynamoDB + Lambda que valida el token) reforzado con:
 *  - contraseñas con scrypt + sal,
 *  - JWT HS256 firmado con una subclave derivada del secreto en AWS Secrets Manager,
 *  - expiración corta, emisor/audiencia verificados,
 *  - Lambda Authorizer de API Gateway (HTTP API) en todas las rutas /operator/*.
 */
export type Role = 'OPERADOR' | 'INGESTA';

export interface Claims {
  sub: string;
  role: Role;
  iat: number;
  exp: number;
  iss: string;
  aud: string;
  jti: string;
}

const ISS = 'telecorp-sentinel';
const AUD = 'telecorp-operator-api';
const TTL_SECONDS = 60 * 60;

export function hashPassword(password: string): string {
  if (password.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres');
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, N, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const h = scryptSync(password, Buffer.from(salt, 'base64url'), 32, { N: Number(N), r: Number(r), p: Number(p) });
  return safeEqual(h.toString('base64url'), hash);
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function signJwt(sub: string, role: Role, ttl = TTL_SECONDS): Promise<{ token: string; expiresAt: string }> {
  const keys = await getKeys();
  const now = Math.floor(Date.now() / 1000);
  const claims: Claims = { sub, role, iat: now, exp: now + ttl, iss: ISS, aud: AUD, jti: randomId(12) };
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(claims);
  const sig = hmacB64u(keys.jwt, `${head}.${body}`);
  return { token: `${head}.${body}.${sig}`, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

export async function verifyJwt(token: string): Promise<Claims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw unauthorized('Token mal formado');
  const [h, b, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string };
  if (header.alg !== 'HS256') throw unauthorized('Algoritmo no permitido');
  const keys = await getKeys();
  if (!safeEqual(hmacB64u(keys.jwt, `${h}.${b}`), s)) throw unauthorized('Firma inválida');
  const c = JSON.parse(Buffer.from(b, 'base64url').toString()) as Claims;
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== ISS || c.aud !== AUD) throw unauthorized('Emisor o audiencia inválidos');
  if (typeof c.exp !== 'number' || c.exp < now) throw unauthorized('Token expirado');
  if (c.role !== 'OPERADOR' && c.role !== 'INGESTA') throw unauthorized('Rol inválido');
  return c;
}

export async function createUser(username: string, password: string, role: Role, displayName: string): Promise<void> {
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) throw new Error('Usuario inválido (a-z, 0-9, ., _, -)');
  const { store } = await rt();
  await store.put({ ...K.user(username), entity: 'USER', username, displayName, role, passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
}

export async function login(raw: unknown, ipHash: string): Promise<{ token: string; expiresAt: string; user: { username: string; displayName: string; role: Role } }> {
  const body = raw as { username?: unknown; password?: unknown };
  if (typeof body?.username !== 'string' || typeof body?.password !== 'string' || body.password.length > 200) throw badRequest('Usuario y contraseña requeridos');
  await checkRateLimit(`login:${ipHash}`, 10);
  const { store } = await rt();
  const u = await store.get(K.user(body.username).pk, 'USER', { consistent: true });
  // Mismo mensaje y verificación de costo similar para usuario inexistente.
  const ok = u ? verifyPassword(body.password, u.passwordHash as string) : (verifyPassword(body.password, 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
  if (!u || !ok) {
    log.warn('login_fallido', { ipHash: ipHash.slice(0, 8) });
    throw unauthorized('Credenciales inválidas');
  }
  const { token, expiresAt } = await signJwt(u.username as string, u.role as Role);
  return { token, expiresAt, user: { username: u.username as string, displayName: u.displayName as string, role: u.role as Role } };
}
