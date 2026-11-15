import { getZone } from '../domain/catalog.js';
import { hmacHex, sha256Hex } from '../lib/crypto.js';
import { log } from '../lib/logger.js';
import { getKeys } from '../lib/secrets.js';
import type { IncidentMeta, NotificationKind, NotificationRecord, ReportMeta } from '../repo/entities.js';
import { K } from '../repo/keys.js';
import { ConditionFailedError, queryAll, type Item } from '../store/types.js';
import { getReportContact } from './reports.js';
import { rt, withCas } from './runtime.js';

export class NotificationRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationRetryableError';
  }
}

const MAX_ATTEMPTS = 3;

/**
 * Crea registros de notificación DEDUPLICADOS por
 * (tipo, sujeto[incidente|reporte], estado/secuencia, canal, destinatario seudonimizado).
 * El ítem NOTIF se inserta con attribute_not_exists; el stream de DynamoDB lo
 * publica en la cola de notificaciones (outbox) => sin doble escritura DynamoDB+SQS.
 */
export async function enqueueForReport(kind: NotificationKind, ticketId: string, scope: string, incident?: IncidentMeta): Promise<number> {
  const { store, now, notifiers } = await rt();
  const r = (await store.get(K.report(ticketId).pk, 'META', { consistent: true })) as unknown as ReportMeta | undefined;
  if (!r || !r.notifyConsent) return 0; // sin consentimiento => no se contacta
  const contact = await getReportContact(ticketId);
  const keys = await getKeys();
  let created = 0;
  for (const channel of r.contactChannels) {
    const recipient = channel === 'EMAIL' ? contact.email : contact.phone;
    if (!recipient) continue;
    const recipientHash = hmacHex(keys.pseudonym, `recipient:${recipient.toLowerCase()}`);
    const dedupKey = `${kind}#${scope}#${channel}#${recipientHash}`;
    const dedupHash = sha256Hex(dedupKey);
    const provider = notifiers.find((n) => n.channel === channel);
    const at = now().toISOString();
    const rec: NotificationRecord = {
      entity: 'NOTIFICATION',
      notificationId: dedupHash,
      dedupKey: `${kind}#${scope}#${channel}`, // sin destinatario en claro
      kind,
      channel,
      ticketId,
      incidentId: incident?.incidentId,
      provider: provider?.name ?? 'NO_CONFIGURADO',
      status: provider ? 'PENDIENTE' : 'OMITIDA',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
      lastError: provider ? undefined : `Canal ${channel} no configurado en este entorno`,
      synthetic: r.synthetic,
      version: 1,
    };
    try {
      await store.put(
        { ...K.notification(dedupHash), ...rec, gsi1pk: K.notificationsGsi(incident?.incidentId ?? ticketId), gsi1sk: at, gsi2pk: `NOTIFT#${ticketId}`, gsi2sk: at } as Item,
        { kind: 'notExists' },
      );
      created++;
    } catch (e) {
      if (!(e instanceof ConditionFailedError)) throw e; // ya existía => deduplicado
    }
  }
  return created;
}

export async function enqueueForIncidentReporters(kind: NotificationKind, incident: IncidentMeta, scope: string): Promise<number> {
  const { store } = await rt();
  const rels = await queryAll(store, { pk: K.incidentPk(incident.incidentId), skBeginsWith: 'REL#RPT#', consistent: true });
  let n = 0;
  for (const rel of rels) n += await enqueueForReport(kind, rel.ticketId as string, scope, incident);
  return n;
}

function render(kind: NotificationKind, ticketId: string, incident?: IncidentMeta): { subject: string; body: string } {
  const zone = incident ? getZone(incident.zoneId)?.name : undefined;
  const foot = `\n\nConsulte el estado con su token en el portal TeleCorp Sentinel (ticket ${ticketId}).\nEste mensaje es automático. Datos de demostración del proyecto académico TeleCorp Sentinel.`;
  switch (kind) {
    case 'REPORTE_EVALUADO':
      return { subject: `Su reporte ${ticketId} fue evaluado`, body: `Hola. Su reporte ${ticketId} fue recibido y evaluado por nuestro sistema de monitoreo. Ahora se encuentra EN REVISIÓN.${foot}` };
    case 'INCIDENTE_ZONA':
      return { subject: `Posible incidencia de red en ${zone ?? 'su zona'}`, body: `Hola. Detectamos un posible incidente de servicio en ${zone ?? 'su zona'} relacionado con su reporte ${ticketId}. Nuestro equipo lo está investigando; aún no se ha confirmado la causa.${foot}` };
    case 'SERVICIO_RESTABLECIDO':
      return { subject: `Servicio restablecido en ${zone ?? 'su zona'}`, body: `Hola. El operador verificó el restablecimiento del servicio asociado a su reporte ${ticketId}. Si el problema persiste, registre un nuevo reporte.${foot}` };
  }
}

function isAllowed(recipient: string, allowed: string[]): boolean {
  if (allowed.includes('*')) return true;
  const r = recipient.toLowerCase();
  return allowed.some((a) => a.toLowerCase() === r);
}

/**
 * Consumidor de la cola de notificaciones. Política ante incertidumbre: si un
 * intento previo quedó en ENVIANDO (pudo enviarse pero se perdió la respuesta),
 * NO se reenvía automáticamente: se marca INCIERTA para revisión manual. Nunca
 * se afirma "recibido": sólo "aceptada por el proveedor".
 */
export async function processNotification(notificationId: string): Promise<NotificationRecord['status']> {
  const { store, now, notifiers, allowedRecipients } = await rt();
  const key = K.notification(notificationId);
  const claim = await withCas(async () => {
    const rec = (await store.get(key.pk, key.sk, { consistent: true })) as unknown as (NotificationRecord & Item) | undefined;
    if (!rec) return { action: 'skip' as const, status: 'OMITIDA' as const };
    if (['ACEPTADA_PROVEEDOR', 'OMITIDA', 'FALLIDA', 'INCIERTA'].includes(rec.status)) return { action: 'skip' as const, status: rec.status };
    const at = now().toISOString();
    if (rec.status === 'ENVIANDO') {
      await store.put({ ...rec, status: 'INCIERTA', updatedAt: at, lastError: 'Respuesta del proveedor perdida en un intento previo; no se reenvía automáticamente', version: rec.version + 1 }, { kind: 'version', version: rec.version });
      return { action: 'skip' as const, status: 'INCIERTA' as const };
    }
    const next = { ...rec, status: 'ENVIANDO' as const, attempts: rec.attempts + 1, updatedAt: at, version: rec.version + 1 };
    await store.put(next, { kind: 'version', version: rec.version });
    return { action: 'send' as const, rec: next };
  });
  if (claim.action === 'skip') return claim.status;
  const rec = claim.rec;
  const finish = async (patch: Partial<NotificationRecord>) => {
    await withCas(async () => {
      const cur = (await store.get(key.pk, key.sk, { consistent: true })) as unknown as NotificationRecord & Item;
      await store.put({ ...cur, ...patch, updatedAt: now().toISOString(), version: cur.version + 1 }, { kind: 'version', version: cur.version });
    });
  };
  const provider = notifiers.find((n) => n.channel === rec.channel);
  const contact = await getReportContact(rec.ticketId);
  const recipient = rec.channel === 'EMAIL' ? contact.email : contact.phone;
  if (!provider || !recipient) {
    await finish({ status: 'OMITIDA', lastError: 'Proveedor o destinatario no disponible' });
    return 'OMITIDA';
  }
  if (!isAllowed(recipient, allowedRecipients)) {
    await finish({ status: 'OMITIDA', lastError: 'Destinatario fuera de la lista permitida (sandbox / datos de demo)' });
    return 'OMITIDA';
  }
  const incident = rec.incidentId ? ((await store.get(K.incident(rec.incidentId).pk, 'META')) as unknown as IncidentMeta) : undefined;
  const msg = render(rec.kind, rec.ticketId, incident);
  try {
    const res = await provider.send(recipient, msg.subject, msg.body);
    await finish({ status: 'ACEPTADA_PROVEEDOR', providerMessageId: res.providerMessageId, lastError: undefined });
    log.info('notificacion_aceptada_proveedor', { notificationId, kind: rec.kind, channel: rec.channel, provider: provider.name });
    return 'ACEPTADA_PROVEEDOR';
  } catch (e) {
    const message = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : 'error';
    if (rec.attempts >= MAX_ATTEMPTS) {
      await finish({ status: 'FALLIDA', lastError: message });
      log.error('notificacion_fallida', e, { notificationId });
      return 'FALLIDA';
    }
    await finish({ status: 'FALLIDA_REINTENTABLE', lastError: message });
    throw new NotificationRetryableError(message);
  }
}

export async function listNotifications(subjectId: string) {
  const { store } = await rt();
  const items = await queryAll(store, { index: 'gsi1', pk: K.notificationsGsi(subjectId) });
  return items.map((n) => ({ notificationId: n.notificationId, kind: n.kind, channel: n.channel, status: n.status, provider: n.provider, attempts: n.attempts, createdAt: n.createdAt, updatedAt: n.updatedAt, lastError: n.lastError }));
}
