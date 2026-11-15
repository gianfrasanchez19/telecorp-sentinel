import type { ZoneCriticality } from '../domain/catalog.js';
import type { PriorityFactor, PriorityLevel } from '../domain/priority.js';
import type { CaseStatus, ProblemFamily, ProblemType } from '../domain/reports.js';
import type { AntennaStatus } from '../domain/telemetry.js';

export interface HistoryEvent {
  at: string;
  actor: string; // "sistema", "workflow", "operador:<usuario>", "ciudadano"
  type: 'CREADO' | 'CAMBIO_ESTADO' | 'REAPERTURA' | 'ASOCIACION' | 'PRIORIDAD' | 'ANALISIS_IA' | 'RECUPERACION_TECNICA' | 'NOTIFICACION' | 'NOTA' | 'EVIDENCIA';
  fromStatus?: CaseStatus;
  toStatus?: CaseStatus;
  reason?: string;
  data?: Record<string, unknown>;
}

export interface ReportMeta {
  entity: 'REPORT';
  ticketId: string;
  zoneId: string;
  problemType: ProblemType;
  family: ProblemFamily;
  occurredAt: string;
  receivedAt: string;
  status: CaseStatus;
  descriptionRedacted: string;
  userHash: string;
  notifyConsent: boolean;
  contactChannels: ('EMAIL' | 'SMS')[];
  maskedEmail?: string;
  maskedPhone?: string;
  lateForOpening: boolean;
  synthetic: boolean;
  incidentIds: string[];
  evaluatedAt?: string;
  version: number;
}

export type IncidentKind = 'INFRAESTRUCTURA' | 'COLECTIVO';

export interface IncidentMeta {
  entity: 'INCIDENT';
  incidentId: string;
  kind: IncidentKind;
  logicalKey: string;
  zoneId: string;
  zoneCriticality: ZoneCriticality;
  family?: ProblemFamily; // colectivos
  antennaIds: string[]; // infraestructura: la antena; colectivo: antenas candidatas
  status: CaseStatus;
  title: string;
  openedAt: string;
  /** Primera evidencia (lectura anómala o inconveniente reportado) para MTTD. */
  firstEvidenceAt: string;
  solvedAt?: string;
  closedAt?: string;
  uniqueReporters: number;
  reportCount: number;
  estimatedUsers: number;
  worstAntennaStatus?: AntennaStatus;
  currentAntennaStatus?: AntennaStatus;
  investigationPending: boolean;
  recovery?: { detectedAt: string; normalReadings: number; policy: string; pendingVerification: boolean };
  priority?: { score: number; level: PriorityLevel; factors: PriorityFactor[]; computedAt: string };
  ai?: { source: 'VERTEX_AI_GEMINI' | 'AI_UNAVAILABLE'; summary: string; generatedAt: string; model?: string };
  relatedIncidentIds: string[];
  episodeIds: string[];
  statusSeq: number;
  synthetic: boolean;
  version: number;
}

export interface AntennaEpisode {
  entity: 'EPISODE';
  episodeId: string;
  antennaId: string;
  zoneId: string;
  startedAt: string;
  endedAt?: string;
  worstStatus: AntennaStatus;
  anomalousReadings: number;
  incidentId?: string;
}

export type NotificationKind = 'REPORTE_EVALUADO' | 'INCIDENTE_ZONA' | 'SERVICIO_RESTABLECIDO';
export type NotificationStatus = 'PENDIENTE' | 'ENVIANDO' | 'ACEPTADA_PROVEEDOR' | 'FALLIDA_REINTENTABLE' | 'FALLIDA' | 'INCIERTA' | 'OMITIDA';

export interface NotificationRecord {
  entity: 'NOTIFICATION';
  notificationId: string;
  dedupKey: string;
  kind: NotificationKind;
  channel: 'EMAIL' | 'SMS';
  ticketId: string;
  incidentId?: string;
  provider: string;
  status: NotificationStatus;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
  providerMessageId?: string;
  synthetic: boolean;
  version: number;
}

export type OutboxType = 'REPORT_RECEIVED' | 'TELEMETRY_RECEIVED' | 'ANTENNA_EPISODE_CHANGED' | 'INCIDENT_STATUS_CHANGED';

export interface OutboxEvent {
  entity: 'OUTBOX';
  eventId: string;
  type: OutboxType;
  subjectId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  status: 'PENDIENTE' | 'PUBLICADO';
  publishedAt?: string;
}

export interface ProcessingRecord {
  entity: 'PROCESSING';
  eventId: string;
  type: OutboxType;
  status: 'INICIADO' | 'EN_EJECUCION' | 'COMPLETADO' | 'FALLIDO' | 'PROCESADO_EN_LINEA';
  executionName?: string;
  executionArn?: string;
  attempts: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: { name: string; message: string };
  version: number;
}
