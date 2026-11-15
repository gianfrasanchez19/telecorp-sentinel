/**
 * Logs JSON estructurados con el formato estándar del curso (Semana 12):
 *   { "tipo": "INFO" | "ERROR" | "WARN", "log_datos": { ... } }
 * Consultables con CloudWatch Logs Insights, p. ej.:
 *   fields @timestamp, log_datos.evento | filter tipo = "ERROR"
 * Nunca se registran datos personales: las claves sensibles se enmascaran.
 */
const SENSITIVE_KEYS = /^(documentNumber|serviceNumber|email|phone|contact|token|password|authorization|description|locationHint|normalizedIdentity|secret|masterKey)$/i;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 6 || v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE_KEYS.test(k) ? '[REDACTADO]' : scrub(val, depth + 1);
    return out;
  }
  if (typeof v === 'string' && v.length > 500) return `${v.slice(0, 500)}…`;
  return v;
}

type Level = 'INFO' | 'WARN' | 'ERROR';

let baseContext: Record<string, unknown> = {};
export function setLogContext(ctx: Record<string, unknown>): void {
  baseContext = { ...ctx };
}

function write(tipo: Level, evento: string, datos: Record<string, unknown> = {}): void {
  if (process.env.LOG_SILENT === '1') return;
  const line = JSON.stringify({ tipo, log_datos: { evento, ts: new Date().toISOString(), ...baseContext, ...(scrub(datos) as object) } });
  if (tipo === 'ERROR') console.error(line);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  info: (evento: string, datos?: Record<string, unknown>) => write('INFO', evento, datos),
  warn: (evento: string, datos?: Record<string, unknown>) => write('WARN', evento, datos),
  error: (evento: string, err: unknown, datos?: Record<string, unknown>) =>
    write('ERROR', evento, { ...datos, error: err instanceof Error ? { name: err.name, message: err.message } : String(err) }),
};
