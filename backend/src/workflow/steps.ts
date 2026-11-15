import { buildAiContext, contextHash, fallbackAnalysis } from '../ai/context.js';
import { antennasInZone, getAntenna, getZone } from '../domain/catalog.js';
import { collectiveIncidentKey, infraIncidentKey, maxDistinctUsersInWindow, type CorrelationPoint } from '../domain/correlation.js';
import { CORRELATABLE_FAMILIES, PROBLEM_TYPES, type ProblemFamily } from '../domain/reports.js';
import { STATUS_SEVERITY, displayStatus, type AntennaState, type AntennaStatus } from '../domain/telemetry.js';
import { log } from '../lib/logger.js';
import type { IncidentMeta, OutboxEvent, ReportMeta } from '../repo/entities.js';
import { K, RETENTION, ttlFromNow } from '../repo/keys.js';
import { queryAll } from '../store/types.js';
import {
  getActiveIncidentId,
  getIncident,
  linkIncidents,
  markReportEvaluated,
  persistAnalysis,
  propagateStatusToReports,
  recalculatePriority,
  recordRecovery,
  upsertIncident,
} from '../services/incidents.js';
import { enqueueForIncidentReporters, enqueueForReport } from '../services/notifications.js';
import { setProcessingStatus } from '../services/pipeline.js';
import { rt } from '../services/runtime.js';

/**
 * Pasos del flujo de Step Functions (state machine "incident-workflow").
 * Cada paso es una función pura de entrada/salida JSON, invocada por:
 *  - AWS Lambda (un handler por paso) desde Step Functions Standard, o
 *  - el intérprete ASL local (modo emulado), con la MISMA definición JSON.
 * Todos son idempotentes ante reintentos (claves deterministas por eventId).
 */

export interface LoadedEvent {
  eventId: string;
  type: OutboxEvent['type'];
  subjectId: string;
  payload: Record<string, unknown>;
}

type ReportRef = { ticketId: string; userHash: string };

export type CorrelationOp =
  | { op: 'UPSERT_COLLECTIVE'; zoneId: string; family: ProblemFamily; reports: ReportRef[]; firstEvidenceAt: string; distinctUsers: number; windowStart?: string; windowEnd?: string }
  | { op: 'LINK_REPORT_TO_INFRA'; antennaId: string; report: ReportRef }
  | { op: 'UPSERT_INFRA'; antennaId: string; zoneId: string; status: AntennaStatus; episodeId: string; startedAt: string; reports: ReportRef[] }
  | { op: 'RECOVERY'; antennaId: string; episodeId: string; endedAt: string; normalReadings: number };

export interface Decision {
  action: 'CREATE_OR_UPDATE' | 'NO_CHANGE';
  reason: string;
  ops: CorrelationOp[];
  evaluatedAt: string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export async function loadEvent(input: { eventId: string }): Promise<LoadedEvent> {
  const { store } = await rt();
  const out = (await store.get(K.outbox(input.eventId).pk, 'OUTBOX', { consistent: true })) as unknown as OutboxEvent | undefined;
  if (!out) throw Object.assign(new Error(`Evento ${input.eventId} no encontrado`), { name: 'EventNotFound' });
  await setProcessingStatus(input.eventId, 'EN_EJECUCION');
  return { eventId: out.eventId, type: out.type, subjectId: out.subjectId, payload: out.payload };
}

async function antennaStates(zoneId: string, now: Date): Promise<{ antennaId: string; status: AntennaStatus | 'SIN_DATOS' }[]> {
  const { store, cfg } = await rt();
  return Promise.all(
    antennasInZone(zoneId).map(async (a) => {
      const st = (await store.get(K.antennaState(a.antennaId).pk, 'STATE')) as unknown as AntennaState | undefined;
      return { antennaId: a.antennaId, status: displayStatus(st, now, cfg) };
    }),
  );
}

/** Reportes recientes de la zona (familias correlacionables) — lectura consistente de la partición base. */
async function recentZoneReports(zoneId: string, fromIso: string, toIso: string): Promise<ReportRef[]> {
  const { store } = await rt();
  const out: ReportRef[] = [];
  for (const fam of CORRELATABLE_FAMILIES) {
    const pts = await queryAll(store, { pk: K.corrPartition(zoneId, fam), skBetween: [fromIso, `${toIso}~`], consistent: true }, 2000);
    out.push(...pts.map((p) => ({ ticketId: p.ticketId as string, userHash: p.userHash as string })));
  }
  return out;
}

export async function validateAndCorrelate(input: { event: LoadedEvent }): Promise<Decision> {
  const { store, cfg, now } = await rt();
  const nowD = now();
  const ev = input.event;
  const ops: CorrelationOp[] = [];
  const reasons: string[] = [];

  if (ev.type === 'REPORT_RECEIVED') {
    const r = (await store.get(K.report(ev.subjectId).pk, 'META', { consistent: true })) as unknown as ReportMeta | undefined;
    if (!r) throw Object.assign(new Error('Reporte no encontrado'), { name: 'EventNotFound' });
    if (!CORRELATABLE_FAMILIES.has(r.family)) {
      return { action: 'NO_CHANGE', reason: `Familia ${r.family} no participa en detección de incidentes de red`, ops: [], evaluatedAt: nowD.toISOString() };
    }
    const W = cfg.collectiveWindowMs;
    const t = new Date(r.occurredAt).getTime();
    // Partición base zona+familia, rango (t-W, t+W): lectura FUERTEMENTE CONSISTENTE.
    const pts = await queryAll(store, { pk: K.corrPartition(r.zoneId, r.family), skBetween: [iso(t - W + 1), `${iso(t + W - 1)}~`], consistent: true }, 5000);
    const points: CorrelationPoint[] = pts.map((p) => ({ userHash: p.userHash as string, at: new Date(p.occurredAt as string).getTime(), ticketId: p.ticketId as string }));
    const win = maxDistinctUsersInWindow(points, W);
    const self: ReportRef = { ticketId: r.ticketId, userHash: r.userHash };
    const activeColl = await getActiveIncidentId(collectiveIncidentKey(r.zoneId, r.family));
    if (activeColl) {
      ops.push({ op: 'UPSERT_COLLECTIVE', zoneId: r.zoneId, family: r.family, reports: [self], firstEvidenceAt: r.occurredAt, distinctUsers: win.distinctUsers });
      reasons.push(`Se asocia al incidente colectivo activo ${activeColl}`);
    } else if (win.distinctUsers >= cfg.collectiveThreshold) {
      if (r.lateForOpening) {
        reasons.push('Umbral alcanzado sólo con reportes tardíos (> política de apertura): no se abre colectivo nuevo');
      } else {
        const byTicket = new Map(points.map((p) => [p.ticketId, p]));
        const reports = win.tickets.map((tk) => ({ ticketId: tk, userHash: byTicket.get(tk)!.userHash }));
        ops.push({ op: 'UPSERT_COLLECTIVE', zoneId: r.zoneId, family: r.family, reports, firstEvidenceAt: iso(win.startAt!), distinctUsers: win.distinctUsers, windowStart: iso(win.startAt!), windowEnd: iso(win.endAt!) });
        reasons.push(`${win.distinctUsers} usuarios distintos en ventana < ${W / 3_600_000} h (umbral ${cfg.collectiveThreshold})`);
      }
    } else {
      reasons.push(`${win.distinctUsers} usuario(s) distinto(s) en la ventana; umbral ${cfg.collectiveThreshold}`);
    }
    for (const a of antennasInZone(r.zoneId)) {
      const infra = await getActiveIncidentId(infraIncidentKey(a.antennaId));
      if (infra) {
        ops.push({ op: 'LINK_REPORT_TO_INFRA', antennaId: a.antennaId, report: self });
        reasons.push(`Antena candidata ${a.antennaId} con incidente activo ${infra}`);
      }
    }
  } else if (ev.type === 'ANTENNA_EPISODE_CHANGED') {
    const p = ev.payload as { antennaId: string; zoneId: string; transition: string; episodeId: string; startedAt: string; currentStatus: AntennaStatus; endedAt?: string; normalReadings?: number };
    if (p.transition === 'EPISODE_RECOVERED') {
      const infra = await getActiveIncidentId(infraIncidentKey(p.antennaId));
      if (infra) {
        ops.push({ op: 'RECOVERY', antennaId: p.antennaId, episodeId: p.episodeId, endedAt: p.endedAt!, normalReadings: p.normalReadings ?? cfg.recoveryConsecutiveNormal });
        reasons.push('Recuperación técnica según política; requiere verificación del operador');
      } else reasons.push('Recuperación sin incidente activo');
    } else {
      const from = iso(new Date(p.startedAt).getTime() - cfg.collectiveWindowMs + 1);
      const reports = await recentZoneReports(p.zoneId, from, nowD.toISOString());
      ops.push({ op: 'UPSERT_INFRA', antennaId: p.antennaId, zoneId: p.zoneId, status: p.currentStatus, episodeId: p.episodeId, startedAt: p.startedAt, reports });
      reasons.push(`${p.transition}: antena ${p.antennaId} en estado ${p.currentStatus}; ${reports.length} reporte(s) recientes de la zona como evidencia`);
    }
  }
  return { action: ops.length ? 'CREATE_OR_UPDATE' : 'NO_CHANGE', reason: reasons.join('. '), ops, evaluatedAt: nowD.toISOString() };
}

export interface PersistResult {
  incidentIds: string[];
  createdIds: string[];
  materialIds: string[];
}

export async function persistIncidentAndHistory(input: { eventId: string; event: LoadedEvent; decision: Decision }): Promise<PersistResult> {
  const { now, cfg } = await rt();
  const nowD = now();
  const ids = new Set<string>();
  const created = new Set<string>();
  const material = new Set<string>();
  const synthetic = await isSynthetic(input.event);
  const note = (r: { incidentId: string; created: boolean; materialChange: boolean }) => {
    ids.add(r.incidentId);
    if (r.created) created.add(r.incidentId);
    if (r.materialChange) material.add(r.incidentId);
  };

  for (const op of input.decision.ops) {
    if (op.op === 'UPSERT_COLLECTIVE') {
      const states = await antennaStates(op.zoneId, nowD);
      const anomalous = states.filter((s) => s.status !== 'NORMAL' && s.status !== 'SIN_DATOS') as { antennaId: string; status: AntennaStatus }[];
      const worst = anomalous.sort((a, b) => STATUS_SEVERITY[b.status] - STATUS_SEVERITY[a.status])[0]?.status;
      const zone = getZone(op.zoneId)!;
      const res = await upsertIncident({
        logicalKey: collectiveIncidentKey(op.zoneId, op.family),
        kind: 'COLECTIVO',
        zoneId: op.zoneId,
        family: op.family,
        antennaIds: antennasInZone(op.zoneId).map((a) => a.antennaId),
        firstEvidenceAt: op.firstEvidenceAt,
        title: `Posible incidente colectivo de ${op.family.toLowerCase()} en ${zone.name}`,
        reports: op.reports,
        antennaStatus: worst,
        investigationPending: anomalous.length === 0,
        evidence: { distinctUsers: op.distinctUsers, windowStart: op.windowStart, windowEnd: op.windowEnd, anomalousCandidates: anomalous, threshold: cfg.collectiveThreshold, note: 'Correlación por zona, familia y tiempo; no implica causalidad.' },
        eventId: input.eventId,
        synthetic,
      });
      note(res);
      for (const a of antennasInZone(op.zoneId)) {
        const infra = await getActiveIncidentId(infraIncidentKey(a.antennaId));
        if (infra && (await linkIncidents(res.incidentId, infra, input.eventId))) material.add(res.incidentId);
      }
    } else if (op.op === 'LINK_REPORT_TO_INFRA') {
      const infra = await getActiveIncidentId(infraIncidentKey(op.antennaId));
      if (!infra) continue;
      const ant = getAntenna(op.antennaId)!;
      const res = await upsertIncident({ logicalKey: infraIncidentKey(op.antennaId), kind: 'INFRAESTRUCTURA', zoneId: ant.zoneId, antennaIds: [op.antennaId], firstEvidenceAt: nowD.toISOString(), title: '', reports: [op.report], evidence: {}, eventId: input.eventId, synthetic, onlyIfExists: true });
      if (res.incidentId) note({ ...res, materialChange: false });
    } else if (op.op === 'UPSERT_INFRA') {
      const ant = getAntenna(op.antennaId)!;
      const res = await upsertIncident({
        logicalKey: infraIncidentKey(op.antennaId),
        kind: 'INFRAESTRUCTURA',
        zoneId: op.zoneId,
        antennaIds: [op.antennaId],
        firstEvidenceAt: op.startedAt,
        title: `Antena ${ant.name} (${op.antennaId}) en estado ${op.status}`,
        reports: op.reports,
        episodeId: op.episodeId,
        antennaStatus: op.status,
        evidence: { episodeId: op.episodeId, firstAnomalyAt: op.startedAt, status: op.status, linkedReports: op.reports.length },
        eventId: input.eventId,
        synthetic,
      });
      note(res);
      for (const fam of CORRELATABLE_FAMILIES) {
        const coll = await getActiveIncidentId(collectiveIncidentKey(op.zoneId, fam));
        if (coll && (await linkIncidents(res.incidentId, coll, input.eventId))) material.add(coll);
      }
    } else if (op.op === 'RECOVERY') {
      const infra = await getActiveIncidentId(infraIncidentKey(op.antennaId));
      if (infra && (await recordRecovery(infra, op, `${cfg.recoveryConsecutiveNormal} lecturas normales consecutivas`, input.eventId))) note({ incidentId: infra, created: false, materialChange: true });
    }
  }
  return { incidentIds: [...ids], createdIds: [...created], materialIds: [...material] };
}

async function isSynthetic(ev: LoadedEvent): Promise<boolean> {
  const { store } = await rt();
  if (ev.type === 'REPORT_RECEIVED') return !!(await store.get(K.report(ev.subjectId).pk, 'META'))?.synthetic;
  return true; // telemetría de esta demo siempre es sintética (simulador)
}

export async function calculatePriority(input: { eventId: string; persist: PersistResult }): Promise<{ levels: Record<string, string>; aiTargets: string[] }> {
  const levels: Record<string, string> = {};
  const aiTargets: string[] = [];
  for (const id of input.persist.incidentIds) {
    const r = await recalculatePriority(id, input.eventId);
    if (!r) continue;
    levels[id] = r.result.level;
    if (input.persist.createdIds.includes(id) || input.persist.materialIds.includes(id) || r.levelChanged) aiTargets.push(id);
  }
  return { levels, aiTargets };
}

function bucket(n: number): string {
  if (n === 0) return '0';
  if (n < 10) return '1-9';
  if (n < 20) return '10-19';
  if (n < 50) return '20-49';
  if (n < 100) return '50-99';
  return '100+';
}

export interface AnalysisOutput {
  incidentId: string;
  eventId: string;
  source: 'VERTEX_AI_GEMINI' | 'AI_UNAVAILABLE';
  analysis: Record<string, unknown>;
  contextHash?: string;
  cached?: boolean;
}

/** Llama al microservicio de IA en Google Cloud (Cloud Run + Vertex AI Gemini). */
export async function analyzeWithGcp(input: { incidentId: string; eventId: string }): Promise<AnalysisOutput> {
  const { store, ai } = await rt();
  const m = await getIncident(input.incidentId);
  if (!m) throw Object.assign(new Error('Incidente no encontrado'), { name: 'AiUnavailableError' });
  const rels = await queryAll(store, { pk: K.incidentPk(m.incidentId), skBeginsWith: 'REL#RPT#', consistent: true }, 200);
  const descs: string[] = [];
  const types: Record<string, number> = {};
  for (const rel of rels.slice(-40)) {
    const r = (await store.get(K.report(rel.ticketId as string).pk, 'META')) as unknown as ReportMeta | undefined;
    if (!r) continue;
    types[PROBLEM_TYPES[r.problemType].label] = (types[PROBLEM_TYPES[r.problemType].label] ?? 0) + 1;
    if (descs.length < 8) descs.push(r.descriptionRedacted);
  }
  const ctx = buildAiContext(m, descs, types);
  const hashCtx = { ...ctx, incident: { ...ctx.incident, uniqueReporters: bucket(m.uniqueReporters), reportCount: bucket(m.reportCount) } };
  const h = contextHash(hashCtx);
  const cached = await store.get(K.aiCache(h).pk, 'AI');
  if (cached) return { incidentId: m.incidentId, eventId: input.eventId, source: 'VERTEX_AI_GEMINI', analysis: cached.analysis as Record<string, unknown>, contextHash: h, cached: true };
  const requestId = `${input.eventId}-${m.incidentId}`.slice(0, 100);
  const res = await ai.analyze(hashCtx, requestId);
  log.info('ia_analisis', { requestId, incidentId: m.incidentId, model: res.model, latencyMs: res.latencyMs, inputBytes: JSON.stringify(hashCtx).length, approxInputTokens: Math.ceil(JSON.stringify(hashCtx).length / 4) });
  return { incidentId: m.incidentId, eventId: input.eventId, source: 'VERTEX_AI_GEMINI', analysis: { ...res, requestId }, contextHash: h };
}

export async function buildFallbackAnalysis(input: { incidentId: string; eventId: string; aiError?: { Error?: string; Cause?: string } }): Promise<AnalysisOutput> {
  const m = await getIncident(input.incidentId);
  if (!m) throw new Error('Incidente no encontrado');
  const reason = input.aiError?.Error ?? 'desconocido';
  const fb = fallbackAnalysis(m, reason);
  return { incidentId: m.incidentId, eventId: input.eventId, source: 'AI_UNAVAILABLE', analysis: fb as unknown as Record<string, unknown> };
}

export async function persistAnalysisStep(input: AnalysisOutput): Promise<{ incidentId: string; source: string }> {
  const { store } = await rt();
  const a = input.analysis as { summary: string; generatedAt: string; model?: string };
  const generatedAt = a.generatedAt ?? new Date().toISOString();
  await persistAnalysis(input.incidentId, { source: input.source, summary: a.summary, generatedAt, model: a.model, full: { ...input.analysis, cached: input.cached ?? false } }, input.eventId);
  if (input.source === 'VERTEX_AI_GEMINI' && input.contextHash && !input.cached) {
    await store.put({ ...K.aiCache(input.contextHash), entity: 'AI_CACHE', analysis: input.analysis, ttl: ttlFromNow(RETENTION.aiCacheDays * 86400) });
  }
  return { incidentId: input.incidentId, source: input.source };
}

export async function propagateStatus(input: { event: LoadedEvent }): Promise<{ incidentIds: string[]; updatedReports: number; to: string }> {
  const p = input.event.payload as { incidentId: string; to: string; statusSeq: number; reopen: boolean };
  const r = await propagateStatusToReports(p.incidentId, p.statusSeq, p.reopen);
  return { incidentIds: [p.incidentId], updatedReports: r.updated.length, to: p.to };
}

export async function queueNotifications(input: { eventId: string; event: LoadedEvent; decision?: Decision; persist?: PersistResult }): Promise<{ queued: number }> {
  const ev = input.event;
  let queued = 0;
  if (ev.type === 'REPORT_RECEIVED') {
    const ticketId = ev.subjectId;
    await markReportEvaluated(ticketId, input.eventId, input.decision?.reason ? `Evaluado: ${input.decision.reason}` : 'Evaluado por el flujo de análisis');
    queued += await enqueueForReport('REPORTE_EVALUADO', ticketId, `RPT#${ticketId}`);
    for (const id of input.persist?.incidentIds ?? []) {
      const inc = await getIncident(id);
      if (!inc || inc.kind !== 'COLECTIVO') continue;
      if (input.persist?.createdIds.includes(id)) queued += await enqueueForIncidentReporters('INCIDENTE_ZONA', inc, `INC#${id}#ZONA`);
      else queued += await enqueueForReport('INCIDENTE_ZONA', ticketId, `INC#${id}#ZONA`, inc);
    }
  } else if (ev.type === 'ANTENNA_EPISODE_CHANGED') {
    for (const id of input.persist?.createdIds ?? []) {
      const inc = await getIncident(id);
      if (inc) queued += await enqueueForIncidentReporters('INCIDENTE_ZONA', inc, `INC#${id}#ZONA`);
    }
  } else if (ev.type === 'INCIDENT_STATUS_CHANGED') {
    const p = ev.payload as { incidentId: string; to: string; statusSeq: number };
    if (p.to === 'SOLUCIONADA') {
      const inc = (await getIncident(p.incidentId)) as IncidentMeta;
      queued += await enqueueForIncidentReporters('SERVICIO_RESTABLECIDO', inc, `INC#${p.incidentId}#RESTABLECIDO#s${p.statusSeq}`);
    }
  }
  return { queued };
}

export async function markSucceeded(input: { eventId: string }): Promise<{ status: string }> {
  await setProcessingStatus(input.eventId, 'COMPLETADO');
  return { status: 'COMPLETADO' };
}

export async function markFailed(input: { eventId: string; error?: { Error?: string; Cause?: string } }): Promise<{ status: string }> {
  const name = input.error?.Error ?? 'Error';
  let message = input.error?.Cause ?? '';
  try {
    message = (JSON.parse(message) as { errorMessage?: string }).errorMessage ?? message;
  } catch {
    /* Cause no es JSON */
  }
  await setProcessingStatus(input.eventId, 'FALLIDO', { name, message: message.slice(0, 500) });
  log.error('workflow_fallido', new Error(name), { eventId: input.eventId });
  return { status: 'FALLIDO' };
}

/** Registro de pasos por nombre (usado por handlers Lambda y por el intérprete local). */
export const STEPS = {
  LoadEvent: loadEvent,
  ValidateAndCorrelate: validateAndCorrelate,
  PersistIncidentAndHistory: persistIncidentAndHistory,
  CalculatePriority: calculatePriority,
  AnalyzeWithGCP: analyzeWithGcp,
  BuildFallbackAnalysis: buildFallbackAnalysis,
  PersistAnalysis: persistAnalysisStep,
  PropagateStatus: propagateStatus,
  QueueNotifications: queueNotifications,
  MarkSucceeded: markSucceeded,
  MarkFailed: markFailed,
} as const;

export type StepName = keyof typeof STEPS;
