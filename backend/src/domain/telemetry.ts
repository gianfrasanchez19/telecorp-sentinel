import { z } from 'zod';
import { isValidZone, getAntenna } from './catalog.js';
import type { DomainConfig } from './config.js';

export type AntennaStatus = 'INHABILITADA' | 'CAIDA' | 'NORMAL' | 'SATURADA';
/** Estado mostrado: agrega SIN_DATOS cuando no hay lecturas recientes (distinto de 0). */
export type AntennaDisplayStatus = AntennaStatus | 'SIN_DATOS';

/**
 * Clasificación EXACTA de la métrica gbPerMinute:
 *   x === 0          -> INHABILITADA (el cero tiene precedencia)
 *   0 < x < 60       -> CAIDA
 *   60 <= x <= 129   -> NORMAL
 *   x > 129          -> SATURADA
 * Valores negativos o no finitos se rechazan (lanzan error).
 */
export function classifyGbPerMinute(x: number): AntennaStatus {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new RangeError('gbPerMinute debe ser un número finito');
  if (x < 0) throw new RangeError('gbPerMinute no puede ser negativo');
  if (x === 0) return 'INHABILITADA';
  if (x < 60) return 'CAIDA';
  if (x <= 129) return 'NORMAL';
  return 'SATURADA';
}

export function isAnomalous(s: AntennaStatus): boolean {
  return s !== 'NORMAL';
}

/** Gravedad usada para prioridad y para decidir escalamientos. */
export const STATUS_SEVERITY: Record<AntennaStatus, number> = {
  NORMAL: 0,
  SATURADA: 0.5,
  CAIDA: 0.8,
  INHABILITADA: 1,
};

export const telemetryInputSchema = z
  .object({
    eventId: z.string().trim().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/, 'eventId con caracteres no permitidos'),
    antennaId: z.string().trim().min(1).max(40),
    zoneId: z.string().trim().min(1).max(40),
    gbPerMinute: z.number().refine(Number.isFinite, 'gbPerMinute debe ser finito').refine((v) => v >= 0, 'gbPerMinute no puede ser negativo'),
    observedAt: z.iso.datetime({ offset: true }),
    synthetic: z.boolean().optional(),
  })
  .strict();

export type TelemetryInput = z.infer<typeof telemetryInputSchema>;

export interface ValidatedTelemetry extends TelemetryInput {
  observedAt: string; // ISO UTC normalizado
  status: AntennaStatus;
}

export class DomainValidationError extends Error {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainValidationError';
  }
}

export function validateTelemetry(raw: unknown, now: Date, cfg: DomainConfig): ValidatedTelemetry {
  const parsed = telemetryInputSchema.safeParse(raw);
  if (!parsed.success) throw new DomainValidationError('Métrica inválida', parsed.error.issues);
  const t = parsed.data;
  if (!isValidZone(t.zoneId)) throw new DomainValidationError('zoneId no existe en el catálogo');
  const ant = getAntenna(t.antennaId);
  if (!ant) throw new DomainValidationError('antennaId no existe en el catálogo');
  if (ant.zoneId !== t.zoneId) throw new DomainValidationError('La antena no pertenece a la zona indicada');
  const obs = new Date(t.observedAt);
  if (obs.getTime() > now.getTime() + cfg.maxClockSkewMs) throw new DomainValidationError('observedAt está en el futuro');
  if (obs.getTime() < now.getTime() - cfg.maxTelemetryAgeMs) throw new DomainValidationError('observedAt demasiado antiguo');
  return { ...t, observedAt: obs.toISOString(), status: classifyGbPerMinute(t.gbPerMinute) };
}

/** Estado persistido de cada antena (proyección actual). */
export interface AntennaState {
  antennaId: string;
  zoneId: string;
  lastObservedAt?: string;
  lastValue?: number;
  status?: AntennaStatus;
  consecutiveNormal: number;
  consecutiveAnomalous: number;
  openEpisode?: EpisodeState;
  /** Valores recientes (máx. 10) para tendencia. */
  recent: { at: string; v: number }[];
  lateReadings: number;
  version: number;
}

export interface EpisodeState {
  episodeId: string;
  startedAt: string;
  worstStatus: AntennaStatus;
  currentStatus: AntennaStatus;
  anomalousReadings: number;
}

export type AntennaTransition =
  | { kind: 'EPISODE_OPENED'; episode: EpisodeState }
  | { kind: 'EPISODE_SEVERITY_CHANGED'; episode: EpisodeState; from: AntennaStatus; to: AntennaStatus }
  | { kind: 'EPISODE_RECOVERED'; episode: EpisodeState; endedAt: string; normalReadings: number };

export interface ApplyResult {
  state: AntennaState;
  transitions: AntennaTransition[];
  /** true si la lectura fue anterior a la última aplicada: se guarda pero no retrocede el estado. */
  late: boolean;
}

export function emptyAntennaState(antennaId: string, zoneId: string): AntennaState {
  return { antennaId, zoneId, consecutiveNormal: 0, consecutiveAnomalous: 0, recent: [], lateReadings: 0, version: 0 };
}

/**
 * Aplica una lectura al estado de la antena (función pura).
 * - Abre un EPISODIO desde la primera lectura anómala (no uno por minuto).
 * - Cambios de severidad dentro del episodio son "cambios materiales".
 * - Cierra el episodio sólo tras N lecturas normales consecutivas (política configurable).
 * - Métricas fuera de orden no hacen retroceder el estado actual.
 */
export function applyReading(prev: AntennaState, r: { eventId: string; observedAt: string; gbPerMinute: number }, cfg: DomainConfig): ApplyResult {
  const status = classifyGbPerMinute(r.gbPerMinute);
  if (prev.lastObservedAt && r.observedAt <= prev.lastObservedAt) {
    return { state: { ...prev, lateReadings: prev.lateReadings + 1 }, transitions: [], late: true };
  }
  const s: AntennaState = {
    ...prev,
    lastObservedAt: r.observedAt,
    lastValue: r.gbPerMinute,
    status,
    recent: [...prev.recent, { at: r.observedAt, v: r.gbPerMinute }].slice(-10),
  };
  const transitions: AntennaTransition[] = [];
  if (isAnomalous(status)) {
    s.consecutiveAnomalous = prev.consecutiveAnomalous + 1;
    s.consecutiveNormal = 0;
    if (!prev.openEpisode) {
      const episode: EpisodeState = {
        episodeId: `EPI-${prev.antennaId}-${r.observedAt.replace(/[^0-9]/g, '').slice(0, 14)}`,
        startedAt: r.observedAt,
        worstStatus: status,
        currentStatus: status,
        anomalousReadings: 1,
      };
      s.openEpisode = episode;
      transitions.push({ kind: 'EPISODE_OPENED', episode });
    } else {
      const ep = prev.openEpisode;
      const worst = STATUS_SEVERITY[status] > STATUS_SEVERITY[ep.worstStatus] ? status : ep.worstStatus;
      const next: EpisodeState = { ...ep, currentStatus: status, worstStatus: worst, anomalousReadings: ep.anomalousReadings + 1 };
      s.openEpisode = next;
      if (status !== ep.currentStatus) transitions.push({ kind: 'EPISODE_SEVERITY_CHANGED', episode: next, from: ep.currentStatus, to: status });
    }
  } else {
    s.consecutiveNormal = prev.consecutiveNormal + 1;
    s.consecutiveAnomalous = 0;
    if (prev.openEpisode) {
      const ep = { ...prev.openEpisode, currentStatus: status };
      if (s.consecutiveNormal >= cfg.recoveryConsecutiveNormal) {
        transitions.push({ kind: 'EPISODE_RECOVERED', episode: ep, endedAt: r.observedAt, normalReadings: s.consecutiveNormal });
        s.openEpisode = undefined;
      } else {
        s.openEpisode = ep;
      }
    }
  }
  return { state: s, transitions, late: false };
}

/** Estado a mostrar: SIN_DATOS si no hay lectura reciente (no se confunde con valor 0). */
export function displayStatus(state: Pick<AntennaState, 'lastObservedAt' | 'status'> | undefined, now: Date, cfg: DomainConfig): AntennaDisplayStatus {
  if (!state?.lastObservedAt || !state.status) return 'SIN_DATOS';
  if (now.getTime() - new Date(state.lastObservedAt).getTime() > cfg.missingDataAfterMs) return 'SIN_DATOS';
  return state.status;
}

/** Tendencia simple sobre las últimas lecturas. */
export function trend(recent: { v: number }[]): 'SUBE' | 'BAJA' | 'ESTABLE' | 'SIN_DATOS' {
  if (recent.length < 2) return 'SIN_DATOS';
  const half = Math.floor(recent.length / 2);
  const avg = (xs: { v: number }[]) => xs.reduce((a, b) => a + b.v, 0) / xs.length;
  const a = avg(recent.slice(0, half));
  const b = avg(recent.slice(half));
  const delta = b - a;
  if (Math.abs(delta) < 5) return 'ESTABLE';
  return delta > 0 ? 'SUBE' : 'BAJA';
}
