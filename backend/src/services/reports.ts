import { getZone } from '../domain/catalog.js';
import { PROBLEM_TYPES, maskEmail, maskPhone, normalizePhone, validateReport, type CaseStatus } from '../domain/reports.js';
import { DomainValidationError } from '../domain/telemetry.js';
import { canonicalJson, encryptField, hmacB64u, hmacHex, opaqueId, sha256Hex, decryptField } from '../lib/crypto.js';
import { badRequest, conflict, notFound, tooMany } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { getKeys } from '../lib/secrets.js';
import type { HistoryEvent, IncidentMeta, OutboxEvent, ReportMeta } from '../repo/entities.js';
import { K, RETENTION, ttlFromNow } from '../repo/keys.js';
import { ConditionFailedError, queryAll, type Item } from '../store/types.js';
import { rt } from './runtime.js';

export interface IngestReportResult {
  ticketId: string;
  /** Token de consulta: se muestra UNA vez; sólo se almacena su hash. */
  token: string;
  status: CaseStatus;
  receivedAt: string;
  duplicate: boolean;
}

function histItem(pk: string, ev: HistoryEvent, suffix: string): Item {
  return { pk, sk: `HIST#${ev.at}#${suffix}`, entity: 'HISTORY', ...ev };
}

/** Rate limit por IP seudonimizada (ventana fija de 1 minuto, contador atómico). */
export async function checkRateLimit(ipHash: string, maxPerMinute: number): Promise<void> {
  const { store, now } = await rt();
  const key = K.rateLimit(ipHash, now().toISOString().slice(0, 16));
  try {
    await store.increment(key.pk, key.sk, 'count', { max: maxPerMinute, ttl: ttlFromNow(RETENTION.rateLimitSeconds) });
  } catch (e) {
    if (e instanceof ConditionFailedError) throw tooMany();
    throw e;
  }
}

/**
 * Registra un reporte de forma DURABLE e IDEMPOTENTE en UNA TransactWrite:
 * idempotencia + reporte público + PII cifrada + punto de correlación + hash de
 * token + historial inicial + evento outbox. Sólo responde éxito tras confirmar.
 */
export async function ingestReport(raw: unknown): Promise<IngestReportResult> {
  const { store, cfg, now } = await rt();
  const nowD = now();
  let v;
  try {
    v = validateReport(raw, nowD, cfg);
  } catch (e) {
    if (e instanceof DomainValidationError) throw badRequest(e.message, e.details);
    throw e;
  }
  const keys = await getKeys();
  const { idempotencyKey, ...rest } = v;
  const requestHash = sha256Hex(
    canonicalJson({
      documentType: rest.documentType,
      documentNumber: rest.documentNumber,
      serviceNumber: rest.serviceNumber,
      zoneId: rest.zoneId,
      occurredAt: rest.occurredAt,
      problemType: rest.problemType,
      description: rest.description,
      contact: rest.contact,
      notifyConsent: rest.notifyConsent,
    }),
  );
  const idemKey = K.idem(sha256Hex(`report:${idempotencyKey}`));

  const existing = await store.get(idemKey.pk, idemKey.sk, { consistent: true });
  if (existing) return duplicateResult(existing, requestHash, idempotencyKey, keys.ticket);

  const ticketId = opaqueId('TCK', 12);
  const token = hmacB64u(keys.ticket, `ticket-token:v1:${ticketId}:${idempotencyKey}`);
  const tokenHash = sha256Hex(token);
  const userHash = hmacHex(keys.pseudonym, v.normalizedIdentity);
  const receivedAt = nowD.toISOString();
  const eventId = `rpt-${ticketId}`;

  const meta: ReportMeta = {
    entity: 'REPORT',
    ticketId,
    zoneId: v.zoneId,
    problemType: v.problemType,
    family: v.family,
    occurredAt: v.occurredAt,
    receivedAt,
    status: 'REGISTRADA',
    descriptionRedacted: v.descriptionRedacted,
    userHash,
    notifyConsent: v.notifyConsent,
    contactChannels: [...(v.contact?.email ? (['EMAIL'] as const) : []), ...(v.contact?.phone ? (['SMS'] as const) : [])],
    maskedEmail: maskEmail(v.contact?.email),
    maskedPhone: maskPhone(v.contact?.phone),
    lateForOpening: v.lateForOpening,
    synthetic: v.synthetic ?? false,
    incidentIds: [],
    version: 1,
  };
  const pii = {
    ...K.reportPii(ticketId),
    entity: 'REPORT_PII',
    serviceNumberEnc: encryptField(keys.pii, normalizePhone(v.serviceNumber)),
    descriptionEnc: encryptField(keys.pii, v.description),
    locationHintEnc: v.locationHint ? encryptField(keys.pii, v.locationHint) : undefined,
    emailEnc: v.contact?.email ? encryptField(keys.pii, v.contact.email.toLowerCase()) : undefined,
    phoneEnc: v.contact?.phone ? encryptField(keys.pii, normalizePhone(v.contact.phone)) : undefined,
  };
  const outbox: OutboxEvent = { entity: 'OUTBOX', eventId, type: 'REPORT_RECEIVED', subjectId: ticketId, payload: { ticketId }, createdAt: receivedAt, status: 'PENDIENTE' };
  const reportKey = K.report(ticketId);

  try {
    await store.transact([
      { type: 'put', item: { ...idemKey, entity: 'IDEMPOTENCY', ticketId, requestHash, createdAt: receivedAt, ttl: ttlFromNow(RETENTION.reportIdempotencyDays * 86400) }, condition: { kind: 'notExists' } },
      { type: 'put', item: { ...reportKey, ...meta, gsi2pk: K.reportDayGsi(receivedAt), gsi2sk: `${receivedAt}#${ticketId}` }, condition: { kind: 'notExists' } },
      { type: 'put', item: pii, condition: { kind: 'notExists' } },
      { type: 'put', item: { ...K.corrPoint(v.zoneId, v.family, v.occurredAt, ticketId), entity: 'CORRELATION_POINT', ticketId, userHash, occurredAt: v.occurredAt, receivedAt, synthetic: meta.synthetic } },
      { type: 'put', item: { ...K.token(tokenHash), entity: 'TICKET_TOKEN', ticketId }, condition: { kind: 'notExists' } },
      { type: 'put', item: histItem(reportKey.pk, { at: receivedAt, actor: 'ciudadano', type: 'CREADO', toStatus: 'REGISTRADA', reason: 'Reporte recibido' }, '000') },
      { type: 'put', item: { ...K.outbox(eventId), ...outbox, gsi1pk: K.outboxPendingGsi, gsi1sk: receivedAt }, condition: { kind: 'notExists' } },
    ]);
  } catch (e) {
    if (e instanceof ConditionFailedError && e.reasons[0] === 'ConditionalCheckFailed') {
      // Carrera con una solicitud idéntica concurrente: devolver la existente.
      const again = await store.get(idemKey.pk, idemKey.sk, { consistent: true });
      if (again) return duplicateResult(again, requestHash, idempotencyKey, keys.ticket);
    }
    throw e;
  }
  log.info('reporte_registrado', { ticketId, zoneId: v.zoneId, family: v.family, synthetic: meta.synthetic });
  return { ticketId, token, status: 'REGISTRADA', receivedAt, duplicate: false };
}

async function duplicateResult(existing: Item, requestHash: string, idempotencyKey: string, ticketKey: Buffer): Promise<IngestReportResult> {
  if (existing.requestHash !== requestHash) throw conflict('La clave de idempotencia ya se usó con datos diferentes');
  const ticketId = existing.ticketId as string;
  const { store } = await rt();
  const meta = await store.get(K.report(ticketId).pk, 'META', { consistent: true });
  // El token se RE-DERIVA (HMAC con secreto) en vez de almacenarse en claro.
  const token = hmacB64u(ticketKey, `ticket-token:v1:${ticketId}:${idempotencyKey}`);
  return { ticketId, token, status: (meta?.status as CaseStatus) ?? 'REGISTRADA', receivedAt: (meta?.receivedAt as string) ?? (existing.createdAt as string), duplicate: true };
}

/** Vista pública de un ticket (sin PII) a partir del token de consulta. */
export async function lookupTicket(token: string) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) throw badRequest('Token inválido');
  const { store } = await rt();
  const tok = await store.get(K.token(sha256Hex(token)).pk, 'TOK', { consistent: true });
  if (!tok) throw notFound('Ticket no encontrado');
  const ticketId = tok.ticketId as string;
  const meta = (await store.get(K.report(ticketId).pk, 'META', { consistent: true })) as unknown as ReportMeta | undefined;
  if (!meta) throw notFound('Ticket no encontrado');
  const hist = await queryAll(store, { pk: K.report(ticketId).pk, skBeginsWith: 'HIST#' });
  const incidents: Partial<IncidentMeta>[] = [];
  for (const id of meta.incidentIds ?? []) {
    const inc = (await store.get(K.incident(id).pk, 'META')) as unknown as IncidentMeta | undefined;
    if (inc) incidents.push({ incidentId: inc.incidentId, kind: inc.kind, status: inc.status, title: inc.title, openedAt: inc.openedAt, solvedAt: inc.solvedAt });
  }
  return {
    ticketId,
    status: meta.status,
    zone: { zoneId: meta.zoneId, name: getZone(meta.zoneId)?.name },
    problemType: meta.problemType,
    problemLabel: PROBLEM_TYPES[meta.problemType].label,
    occurredAt: meta.occurredAt,
    receivedAt: meta.receivedAt,
    notifications: { consent: meta.notifyConsent, email: meta.maskedEmail, phone: meta.maskedPhone },
    history: hist.map((h) => ({ at: h.at, type: h.type, fromStatus: h.fromStatus, toStatus: h.toStatus, reason: h.reason, actor: String(h.actor).startsWith('operador:') ? 'operador' : h.actor })),
    incidents,
  };
}

export function toOperatorReport(meta: ReportMeta) {
  return {
    ticketId: meta.ticketId,
    zoneId: meta.zoneId,
    zoneName: getZone(meta.zoneId)?.name,
    problemType: meta.problemType,
    family: meta.family,
    occurredAt: meta.occurredAt,
    receivedAt: meta.receivedAt,
    status: meta.status,
    description: meta.descriptionRedacted,
    reporterRef: meta.userHash.slice(0, 10), // seudónimo corto, no reversible
    contact: { consent: meta.notifyConsent, email: meta.maskedEmail, phone: meta.maskedPhone },
    incidentIds: meta.incidentIds,
    lateForOpening: meta.lateForOpening,
    synthetic: meta.synthetic,
  };
}

/** Lista reportes por rango (particiones diarias en GSI2; sin Scan). */
export async function listReports(q: { from?: string; to?: string; zoneId?: string; status?: string; limit?: number }) {
  const { store, now } = await rt();
  const to = q.to ? new Date(q.to) : now();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 7 * 86_400_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw badRequest('Rango de fechas inválido');
  if (to.getTime() - from.getTime() > 31 * 86_400_000) throw badRequest('El rango máximo es de 31 días');
  const limit = Math.min(q.limit ?? 200, 1000);
  const out: ReportMeta[] = [];
  for (let d = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate())); d.getTime() >= from.getTime() - 86_400_000 && out.length < limit; d = new Date(d.getTime() - 86_400_000)) {
    const items = await queryAll(store, { index: 'gsi2', pk: K.reportDayGsi(d.toISOString()), skBetween: [from.toISOString(), `${to.toISOString()}~`], descending: true }, limit);
    for (const it of items as unknown as ReportMeta[]) {
      if (q.zoneId && it.zoneId !== q.zoneId) continue;
      if (q.status && it.status !== q.status) continue;
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out.map(toOperatorReport);
}

/** Datos de contacto descifrados SÓLO para el envío de notificaciones. */
export async function getReportContact(ticketId: string): Promise<{ email?: string; phone?: string }> {
  const { store } = await rt();
  const keys = await getKeys();
  const pii = await store.get(K.reportPii(ticketId).pk, 'PII', { consistent: true });
  if (!pii) return {};
  return {
    email: pii.emailEnc ? decryptField(keys.pii, pii.emailEnc as string) : undefined,
    phone: pii.phoneEnc ? decryptField(keys.pii, pii.phoneEnc as string) : undefined,
  };
}
