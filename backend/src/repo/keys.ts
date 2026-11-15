/**
 * Diseño de claves de la TABLA ÚNICA (ver docs/data-model.md).
 * Todas las marcas de tiempo son ISO-8601 UTC (`toISOString()`), que ordenan
 * lexicográficamente igual que cronológicamente.
 */
export const K = {
  // Reportes
  report: (ticketId: string) => ({ pk: `RPT#${ticketId}`, sk: 'META' }),
  reportPii: (ticketId: string) => ({ pk: `RPT#${ticketId}`, sk: 'PII' }),
  reportHistPrefix: 'HIST#',
  reportIncident: (ticketId: string, incidentId: string) => ({ pk: `RPT#${ticketId}`, sk: `INC#${incidentId}` }),
  reportDayGsi: (receivedAt: string) => `RPTDAY#${receivedAt.slice(0, 10)}`,
  /** Partición base de correlación (lectura fuertemente consistente). */
  corrPartition: (zoneId: string, family: string) => `ZF#${zoneId}#${family}`,
  corrPoint: (zoneId: string, family: string, occurredAt: string, ticketId: string) => ({ pk: `ZF#${zoneId}#${family}`, sk: `${occurredAt}#${ticketId}` }),
  token: (tokenHash: string) => ({ pk: `TOK#${tokenHash}`, sk: 'TOK' }),
  idem: (hash: string) => ({ pk: `IDEM#${hash}`, sk: 'IDEM' }),

  // Telemetría / antenas
  antennaPk: (antennaId: string) => `ANT#${antennaId}`,
  antennaState: (antennaId: string) => ({ pk: `ANT#${antennaId}`, sk: 'STATE' }),
  metric: (antennaId: string, observedAt: string, eventId: string) => ({ pk: `ANT#${antennaId}`, sk: `MET#${observedAt}#${eventId}` }),
  telemetryEvent: (eventId: string) => ({ pk: `EVT#${eventId}`, sk: 'EVT' }),
  episode: (antennaId: string, startedAt: string, episodeId: string) => ({ pk: `ANT#${antennaId}`, sk: `EPI#${startedAt}#${episodeId}` }),
  episodesGsi: 'EPISODES',

  // Incidentes
  incident: (id: string) => ({ pk: `INC#${id}`, sk: 'META' }),
  incidentPk: (id: string) => `INC#${id}`,
  incidentLock: (logicalKey: string) => ({ pk: `INCKEY#${logicalKey}`, sk: 'ACTIVE' }),
  incidentUser: (id: string, userHash: string) => ({ pk: `INC#${id}`, sk: `USR#${userHash}` }),
  incidentRel: (id: string, kind: 'RPT' | 'ANT' | 'INC' | 'EPI', ref: string) => ({ pk: `INC#${id}`, sk: `REL#${kind}#${ref}` }),
  incidentHist: (id: string, at: string, suffix: string) => ({ pk: `INC#${id}`, sk: `HIST#${at}#${suffix}` }),
  incidentAi: (id: string, at: string) => ({ pk: `INC#${id}`, sk: `AI#${at}` }),
  incidentQueueGsi: (active: boolean) => (active ? 'INCQ#ACTIVE' : 'INCQ#CLOSED'),
  incidentZoneGsi: (zoneId: string) => `INCZONE#${zoneId}`,
  aiCache: (hash: string) => ({ pk: `AICACHE#${hash}`, sk: 'AI' }),

  // Notificaciones / outbox / procesamiento
  notification: (dedupHash: string) => ({ pk: `NOTIF#${dedupHash}`, sk: 'NOTIF' }),
  notificationsGsi: (subjectId: string) => `NOTIFS#${subjectId}`,
  outbox: (eventId: string) => ({ pk: `OUTBOX#${eventId}`, sk: 'OUTBOX' }),
  outboxPendingGsi: 'OUTBOX#PENDING',
  processing: (eventId: string) => ({ pk: `PROC#${eventId}`, sk: 'PROC' }),
  processingGsi: (status: string) => `PROC#${status}`,

  // Seguridad / configuración
  user: (username: string) => ({ pk: `USER#${username.toLowerCase()}`, sk: 'USER' }),
  rateLimit: (ipHash: string, minute: string) => ({ pk: `RL#${ipHash}#${minute}`, sk: 'RL' }),
  simConfig: () => ({ pk: 'SIM#CONFIG', sk: 'CONFIG' }),
};

export const DAY_MS = 86_400_000;

export function ttlFromNow(seconds: number, now = Date.now()): number {
  return Math.floor(now / 1000) + seconds;
}

/** Retenciones (TTL) SOLO de datos temporales. El historial nunca expira. */
export const RETENTION = {
  rawMetricsDays: 30,
  telemetryIdempotencyDays: 30,
  reportIdempotencyDays: 30,
  outboxPublishedDays: 7,
  processingDays: 30,
  rateLimitSeconds: 120,
  aiCacheDays: 7,
};

/** Puntaje invertido de 4 dígitos para ordenar la cola por prioridad descendente. */
export function invertedScore(score: number): string {
  return String(9999 - Math.round(score * 10)).padStart(4, '0');
}
