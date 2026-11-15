import type { ZoneCriticality } from './catalog.js';
import { STATUS_SEVERITY, type AntennaStatus } from './telemetry.js';

export type PriorityLevel = 'CRITICA' | 'ALTA' | 'MEDIA' | 'BAJA';

/**
 * Puntuación DETERMINISTA y explicable (0–100). Pesos y umbrales configurables
 * por la variable de entorno PRIORITY_CONFIG_JSON (mismo formato que este objeto).
 * La IA nunca modifica esta puntuación.
 */
export interface PriorityConfig {
  weights: { reporters: number; estimatedUsers: number; zoneCriticality: number; antennaSeverity: number; duration: number };
  /** Reportantes únicos con los que el factor se satura (escala logarítmica). */
  reportersSaturation: number;
  /** Usuarios estimados con los que el factor se satura. */
  estimatedUsersSaturation: number;
  /** Horas con las que el factor duración se satura. */
  durationSaturationHours: number;
  criticality: Record<ZoneCriticality, number>;
  levels: { CRITICA: number; ALTA: number; MEDIA: number };
}

export const DEFAULT_PRIORITY_CONFIG: PriorityConfig = {
  weights: { reporters: 25, estimatedUsers: 20, zoneCriticality: 20, antennaSeverity: 20, duration: 15 },
  reportersSaturation: 50,
  estimatedUsersSaturation: 20_000,
  durationSaturationHours: 12,
  criticality: { HOSPITAL: 1, SERVICIOS_CRITICOS: 1, EDUCACION: 0.7, INDUSTRIAL: 0.6, RESIDENCIAL: 0.4 },
  levels: { CRITICA: 65, ALTA: 45, MEDIA: 25 },
};

export function loadPriorityConfig(): PriorityConfig {
  const raw = process.env.PRIORITY_CONFIG_JSON;
  if (!raw) return DEFAULT_PRIORITY_CONFIG;
  const o = JSON.parse(raw) as Partial<PriorityConfig>;
  return { ...DEFAULT_PRIORITY_CONFIG, ...o, weights: { ...DEFAULT_PRIORITY_CONFIG.weights, ...(o.weights ?? {}) } };
}

export interface PriorityInput {
  uniqueReporters: number;
  /** Estimado de catálogo, ya deduplicado por celdas solapadas. */
  estimatedUsers: number;
  zoneCriticality: ZoneCriticality;
  /** Peor estado actual entre las antenas vinculadas (undefined si ninguna anómala). */
  worstAntennaStatus?: AntennaStatus;
  openedAt: string;
  now: Date;
}

export interface PriorityFactor {
  factor: 'REPORTANTES_UNICOS' | 'USUARIOS_ESTIMADOS' | 'CRITICIDAD_ZONA' | 'GRAVEDAD_ANTENAS' | 'DURACION';
  value: number | string;
  normalized: number;
  points: number;
  explanation: string;
}

export interface PriorityResult {
  score: number;
  level: PriorityLevel;
  factors: PriorityFactor[];
  configVersion: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function computePriority(i: PriorityInput, cfg: PriorityConfig = DEFAULT_PRIORITY_CONFIG): PriorityResult {
  const w = cfg.weights;
  const rNorm = Math.min(1, Math.log10(1 + Math.max(0, i.uniqueReporters)) / Math.log10(1 + cfg.reportersSaturation));
  const uNorm = Math.min(1, Math.max(0, i.estimatedUsers) / cfg.estimatedUsersSaturation);
  const zNorm = cfg.criticality[i.zoneCriticality];
  const aNorm = i.worstAntennaStatus ? STATUS_SEVERITY[i.worstAntennaStatus] : 0;
  const hours = Math.max(0, (i.now.getTime() - new Date(i.openedAt).getTime()) / 3_600_000);
  const dNorm = Math.min(1, hours / cfg.durationSaturationHours);

  const factors: PriorityFactor[] = [
    { factor: 'REPORTANTES_UNICOS', value: i.uniqueReporters, normalized: rNorm, points: round1(rNorm * w.reporters), explanation: `${i.uniqueReporters} reportantes únicos (escala log, satura en ${cfg.reportersSaturation})` },
    { factor: 'USUARIOS_ESTIMADOS', value: i.estimatedUsers, normalized: uNorm, points: round1(uNorm * w.estimatedUsers), explanation: `${i.estimatedUsers} usuarios potencialmente afectados (ESTIMADO de catálogo, celdas sin duplicar)` },
    { factor: 'CRITICIDAD_ZONA', value: i.zoneCriticality, normalized: zNorm, points: round1(zNorm * w.zoneCriticality), explanation: `Zona ${i.zoneCriticality}` },
    { factor: 'GRAVEDAD_ANTENAS', value: i.worstAntennaStatus ?? 'SIN_ANOMALIA', normalized: aNorm, points: round1(aNorm * w.antennaSeverity), explanation: i.worstAntennaStatus ? `Peor estado de antena vinculada: ${i.worstAntennaStatus}` : 'Sin antenas anómalas vinculadas' },
    { factor: 'DURACION', value: round1(hours), normalized: dNorm, points: round1(dNorm * w.duration), explanation: `${round1(hours)} h desde la apertura (satura en ${cfg.durationSaturationHours} h)` },
  ];
  const score = round1(factors.reduce((a, f) => a + f.points, 0));
  const level: PriorityLevel = score >= cfg.levels.CRITICA ? 'CRITICA' : score >= cfg.levels.ALTA ? 'ALTA' : score >= cfg.levels.MEDIA ? 'MEDIA' : 'BAJA';
  return { score, level, factors, configVersion: 'v1' };
}

export const LEVEL_RANK: Record<PriorityLevel, number> = { CRITICA: 4, ALTA: 3, MEDIA: 2, BAJA: 1 };
