import type { CaseStatus } from './reports.js';

/**
 * Máquina de estados de reportes e incidentes.
 * La reapertura (CERRADA/SOLUCIONADA -> EN_REVISION/EN_ATENCION) sólo se permite
 * mediante la acción explícita "reabrir", que exige motivo y queda auditada.
 */
const NORMAL_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  REGISTRADA: ['EN_REVISION', 'EN_ATENCION', 'CERRADA'],
  EN_REVISION: ['EN_ATENCION', 'SOLUCIONADA', 'CERRADA'],
  EN_ATENCION: ['SOLUCIONADA', 'EN_REVISION'],
  SOLUCIONADA: ['CERRADA'],
  CERRADA: [],
};

const REOPEN_TRANSITIONS: Record<CaseStatus, CaseStatus[]> = {
  REGISTRADA: [],
  EN_REVISION: [],
  EN_ATENCION: [],
  SOLUCIONADA: ['EN_ATENCION'],
  CERRADA: ['EN_REVISION'],
};

export function allowedTransitions(from: CaseStatus, opts: { reopen?: boolean } = {}): CaseStatus[] {
  return opts.reopen ? REOPEN_TRANSITIONS[from] : NORMAL_TRANSITIONS[from];
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: CaseStatus,
    public readonly to: CaseStatus,
  ) {
    super(`Transición no permitida: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: CaseStatus, to: CaseStatus, opts: { reopen?: boolean } = {}): void {
  if (!allowedTransitions(from, opts).includes(to)) throw new InvalidTransitionError(from, to);
}

export function isActive(s: CaseStatus): boolean {
  return s !== 'CERRADA';
}

/** Estado que se propaga a los reportes vinculados cuando cambia el incidente. */
export function reportStatusForIncident(incidentStatus: CaseStatus): CaseStatus {
  return incidentStatus === 'REGISTRADA' ? 'EN_REVISION' : incidentStatus;
}

/** Orden para no hacer retroceder a un reporte por propagación. */
export const STATUS_ORDER: Record<CaseStatus, number> = {
  REGISTRADA: 0,
  EN_REVISION: 1,
  EN_ATENCION: 2,
  SOLUCIONADA: 3,
  CERRADA: 4,
};
