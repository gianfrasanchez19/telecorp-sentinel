import { estimatedUsersForAntennas, getZone } from '../domain/catalog.js';
import { computePriority, LEVEL_RANK, type PriorityResult } from '../domain/priority.js';
import type { CaseStatus, ProblemFamily } from '../domain/reports.js';
import { assertTransition, InvalidTransitionError, reportStatusForIncident, STATUS_ORDER } from '../domain/status.js';
import { STATUS_SEVERITY, type AntennaStatus } from '../domain/telemetry.js';
import { opaqueId } from '../lib/crypto.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import type { HistoryEvent, IncidentKind, IncidentMeta, OutboxEvent, ReportMeta } from '../repo/entities.js';
import { K, invertedScore } from '../repo/keys.js';
import { ConditionFailedError, queryAll, type Item, type TxOp } from '../store/types.js';
import { rt, withCas } from './runtime.js';

const MAX_LINKS_PER_TX = 15;

function incidentItem(m: IncidentMeta): Item {
  const active = m.status !== 'CERRADA';
  const score = m.priority?.score ?? 0;
  return {
    ...K.incident(m.incidentId),
    ...m,
    gsi1pk: K.incidentZoneGsi(m.zoneId),
    gsi1sk: `${m.openedAt}#${m.incidentId}`,
    gsi2pk: K.incidentQueueGsi(active),
    gsi2sk: active ? `${invertedScore(score)}#${m.openedAt}#${m.incidentId}` : `${m.closedAt ?? m.openedAt}#${m.incidentId}`,
  } as Item;
}

function hist(incidentId: string, ev: HistoryEvent, suffix: string): TxOp {
  // La clave incluye un sufijo determinista (eventId) => reintentos no duplican.
  return { type: 'put', item: { ...K.incidentHist(incidentId, ev.at, suffix), entity: 'HISTORY', ...ev } as Item };
}

export async function getIncident(id: string): Promise<IncidentMeta | undefined> {
  const { store } = await rt();
  return (await store.get(K.incident(id).pk, 'META', { consistent: true })) as unknown as IncidentMeta | undefined;
}

export async function getActiveIncidentId(logicalKey: string): Promise<string | undefined> {
  const { store } = await rt();
  const lock = await store.get(K.incidentLock(logicalKey).pk, 'ACTIVE', { consistent: true });
  return lock?.incidentId as string | undefined;
}

export interface UpsertSpec {
  logicalKey: string;
  kind: IncidentKind;
  zoneId: string;
  family?: ProblemFamily;
  antennaIds: string[];
  firstEvidenceAt: string;
  title: string;
  /** Reportes a vincular (con su identidad seudonimizada). */
  reports: { ticketId: string; userHash: string }[];
  episodeId?: string;
  antennaStatus?: AntennaStatus;
  investigationPending?: boolean;
  evidence: Record<string, unknown>;
  eventId: string;
  synthetic: boolean;
  /** Sólo actualizar: si no hay incidente activo, no crear uno nuevo. */
  onlyIfExists?: boolean;
}

export interface UpsertResult {
  incidentId: string;
  created: boolean;
  newReports: number;
  newUsers: number;
  materialChange: boolean;
}

/**
 * Crea o actualiza el ÚNICO incidente activo para una clave lógica.
 * Garantía: el ítem INCKEY#<clave>/ACTIVE se crea con attribute_not_exists en la
 * misma transacción que el incidente; los perdedores de una carrera reintentan y
 * actualizan el existente (CAS por versión). Los usuarios afectados se guardan como
 * ítems USR#<hash> con attribute_not_exists => un usuario nunca se cuenta dos veces.
 */
export async function upsertIncident(spec: UpsertSpec): Promise<UpsertResult> {
  const { store, now } = await rt();
  let created = false;
  let totalNewReports = 0;
  let totalNewUsers = 0;
  let materialChange = false;
  let incidentId: string | undefined;
  let remaining = [...spec.reports];
  let first = true;

  while (first || remaining.length > 0) {
    first = false;
    const res = await withCas(async () => {
      const at = now().toISOString();
      const lockKey = K.incidentLock(spec.logicalKey);
      const lock = await store.get(lockKey.pk, lockKey.sk, { consistent: true });
      let meta: IncidentMeta | undefined = lock ? await getIncident(lock.incidentId as string) : undefined;
      const ops: TxOp[] = [];
      const isNew = !meta;
      if (!meta && spec.onlyIfExists) return { incidentId: '', created: false, newReports: 0, newUsers: 0, changed: false, left: [] as typeof remaining };
      if (!meta) {
        const zone = getZone(spec.zoneId)!;
        const id = opaqueId('INC', 10);
        meta = {
          entity: 'INCIDENT',
          incidentId: id,
          kind: spec.kind,
          logicalKey: spec.logicalKey,
          zoneId: spec.zoneId,
          zoneCriticality: zone.criticality,
          family: spec.family,
          antennaIds: [...spec.antennaIds],
          status: 'REGISTRADA',
          title: spec.title,
          openedAt: at,
          firstEvidenceAt: spec.firstEvidenceAt,
          uniqueReporters: 0,
          reportCount: 0,
          estimatedUsers: estimatedUsersForAntennas(spec.antennaIds),
          worstAntennaStatus: spec.antennaStatus,
          currentAntennaStatus: spec.antennaStatus,
          investigationPending: spec.investigationPending ?? false,
          relatedIncidentIds: [],
          episodeIds: spec.episodeId ? [spec.episodeId] : [],
          statusSeq: 0,
          synthetic: spec.synthetic,
          version: 0,
        };
        ops.push({ type: 'put', item: { ...lockKey, entity: 'INCIDENT_LOCK', incidentId: id, createdAt: at }, condition: { kind: 'notExists' } });
        ops.push(hist(id, { at, actor: 'workflow', type: 'CREADO', toStatus: 'REGISTRADA', reason: spec.kind === 'COLECTIVO' ? 'Posible incidente colectivo detectado (umbral de usuarios distintos alcanzado)' : 'Incidente de infraestructura abierto desde la primera lectura anómala', data: spec.evidence }, spec.eventId));
      }
      const m: IncidentMeta = { ...meta, antennaIds: [...meta.antennaIds], episodeIds: [...meta.episodeIds] };
      const prevVersion = meta.version;
      // "structural": cambios que exigen reescribir el META con CAS (raros).
      // Agregar reportes/usuarios sólo incrementa contadores con ADD atómico (sin CAS):
      // evita que el META de un colectivo muy reportado sea un "hot item" de conflictos.
      let structural = isNew;

      // Antenas / episodio / severidad
      for (const a of spec.antennaIds) if (!m.antennaIds.includes(a)) { m.antennaIds.push(a); structural = true; }
      m.estimatedUsers = estimatedUsersForAntennas(m.antennaIds);
      if (spec.episodeId && !m.episodeIds.includes(spec.episodeId)) { m.episodeIds.push(spec.episodeId); structural = true; }
      if (spec.antennaStatus) {
        if (m.currentAntennaStatus !== spec.antennaStatus) structural = true;
        m.currentAntennaStatus = spec.antennaStatus;
        if (!m.worstAntennaStatus || STATUS_SEVERITY[spec.antennaStatus] > STATUS_SEVERITY[m.worstAntennaStatus]) m.worstAntennaStatus = spec.antennaStatus;
        if (spec.antennaStatus !== 'NORMAL' && m.recovery?.pendingVerification) m.recovery = undefined; // recaída
      }
      if (spec.investigationPending === false && m.investigationPending) { m.investigationPending = false; structural = true; }
      if (spec.firstEvidenceAt < m.firstEvidenceAt) { m.firstEvidenceAt = spec.firstEvidenceAt; structural = true; }

      // Reportes nuevos (lote acotado por transacción)
      const existingRel = isNew ? new Set<string>() : new Set((await queryAll(store, { pk: K.incidentPk(m.incidentId), skBeginsWith: 'REL#RPT#', consistent: true })).map((i) => i.ticketId as string));
      const existingUsr = isNew ? new Set<string>() : new Set((await queryAll(store, { pk: K.incidentPk(m.incidentId), skBeginsWith: 'USR#', consistent: true })).map((i) => i.userHash as string));
      const pending = remaining.filter((r) => !existingRel.has(r.ticketId));
      const batch = pending.slice(0, MAX_LINKS_PER_TX);
      const usersAdded = new Set<string>();
      for (const r of batch) {
        const rpt = (await store.get(K.report(r.ticketId).pk, 'META', { consistent: true })) as unknown as ReportMeta | undefined;
        if (!rpt) continue;
        ops.push({ type: 'put', item: { ...K.incidentRel(m.incidentId, 'RPT', r.ticketId), entity: 'RELATION', ticketId: r.ticketId, userHash: r.userHash, occurredAt: rpt.occurredAt, linkedAt: at }, condition: { kind: 'notExists' } });
        ops.push({ type: 'put', item: { ...K.reportIncident(r.ticketId, m.incidentId), entity: 'REPORT_INCIDENT', incidentId: m.incidentId, linkedAt: at } });
        const ids = rpt.incidentIds.includes(m.incidentId) ? rpt.incidentIds : [...rpt.incidentIds, m.incidentId];
        ops.push({ type: 'put', item: { ...K.report(r.ticketId), ...rpt, incidentIds: ids, version: rpt.version + 1 } as Item, condition: { kind: 'version', version: rpt.version } });
        if (!existingUsr.has(r.userHash) && !usersAdded.has(r.userHash)) {
          usersAdded.add(r.userHash);
          ops.push({ type: 'put', item: { ...K.incidentUser(m.incidentId, r.userHash), entity: 'AFFECTED_USER', userHash: r.userHash, firstTicketId: r.ticketId, at }, condition: { kind: 'notExists' } });
        }
      }
      if (batch.length) {
        ops.push(hist(m.incidentId, { at, actor: 'workflow', type: 'ASOCIACION', reason: `${batch.length} reporte(s) asociado(s); ${usersAdded.size} usuario(s) distinto(s) nuevo(s)`, data: { tickets: batch.map((b) => b.ticketId) } }, `${spec.eventId}-rpt-${batch[0].ticketId}`));
      }
      if (!structural && !batch.length) return { incidentId: m.incidentId, created: false, newReports: 0, newUsers: 0, changed: false, left: [] as typeof remaining };
      if (structural) {
        m.reportCount += batch.length;
        m.uniqueReporters += usersAdded.size;
        m.version = prevVersion + 1;
        ops.push({ type: 'put', item: incidentItem(m), condition: isNew ? { kind: 'notExists' } : { kind: 'version', version: prevVersion } });
      } else {
        // Sólo contadores: ADD atómico; la unicidad de usuarios la garantiza USR#<hash> (notExists).
        ops.push({ type: 'update', ...K.incident(m.incidentId), add: { reportCount: batch.length, uniqueReporters: usersAdded.size, version: 1 }, condition: { kind: 'exists' } });
      }
      await store.transact(ops);
      return { incidentId: m.incidentId, created: isNew, newReports: batch.length, newUsers: usersAdded.size, changed: structural, left: pending.slice(MAX_LINKS_PER_TX) };
    });
    incidentId = res.incidentId;
    created = created || res.created;
    totalNewReports += res.newReports;
    totalNewUsers += res.newUsers;
    materialChange = materialChange || res.changed;
    remaining = res.left;
  }
  if (!incidentId) return { incidentId: '', created: false, newReports: 0, newUsers: 0, materialChange: false };
  if (created) log.info('incidente_creado', { incidentId, kind: spec.kind, zoneId: spec.zoneId });
  return { incidentId: incidentId!, created, newReports: totalNewReports, newUsers: totalNewUsers, materialChange };
}

/** Vincula dos incidentes relacionados (infraestructura <-> colectivo) sin duplicar usuarios. */
export async function linkIncidents(a: string, b: string, eventId: string): Promise<boolean> {
  if (a === b) return false;
  const { store, now } = await rt();
  let changed = false;
  for (const [x, y] of [[a, b], [b, a]] as const) {
    await withCas(async () => {
      const m = await getIncident(x);
      if (!m || m.relatedIncidentIds.includes(y)) return;
      const at = now().toISOString();
      const next: IncidentMeta = { ...m, relatedIncidentIds: [...m.relatedIncidentIds, y], version: m.version + 1 };
      if (m.kind === 'COLECTIVO') {
        const other = await getIncident(y);
        if (other?.kind === 'INFRAESTRUCTURA') next.investigationPending = false;
      }
      await store.transact([
        { type: 'put', item: incidentItem(next), condition: { kind: 'version', version: m.version } },
        { type: 'put', item: { ...K.incidentRel(x, 'INC', y), entity: 'RELATION', relatedIncidentId: y, linkedAt: at } },
        hist(x, { at, actor: 'workflow', type: 'ASOCIACION', reason: `Relacionado con ${y} por zona y ventana temporal (correlación, no causalidad confirmada)` }, `${eventId}-inc-${y}`),
      ]);
      changed = true;
    });
  }
  return changed;
}

/** Recuperación técnica: se registra, pero NO se declara resuelto sin verificación del operador. */
export async function recordRecovery(incidentId: string, p: { endedAt: string; normalReadings: number; episodeId: string }, policy: string, eventId: string): Promise<boolean> {
  const { store } = await rt();
  return withCas(async () => {
    const m = await getIncident(incidentId);
    if (!m || m.status === 'CERRADA') return false;
    if (m.recovery?.detectedAt === p.endedAt) return false;
    const next: IncidentMeta = { ...m, currentAntennaStatus: 'NORMAL', recovery: { detectedAt: p.endedAt, normalReadings: p.normalReadings, policy, pendingVerification: true }, version: m.version + 1 };
    await store.transact([
      { type: 'put', item: incidentItem(next), condition: { kind: 'version', version: m.version } },
      hist(incidentId, { at: p.endedAt, actor: 'workflow', type: 'RECUPERACION_TECNICA', reason: `Recuperación técnica detectada (${policy}). Pendiente de verificación del operador antes de marcar SOLUCIONADA.`, data: { episodeId: p.episodeId } }, eventId),
    ]);
    return true;
  });
}

export async function recalculatePriority(incidentId: string, eventId: string): Promise<{ result: PriorityResult; levelChanged: boolean } | undefined> {
  const { store, now, priorityCfg } = await rt();
  return withCas(async () => {
    const m = await getIncident(incidentId);
    if (!m) return undefined;
    const result = computePriority(
      { uniqueReporters: m.uniqueReporters, estimatedUsers: m.estimatedUsers, zoneCriticality: m.zoneCriticality, worstAntennaStatus: m.status === 'CERRADA' ? undefined : m.currentAntennaStatus && m.currentAntennaStatus !== 'NORMAL' ? m.currentAntennaStatus : m.recovery ? undefined : m.worstAntennaStatus, openedAt: m.openedAt, now: now() },
      priorityCfg,
    );
    const levelChanged = m.priority?.level !== result.level;
    if (m.priority && m.priority.score === result.score && !levelChanged) return { result, levelChanged: false };
    const at = now().toISOString();
    const priority = { score: result.score, level: result.level, factors: result.factors, computedAt: at };
    const active = m.status !== 'CERRADA';
    // Condición sobre los contadores usados: si otro flujo los cambió entretanto, ese
    // flujo recalculará después (CalculatePriority corre tras cada persistencia).
    const ops: TxOp[] = [
      {
        type: 'update',
        ...K.incident(incidentId),
        set: { priority, ...(active ? { gsi2sk: `${invertedScore(result.score)}#${m.openedAt}#${m.incidentId}` } : {}) },
        add: { version: 1 },
        condition: { kind: 'attrEquals', attr: 'uniqueReporters', value: m.uniqueReporters },
      },
    ];
    if (levelChanged) ops.push(hist(incidentId, { at, actor: 'workflow', type: 'PRIORIDAD', reason: `Prioridad ${m.priority?.level ?? '—'} → ${result.level} (puntaje ${result.score})`, data: { factors: result.factors } }, `${eventId}-prio-${result.level}`));
    try {
      await store.transact(ops);
    } catch (e) {
      if (e instanceof ConditionFailedError) return { result, levelChanged: false };
      throw e;
    }
    return { result, levelChanged };
  });
}

/** Cambio de estado por operador, validado y auditado. Emite outbox para propagar y notificar. */
export async function changeIncidentStatus(incidentId: string, to: CaseStatus, reason: string, actor: string, opts: { reopen?: boolean; expectedVersion?: number } = {}) {
  if (!reason || reason.trim().length < 5) throw badRequest('Debe indicar un motivo (mínimo 5 caracteres)');
  const { store, now } = await rt();
  return withCas(async () => {
    const m = await getIncident(incidentId);
    if (!m) throw notFound('Incidente no encontrado');
    if (opts.expectedVersion !== undefined && opts.expectedVersion !== m.version) throw conflict('El incidente fue modificado por otra persona; recargue', { currentVersion: m.version });
    try {
      assertTransition(m.status, to, { reopen: opts.reopen });
    } catch (e) {
      if (e instanceof InvalidTransitionError) throw conflict(e.message, { from: m.status, to, reopen: !!opts.reopen });
      throw e;
    }
    const at = now().toISOString();
    const next: IncidentMeta = { ...m, status: to, statusSeq: m.statusSeq + 1, version: m.version + 1 };
    if (to === 'SOLUCIONADA') {
      next.solvedAt = at;
      if (next.recovery) next.recovery = { ...next.recovery, pendingVerification: false };
    }
    if (to === 'CERRADA') next.closedAt = at;
    if (opts.reopen) {
      next.closedAt = undefined;
      next.solvedAt = undefined;
    }
    const lockKey = K.incidentLock(m.logicalKey);
    const ops: TxOp[] = [{ type: 'put', item: incidentItem(next), condition: { kind: 'version', version: m.version } }];
    if (to === 'CERRADA') ops.push({ type: 'delete', ...lockKey, condition: { kind: 'attrEquals', attr: 'incidentId', value: m.incidentId } });
    if (opts.reopen && m.status === 'CERRADA') ops.push({ type: 'put', item: { ...lockKey, entity: 'INCIDENT_LOCK', incidentId: m.incidentId, createdAt: at }, condition: { kind: 'notExists' } });
    const eventId = `inc-${m.incidentId}-s${next.statusSeq}`;
    ops.push(hist(m.incidentId, { at, actor, type: opts.reopen ? 'REAPERTURA' : 'CAMBIO_ESTADO', fromStatus: m.status, toStatus: to, reason: reason.trim().slice(0, 500) }, eventId));
    const out: OutboxEvent = { entity: 'OUTBOX', eventId, type: 'INCIDENT_STATUS_CHANGED', subjectId: m.incidentId, payload: { incidentId: m.incidentId, from: m.status, to, statusSeq: next.statusSeq, reopen: !!opts.reopen }, createdAt: at, status: 'PENDIENTE' };
    ops.push({ type: 'put', item: { ...K.outbox(eventId), ...out, gsi1pk: K.outboxPendingGsi, gsi1sk: at }, condition: { kind: 'notExists' } });
    try {
      await store.transact(ops);
    } catch (e) {
      if (e instanceof ConditionFailedError && opts.reopen && e.reasons[1] === 'ConditionalCheckFailed') {
        const other = await getActiveIncidentId(m.logicalKey);
        throw conflict('Ya existe otro incidente activo para la misma clave; revise ese incidente', { activeIncidentId: other });
      }
      throw e;
    }
    log.info('incidente_cambio_estado', { incidentId, from: m.status, to, actor: actor.split(':')[0] });
    return next;
  });
}

/** Propaga el estado del incidente a sus reportes vinculados (sin retroceder salvo reapertura). */
export async function propagateStatusToReports(incidentId: string, statusSeq: number, reopen: boolean): Promise<{ updated: string[] }> {
  const { store, now } = await rt();
  const m = await getIncident(incidentId);
  if (!m) return { updated: [] };
  const target = reportStatusForIncident(m.status);
  const rels = await queryAll(store, { pk: K.incidentPk(incidentId), skBeginsWith: 'REL#RPT#', consistent: true });
  const updated: string[] = [];
  for (const rel of rels) {
    const ticketId = rel.ticketId as string;
    await withCas(async () => {
      const r = (await store.get(K.report(ticketId).pk, 'META', { consistent: true })) as unknown as ReportMeta | undefined;
      if (!r || r.status === target) return;
      const forward = STATUS_ORDER[target] > STATUS_ORDER[r.status];
      if (!forward && !reopen) return;
      const at = now().toISOString();
      await store.transact([
        { type: 'put', item: { ...K.report(ticketId), ...r, status: target, version: r.version + 1 } as Item, condition: { kind: 'version', version: r.version } },
        { type: 'put', item: { pk: K.report(ticketId).pk, sk: `HIST#${at}#inc-${incidentId}-s${statusSeq}`, entity: 'HISTORY', at, actor: 'workflow', type: reopen ? 'REAPERTURA' : 'CAMBIO_ESTADO', fromStatus: r.status, toStatus: target, reason: `Actualizado por el incidente ${incidentId}` } },
      ]);
      updated.push(ticketId);
    });
  }
  return { updated };
}

export async function markReportEvaluated(ticketId: string, eventId: string, summary: string): Promise<boolean> {
  const { store, now } = await rt();
  return withCas(async () => {
    const r = (await store.get(K.report(ticketId).pk, 'META', { consistent: true })) as unknown as ReportMeta | undefined;
    if (!r || r.evaluatedAt) return false;
    const at = now().toISOString();
    const status: CaseStatus = r.status === 'REGISTRADA' ? 'EN_REVISION' : r.status;
    await store.transact([
      { type: 'put', item: { ...K.report(ticketId), ...r, status, evaluatedAt: at, version: r.version + 1 } as Item, condition: { kind: 'version', version: r.version } },
      { type: 'put', item: { pk: K.report(ticketId).pk, sk: `HIST#${at}#${eventId}`, entity: 'HISTORY', at, actor: 'workflow', type: 'CAMBIO_ESTADO', fromStatus: r.status, toStatus: status, reason: summary } },
    ]);
    return true;
  });
}

export async function persistAnalysis(incidentId: string, a: { source: 'VERTEX_AI_GEMINI' | 'AI_UNAVAILABLE'; summary: string; generatedAt: string; model?: string; full: Record<string, unknown> }, eventId: string): Promise<void> {
  const { store } = await rt();
  await withCas(async () => {
    const m = await getIncident(incidentId);
    if (!m) return;
    const next: IncidentMeta = { ...m, ai: { source: a.source, summary: a.summary, generatedAt: a.generatedAt, model: a.model }, version: m.version + 1 };
    await store.transact([
      { type: 'put', item: incidentItem(next), condition: { kind: 'version', version: m.version } },
      { type: 'put', item: { ...K.incidentAi(incidentId, a.generatedAt), entity: 'AI_ANALYSIS', source: a.source, ...a.full } },
      hist(incidentId, { at: a.generatedAt, actor: 'workflow', type: 'ANALISIS_IA', reason: a.source === 'VERTEX_AI_GEMINI' ? `Análisis generado por ${a.model}` : 'IA no disponible: análisis de respaldo por reglas locales (AI_UNAVAILABLE)' }, `${eventId}-ai`),
    ]);
  });
}

export async function listIncidents(q: { active?: boolean; zoneId?: string; level?: string; kind?: string; status?: string; limit?: number }) {
  const { store } = await rt();
  const active = q.active !== false;
  const items = (await queryAll(store, { index: 'gsi2', pk: K.incidentQueueGsi(active), descending: !active }, 2000)) as unknown as IncidentMeta[];
  return items
    .filter((i) => (!q.zoneId || i.zoneId === q.zoneId) && (!q.level || i.priority?.level === q.level) && (!q.kind || i.kind === q.kind) && (!q.status || i.status === q.status))
    .slice(0, Math.min(q.limit ?? 200, 500))
    .map(publicIncident);
}

export function publicIncident(i: IncidentMeta) {
  return { ...i, zoneName: getZone(i.zoneId)?.name, entity: undefined, logicalKey: undefined, gsi1pk: undefined, gsi1sk: undefined, gsi2pk: undefined, gsi2sk: undefined, pk: undefined, sk: undefined };
}

export async function incidentDetail(id: string) {
  const { store } = await rt();
  const m = await getIncident(id);
  if (!m) throw notFound('Incidente no encontrado');
  const all = await queryAll(store, { pk: K.incidentPk(id), consistent: true }, 5000);
  const reports = all.filter((i) => String(i.sk).startsWith('REL#RPT#'));
  const history = all.filter((i) => String(i.sk).startsWith('HIST#'));
  const ai = all.filter((i) => String(i.sk).startsWith('AI#')).sort((a, b) => String(b.sk).localeCompare(String(a.sk)));
  const notifs = await queryAll(store, { index: 'gsi1', pk: K.notificationsGsi(id) });
  return {
    incident: publicIncident(m),
    reports: reports.map((r) => ({ ticketId: r.ticketId, occurredAt: r.occurredAt, linkedAt: r.linkedAt, reporterRef: String(r.userHash).slice(0, 10) })),
    history: history.map((h) => ({ at: h.at, actor: h.actor, type: h.type, fromStatus: h.fromStatus, toStatus: h.toStatus, reason: h.reason, data: h.data })),
    aiAnalyses: ai.map((a) => ({ ...a, pk: undefined, sk: undefined, entity: undefined })),
    notifications: notifs.map((n) => ({ notificationId: n.notificationId, kind: n.kind, channel: n.channel, status: n.status, provider: n.provider, attempts: n.attempts, createdAt: n.createdAt, updatedAt: n.updatedAt, lastError: n.lastError, ticketId: n.ticketId })),
    priorityRank: m.priority ? LEVEL_RANK[m.priority.level] : 0,
  };
}

export async function incidentHistory(id: string) {
  const { store } = await rt();
  if (!(await getIncident(id))) throw notFound('Incidente no encontrado');
  const h = await queryAll(store, { pk: K.incidentPk(id), skBeginsWith: 'HIST#', consistent: true });
  return h.map((x) => ({ at: x.at, actor: x.actor, type: x.type, fromStatus: x.fromStatus, toStatus: x.toStatus, reason: x.reason, data: x.data }));
}
