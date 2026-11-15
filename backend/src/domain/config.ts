/**
 * Parámetros de dominio. Los valores por defecto son SUPUESTOS DE DISEÑO
 * documentados en README (sección "Reglas de negocio") y pueden sobrescribirse
 * por variables de entorno sin cambiar código.
 */
export interface DomainConfig {
  /** Usuarios distintos necesarios para un posible incidente colectivo. */
  collectiveThreshold: number;
  /** Ventana móvil (ms). Se exige diferencia ESTRICTAMENTE menor. */
  collectiveWindowMs: number;
  /** Lecturas normales consecutivas para considerar recuperación técnica. */
  recoveryConsecutiveNormal: number;
  /** Recurrencia: episodios distintos dentro de la ventana. */
  recurrenceEpisodes: number;
  recurrenceWindowMs: number;
  /** Sin lectura durante este tiempo => SIN_DATOS (distinto de valor 0). */
  missingDataAfterMs: number;
  /** Tolerancia de reloj para fechas futuras. */
  maxClockSkewMs: number;
  /** Antigüedad máxima aceptada para un reporte. */
  maxReportAgeMs: number;
  /** Reportes más antiguos que esto se registran y asocian, pero no abren colectivos nuevos. */
  lateReportNoOpenMs: number;
  /** Antigüedad máxima aceptada para una métrica tardía. */
  maxTelemetryAgeMs: number;
}

const H = 3_600_000;

function num(name: string, def: number): number {
  const raw = typeof process !== 'undefined' ? process.env[name] : undefined;
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Configuración inválida ${name}=${raw}`);
  return n;
}

export function loadDomainConfig(): DomainConfig {
  return {
    collectiveThreshold: num('COLLECTIVE_THRESHOLD', 10),
    collectiveWindowMs: num('COLLECTIVE_WINDOW_HOURS', 24) * H,
    recoveryConsecutiveNormal: num('RECOVERY_CONSECUTIVE_NORMAL', 3),
    recurrenceEpisodes: num('RECURRENCE_EPISODES', 3),
    recurrenceWindowMs: num('RECURRENCE_WINDOW_DAYS', 7) * 24 * H,
    missingDataAfterMs: num('MISSING_DATA_AFTER_MINUTES', 3) * 60_000,
    maxClockSkewMs: num('MAX_CLOCK_SKEW_MINUTES', 5) * 60_000,
    maxReportAgeMs: num('MAX_REPORT_AGE_DAYS', 7) * 24 * H,
    lateReportNoOpenMs: num('LATE_REPORT_NO_OPEN_HOURS', 72) * H,
    maxTelemetryAgeMs: num('MAX_TELEMETRY_AGE_HOURS', 24) * H,
  };
}

export const DEFAULT_CONFIG: DomainConfig = loadDomainConfig();
