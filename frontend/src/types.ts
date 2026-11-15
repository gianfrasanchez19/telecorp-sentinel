export interface Zone {
  zoneId: string;
  name: string;
  criticality: string;
  keySites: string[];
  center: { lat: number; lon: number };
}
export interface CatalogAntenna {
  antennaId: string;
  zoneId: string;
  name: string;
  lat: number;
  lon: number;
  cells: string[];
  technology: string;
}
export interface Catalog {
  syntheticNotice: string;
  zones: Zone[];
  antennas: CatalogAntenna[];
  problemTypes: { id: string; label: string; family: string; correlatable: boolean }[];
  statuses: string[];
}
export interface Health {
  status: string;
  mode: 'local' | 'aws';
  storage: string;
  orchestrator: string;
  queues: string;
  ai: string;
  time: string;
}
export interface AntennaView extends CatalogAntenna {
  zoneName: string;
  zoneCriticality: string;
  lastValue: number | null;
  lastObservedAt: string | null;
  status: string;
  trend: string;
  recent: { at: string; v: number }[];
  consecutiveNormal: number;
  recoveryPolicy: string;
  openEpisode: { episodeId: string; startedAt: string; worstStatus: string; currentStatus: string; anomalousReadings: number } | null;
  lateReadings: number;
  recurrence: { episodesInWindow: number; structuralReview: boolean; windowStart: string; totalAnomalousMinutes: number };
}
export interface PriorityFactor {
  factor: string;
  value: number | string;
  normalized: number;
  points: number;
  explanation: string;
}
export interface Incident {
  incidentId: string;
  kind: 'INFRAESTRUCTURA' | 'COLECTIVO';
  zoneId: string;
  zoneName: string;
  zoneCriticality: string;
  family?: string;
  antennaIds: string[];
  status: string;
  title: string;
  openedAt: string;
  firstEvidenceAt: string;
  solvedAt?: string;
  closedAt?: string;
  uniqueReporters: number;
  reportCount: number;
  estimatedUsers: number;
  worstAntennaStatus?: string;
  currentAntennaStatus?: string;
  investigationPending: boolean;
  recovery?: { detectedAt: string; normalReadings: number; policy: string; pendingVerification: boolean };
  priority?: { score: number; level: string; factors: PriorityFactor[]; computedAt: string };
  ai?: { source: string; summary: string; generatedAt: string; model?: string };
  relatedIncidentIds: string[];
  episodeIds: string[];
  synthetic: boolean;
  version: number;
}
export interface IncidentDetail {
  incident: Incident;
  reports: { ticketId: string; occurredAt: string; linkedAt: string; reporterRef: string }[];
  history: { at: string; actor: string; type: string; fromStatus?: string; toStatus?: string; reason?: string; data?: Record<string, unknown> }[];
  aiAnalyses: { source: string; summary: string; probableCauses: string[]; recommendedActions: string[]; uncertainties: string[]; relatedProblemType: string; model: string; generatedAt: string; requestId?: string; latencyMs?: number; cached?: boolean; reason?: string }[];
  notifications: { notificationId: string; kind: string; channel: string; status: string; provider: string; attempts: number; createdAt: string; updatedAt: string; lastError?: string; ticketId: string }[];
  allowedTransitions: string[];
  allowedReopen: string[];
}
export interface OperatorReport {
  ticketId: string;
  zoneId: string;
  zoneName: string;
  problemType: string;
  family: string;
  occurredAt: string;
  receivedAt: string;
  status: string;
  description: string;
  reporterRef: string;
  contact: { consent: boolean; email?: string; phone?: string };
  incidentIds: string[];
  lateForOpening: boolean;
  synthetic: boolean;
}
