import { log } from '../lib/logger.js';
import type { OutboxEvent, ProcessingRecord } from '../repo/entities.js';
import { K, RETENTION, ttlFromNow } from '../repo/keys.js';
import { queryAll, type ChangeRecord, type Item } from '../store/types.js';
import { rt, withCas } from './runtime.js';
import { applyTelemetryEvent } from './telemetry.js';

/**
 * PUBLICADOR OUTBOX (consumidor de DynamoDB Streams).
 * - INSERT de OUTBOX#… => mensaje a la cola de eventos.
 * - INSERT de NOTIF#…  => mensaje a la cola de notificaciones (si está PENDIENTE).
 * Tras publicar marca el outbox como PUBLICADO (y le asigna TTL). Si la
 * publicación falla, el error se propaga para que Streams reintente; además el
 * reconciliador re-publica los PENDIENTES antiguos (por si el stream expiró).
 */
export async function publishChanges(records: ChangeRecord[]): Promise<{ events: number; notifications: number }> {
  const { queues } = await rt();
  const events: { id: string; body: Record<string, unknown> }[] = [];
  const notifs: { id: string; body: Record<string, unknown> }[] = [];
  for (const r of records) {
    if (r.eventName !== 'INSERT' || !r.newImage) continue;
    const it = r.newImage;
    if (it.pk.startsWith('OUTBOX#')) events.push({ id: it.eventId as string, body: { eventId: it.eventId, type: it.type, subjectId: it.subjectId } });
    else if (it.pk.startsWith('NOTIF#') && it.status === 'PENDIENTE') notifs.push({ id: it.notificationId as string, body: { notificationId: it.notificationId } });
  }
  if (events.length) await queues.send('events', events);
  if (notifs.length) await queues.send('notifications', notifs);
  for (const e of events) await markPublished(e.id);
  return { events: events.length, notifications: notifs.length };
}

async function markPublished(eventId: string): Promise<void> {
  const { store, now } = await rt();
  const k = K.outbox(eventId);
  const cur = await store.get(k.pk, k.sk, { consistent: true });
  if (!cur || cur.status === 'PUBLICADO') return;
  const { gsi1pk: _a, gsi1sk: _b, ...rest } = cur;
  await store.put({ ...rest, pk: k.pk, sk: k.sk, status: 'PUBLICADO', publishedAt: now().toISOString(), ttl: ttlFromNow(RETENTION.outboxPublishedDays * 86400) });
}

/** Reconciliación: re-publica eventos outbox PENDIENTES con más de `olderThanMs`. */
export async function reconcileOutbox(olderThanMs = 120_000): Promise<number> {
  const { store, now } = await rt();
  const cutoff = new Date(now().getTime() - olderThanMs).toISOString();
  const pending = await queryAll(store, { index: 'gsi1', pk: K.outboxPendingGsi, skBetween: ['0', cutoff] }, 500);
  if (!pending.length) return 0;
  await publishChanges(pending.map((p) => ({ eventName: 'INSERT', newImage: p })));
  log.warn('outbox_reconciliado', { count: pending.length });
  return pending.length;
}

export function executionName(eventId: string, attempt = 0): string {
  const base = `evt-${eventId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 72);
  return attempt > 0 ? `${base}-r${attempt}` : base;
}

/**
 * CONSUMIDOR DE LA COLA DE EVENTOS.
 * - Telemetría: se aplica en línea (barato; sin Step Functions por cada minuto).
 * - Reportes / episodios de antena / cambios de estado: inicia Step Functions
 *   Standard con nombre DETERMINISTA (evt-<eventId>). Si la ejecución ya existe se
 *   considera iniciada. El mensaje sólo se confirma tras el inicio durable.
 */
export async function handleEventMessage(msg: { eventId: string; type: string; subjectId?: string }, opts: { replay?: boolean } = {}): Promise<string> {
  const { store, orchestrator, now } = await rt();
  if (msg.type === 'TELEMETRY_RECEIVED') {
    const out = (await store.get(K.outbox(msg.eventId).pk, 'OUTBOX', { consistent: true })) as unknown as OutboxEvent | undefined;
    const telemetryEventId = (out?.payload?.eventId as string) ?? msg.eventId.replace(/^tel-/, '');
    await applyTelemetryEvent(telemetryEventId);
    return 'APLICADA';
  }
  const pk = K.processing(msg.eventId);
  const existing = (await store.get(pk.pk, pk.sk, { consistent: true })) as unknown as ProcessingRecord | undefined;
  if (existing && ['COMPLETADO', 'EN_EJECUCION', 'INICIADO'].includes(existing.status)) {
    // Entrega SQS repetida: verificar/asegurar la ejecución con el mismo nombre (idempotente).
    await orchestrator.start(existing.executionName ?? executionName(msg.eventId), { eventId: msg.eventId });
    return 'YA_INICIADA';
  }
  if (existing?.status === 'FALLIDO' && !opts.replay) return 'FALLIDO_REQUIERE_REPLAY';
  const attempt = existing?.status === 'FALLIDO' ? existing.attempts : 0;
  const name = executionName(msg.eventId, attempt);
  const { executionArn, alreadyExisted } = await orchestrator.start(name, { eventId: msg.eventId });
  await withCas(async () => {
    const cur = (await store.get(pk.pk, pk.sk, { consistent: true })) as unknown as (ProcessingRecord & Item) | undefined;
    if (cur && cur.executionName === name && cur.status !== 'FALLIDO') return;
    const at = now().toISOString();
    const rec: ProcessingRecord = {
      entity: 'PROCESSING',
      eventId: msg.eventId,
      type: msg.type as ProcessingRecord['type'],
      status: cur?.status === 'COMPLETADO' ? 'COMPLETADO' : 'INICIADO',
      executionName: name,
      executionArn,
      attempts: (cur?.attempts ?? 0) + 1,
      startedAt: cur?.startedAt ?? at,
      updatedAt: at,
      version: (cur?.version ?? 0) + 1,
    };
    await store.put({ ...pk, ...rec, gsi1pk: K.processingGsi(rec.status), gsi1sk: at, ttl: ttlFromNow(RETENTION.processingDays * 86400) } as Item, cur ? { kind: 'version', version: cur.version } : { kind: 'notExists' });
  });
  return alreadyExisted ? 'YA_EXISTIA' : 'INICIADA';
}

export async function setProcessingStatus(eventId: string, status: ProcessingRecord['status'], error?: { name: string; message: string }): Promise<void> {
  const { store, now } = await rt();
  const pk = K.processing(eventId);
  await withCas(async () => {
    const cur = (await store.get(pk.pk, pk.sk, { consistent: true })) as unknown as (ProcessingRecord & Item) | undefined;
    const at = now().toISOString();
    const base: ProcessingRecord = cur ?? { entity: 'PROCESSING', eventId, type: 'REPORT_RECEIVED', status, attempts: 1, startedAt: at, updatedAt: at, version: 0 };
    if (cur?.status === 'COMPLETADO' && status !== 'COMPLETADO') return;
    const next = { ...base, status, updatedAt: at, completedAt: status === 'COMPLETADO' ? at : base.completedAt, error: error ?? (status === 'COMPLETADO' ? undefined : base.error), version: base.version + 1 };
    await store.put({ ...pk, ...next, gsi1pk: K.processingGsi(status), gsi1sk: at, ttl: ttlFromNow(RETENTION.processingDays * 86400) } as Item, cur ? { kind: 'version', version: cur.version } : { kind: 'notExists' });
  });
}

/** Replay específico de un evento cuya ejecución falló (la DLQ del consumidor no lo captura). */
export async function replayEvent(eventId: string): Promise<{ executionName: string }> {
  const { store } = await rt();
  const out = (await store.get(K.outbox(eventId).pk, 'OUTBOX', { consistent: true })) as unknown as OutboxEvent | undefined;
  if (!out) throw new Error('Evento outbox no encontrado (pudo expirar su retención)');
  await handleEventMessage({ eventId, type: out.type, subjectId: out.subjectId }, { replay: true });
  const rec = await store.get(K.processing(eventId).pk, 'PROC', { consistent: true });
  return { executionName: rec?.executionName as string };
}

export async function processingStats() {
  const { store } = await rt();
  const statuses = ['INICIADO', 'EN_EJECUCION', 'COMPLETADO', 'FALLIDO'] as const;
  const out: Record<string, number> = {};
  for (const s of statuses) out[s] = (await queryAll(store, { index: 'gsi1', pk: K.processingGsi(s) }, 20000)).length;
  const pendingOutbox = (await queryAll(store, { index: 'gsi1', pk: K.outboxPendingGsi }, 20000)).length;
  const failed = await queryAll(store, { index: 'gsi1', pk: K.processingGsi('FALLIDO'), descending: true }, 50);
  return { byStatus: out, pendingOutbox, recentFailures: failed.map((f) => ({ eventId: f.eventId, type: f.type, error: f.error, updatedAt: f.updatedAt, executionName: f.executionName })) };
}
