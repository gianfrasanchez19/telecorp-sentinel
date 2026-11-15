import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Claves derivadas (HKDF-SHA256) de UNA clave maestra guardada en AWS Secrets
 * Manager. Cada propósito usa una subclave distinta; nunca se reutiliza material.
 */
export interface DerivedKeys {
  jwt: Buffer; // firma HS256 de tokens de operador
  pseudonym: Buffer; // HMAC de identidades normalizadas (conteo de personas)
  pii: Buffer; // AES-256-GCM de datos de contacto
  ticket: Buffer; // derivación de tokens de consulta de ticket
  aiHmac: Buffer; // firma de solicitudes al servicio IA (modo alternativo HMAC)
  ipHash: Buffer; // seudonimización de IP para rate limiting
}

export function deriveKeys(master: string): DerivedKeys {
  if (!master || master.length < 32) throw new Error('Clave maestra ausente o demasiado corta');
  const ikm = Buffer.from(master, 'utf8');
  const d = (info: string) => Buffer.from(hkdfSync('sha256', ikm, Buffer.from('telecorp-sentinel/v1'), Buffer.from(info), 32));
  return { jwt: d('jwt'), pseudonym: d('pseudonym'), pii: d('pii'), ticket: d('ticket'), aiHmac: d('ai-hmac'), ipHash: d('ip-hash') };
}

export function hmacHex(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

export function hmacB64u(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function randomId(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Identificador opaco legible (sin información del usuario). */
export function opaqueId(prefix: string, len = 10): string {
  const b = randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += CROCKFORD[b[i] % 32];
  return `${prefix}-${s}`;
}

/** Cifrado de campo AES-256-GCM. Formato: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptField(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptField(key: Buffer, blob: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1') throw new Error('Formato de cifrado desconocido');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** JSON canónico (claves ordenadas) para hashes estables. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}
