import { ZONES, getZone } from '../domain/catalog.js';
import { PROBLEM_TYPES } from '../domain/reports.js';
import { badRequest } from '../lib/errors.js';
import type { IncidentMeta, ReportMeta } from '../repo/entities.js';
import { K } from '../repo/keys.js';
import { queryAll } from '../store/types.js';
import { rt } from './runtime.js';
import { listAntennas } from './telemetry.js';

const DAY = 86_400_000;

function stats(xs: number[]) {
  if (!xs.length) return { count: 0, avgMinutes: null, p50Minutes: null, p90Minutes: null };
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { count: s.length, avgMinutes: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 10) / 10, p50Minutes: Math.round(q(0.5) * 10) / 10, p90Minutes: Math.round(q(0.9) * 10) / 10 };
}

/**
 * Analítica calculada SOBRE DATOS PERSISTIDOS (sin valores fijos). Sin Scan:
 * reportes por particiones diarias (GSI2), incidentes por zona (GSI1) y cola activa (GSI2).
 */
export async function analytics(q: { from?: string; to?: string; zoneId?: string }) {
  const { store, now } = await rt();
  const to = q.to ? new Date(q.to) : now();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw badRequest('Rango inválido');
  if (to.getTime() - from.getTime() > 31 * DAY) throw badRequest('El rango máximo es de 31 días');
  if (q.zoneId && !getZone(q.zoneId)) throw badRequest('Zona inválida');
  const zones = q.zoneId ? ZONES.filter((z) => z.zoneId === q.zoneId) : ZONES;
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  // Reportes
  const reports: ReportMeta[] = [];
  for (let d = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); d <= to.getTime(); d += DAY) {
    const items = await queryAll(store, { index: 'gsi2', pk: K.reportDayGsi(new Date(d).toISOString()), skBetween: [fromIso, `${toIso}~`] }, 20000);
    for (const r of items as unknown as ReportMeta[]) if (!q.zoneId || r.zoneId === q.zoneId) reports.push(r);
  }
  const byZone = zones.map((z) => {
    const rs = reports.filter((r) => r.zoneId === z.zoneId);
    return { zoneId: z.zoneId, zoneName: z.name, criticality: z.criticality, reports: rs.length, uniqueReporters: new Set(rs.map((r) => r.userHash)).size };
  });
  const byType = Object.entries(PROBLEM_TYPES).map(([t, v]) => ({ problemType: t, label: v.label, family: v.family, count: reports.filter((r) => r.problemType === t).length }));
  const days: { day: string; reports: number; uniqueReporters: number; incidentsOpened: number }[] = [];
  for (let d = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()); d <= to.getTime(); d += DAY) {
    const day = new Date(d).toISOString().slice(0, 10);
    const rs = reports.filter((r) => r.receivedAt.startsWith(day));
    days.push({ day, reports: rs.length, uniqueReporters: new Set(rs.map((r) => r.userHash)).size, incidentsOpened: 0 });
  }

  // Incidentes abiertos en el rango (por zona) + cola activa actual
  const opened: IncidentMeta[] = [];
  for (const z of zones) opened.push(...((await queryAll(store, { index: 'gsi1', pk: K.incidentZoneGsi(z.zoneId), skBetween: [fromIso, `${toIso}~`] }, 5000)) as unknown as IncidentMeta[]));
  for (const inc of opened) {
    const day = days.find((d) => d.day === inc.openedAt.slice(0, 10));
    if (day) day.incidentsOpened++;
  }
  const active = ((await queryAll(store, { index: 'gsi2', pk: K.incidentQueueGsi(true) }, 5000)) as unknown as IncidentMeta[]).filter((i) => !q.zoneId || i.zoneId === q.zoneId);
  const activeByPriority = (['CRITICA', 'ALTA', 'MEDIA', 'BAJA'] as const).map((level) => ({ level, count: active.filter((i) => i.priority?.level === level).length }));
  const zonesRanking = zones
    .map((z) => ({ zoneId: z.zoneId, zoneName: z.name, incidents: opened.filter((i) => i.zoneId === z.zoneId).length, active: active.filter((i) => i.zoneId === z.zoneId).length }))
    .sort((a, b) => b.incidents - a.incidents);

  const mttd = stats(opened.map((i) => (new Date(i.openedAt).getTime() - new Date(i.firstEvidenceAt).getTime()) / 60_000).filter((x) => x >= 0));
  const mttr = stats(opened.filter((i) => i.solvedAt).map((i) => (new Date(i.solvedAt!).getTime() - new Date(i.openedAt).getTime()) / 60_000));

  // Antenas
  const ants = (await listAntennas()).filter((a) => !q.zoneId || a.zoneId === q.zoneId);
  const antennaKpis = { total: ants.length, NORMAL: 0, CAIDA: 0, SATURADA: 0, INHABILITADA: 0, SIN_DATOS: 0 } as Record<string, number>;
  for (const a of ants) antennaKpis[a.status]++;
  const recurrent = ants.filter((a) => a.recurrence.structuralReview).map((a) => ({ antennaId: a.antennaId, name: a.name, zoneName: a.zoneName, episodes: a.recurrence.episodesInWindow, anomalousMinutes: a.recurrence.totalAnomalousMinutes }));
  const ranked = ants
    .map((a) => ({ antennaId: a.antennaId, name: a.name, zoneName: a.zoneName, episodes: a.recurrence.episodesInWindow, anomalousMinutes: a.recurrence.totalAnomalousMinutes }))
    .filter((a) => a.episodes > 0)
    .sort((a, b) => b.episodes - a.episodes);

  return {
    range: { from: fromIso, to: toIso, zoneId: q.zoneId ?? null },
    hasData: reports.length > 0 || opened.length > 0 || ants.some((a) => a.lastObservedAt),
    antennas: { kpis: antennaKpis, recurrent, episodesRanking: ranked.slice(0, 10) },
    incidents: { activeTotal: active.length, activeByPriority, openedInRange: opened.length, byKind: { INFRAESTRUCTURA: opened.filter((i) => i.kind === 'INFRAESTRUCTURA').length, COLECTIVO: opened.filter((i) => i.kind === 'COLECTIVO').length }, zonesRanking },
    reports: { total: reports.length, uniqueReporters: new Set(reports.map((r) => r.userHash)).size, byZone, byType, synthetic: reports.filter((r) => r.synthetic).length },
    estimatedUsersAffectedActive: active.reduce((a, i) => a + (i.kind === 'INFRAESTRUCTURA' ? i.estimatedUsers : 0), 0),
    timeSeries: days,
    mttd,
    mttr,
    definitions: {
      MTTD: 'Tiempo medio de detección: apertura del incidente − primera evidencia (primera lectura anómala o primer inconveniente reportado de la ventana). Minutos.',
      MTTR: 'Tiempo medio de restablecimiento: momento en que el operador marca SOLUCIONADA − apertura. Sólo incidentes abiertos en el rango y ya solucionados. Minutos.',
      reportantesUnicos: 'Personas distintas (HMAC de identidad normalizada) que reportaron. No confundir con usuarios estimados.',
      usuariosEstimados: 'Estimado de catálogo sintético por celdas cubiertas, sin duplicar celdas solapadas. No es un dato medido.',
      unidades: 'Telemetría en GB/min. Tiempos en minutos. Fechas en UTC.',
    },
  };
}
