import { ANTENNAS, getAntenna, getZone } from '../domain/catalog.js';
import { evaluateRecurrence, type EpisodeSummary } from '../domain/recurrence.js';
import {
  DomainValidationError,
  applyReading,
  displayStatus,
  emptyAntennaState,
  trend,
  validateTelemetry,
  type AntennaState,
  type AntennaTransition,
} from '../domain/telemetry.js';
import { badRequest, notFound } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import type { AntennaEpisode, OutboxEvent } from '../repo/entities.js';
import { K, RETENTION, ttlFromNow } from '../repo/keys.js';
import { ConditionFailedError, queryAll, type Item, type TxOp } from '../store/types.js';
import { rt, withCas } from './runtime.js';

/**
 * Ingesta durable e idempotente de una métrica: registro original + marca de
 * idempotencia por eventId + outbox, en una TransactWrite.
 */
export async function ingestTelemetry(raw: unknown): Promise<{ eventId: string; status: string; duplicate: boolean }> {
  const { store, cfg, now } = await rt();
  let t;
  try {
    t = validateTelemetry(raw, now(), cfg);
  } catch (e) {
    if (e instanceof DomainValidationError || e instanceof RangeError) throw badRequest(e.message, (e as DomainValidationError).details);
    throw e;
  }
  const receivedAt = now().toISOString();
  const outboxId = `tel-${t.eventId}`;
  const outbox: OutboxEvent = { entity: 'OUTBOX', eventId: outboxId, type: 'TELEMETRY_RECEIVED', subjectId: t.antennaId, payload: { eventId: t.eventId }, createdAt: receivedAt, status: 'PENDIENTE' };
  try {
    await store.transact([
      { type: 'put', item: { ...K.telemetryEvent(t.eventId), entity: 'TELEMETRY_IDEMPOTENCY', antennaId: t.antennaId, observedAt: t.observedAt, ttl: ttlFromNow(RETENTION.telemetryIdempotencyDays * 86400) }, condition: { kind: 'notExists' } },
      {
        type: 'put',
        item: {
          ...K.metric(t.antennaId, t.observedAt, t.eventId),
          entity: 'METRIC',
          eventId: t.eventId,
          antennaId: t.antennaId,
          zoneId: t.zoneId,
          gbPerMinute: t.gbPerMinute,
          status: t.status,
          observedAt: t.observedAt,
          receivedAt,
          synthetic: t.synthetic ?? false,
          applied: false,
          version: 1,
          ttl: ttlFromNow(RETENTION.rawMetricsDays * 86400),
        },
      },
      { type: 'put', item: { ...K.outbox(outboxId), ...outbox, gsi1pk: K.outboxPendingGsi, gsi1sk: receivedAt }, condition: { kind: 'notExists' } },
    ]);
  } catch (e) {
    if (e instanceof ConditionFailedError) return { eventId: t.eventId, status: t.status, duplicate: true };
    throw e;
  }
  // Aplicación EN LÍNEA, en el orden en que llega la lectura (los productores envían en
  // orden por antena): evita el desorden de SQS estándar en ráfagas de lecturas
  // (observado en AWS). Si falla, la lectura ya es durable y el consumidor de la cola la
  // aplica después; es idempotente gracias a la marca `applied` de la métrica.
  if (process.env.TELEMETRY_INLINE_APPLY !== 'false') {
    try {
      await applyTelemetryEvent(t.eventId);
    } catch (e) {
      log.warn('telemetria_aplicacion_diferida', { eventId: t.eventId, motivo: (e as Error).name });
    }
  }
  return { eventId: t.eventId, status: t.status, duplicate: false };
}

/**
 * Aplica una métrica ya persistida al estado de la antena (consumidor de la cola).
 * CAS por versión del estado + marca "applied" en la métrica en la MISMA
 * transacción => idempotente ante entregas repetidas de SQS.
 * Las transiciones materiales (apertura/escalamiento/recuperación de episodio)
 * generan eventos outbox que disparan Step Functions.
 */
export async function applyTelemetryEvent(eventId: string): Promise<{ applied: boolean; transitions: AntennaTransition['kind'][]; late?: boolean }> {
  const { store, cfg } = await rt();
  const idem = await store.get(K.telemetryEvent(eventId).pk, 'EVT', { consistent: true });
  if (!idem) {
    log.warn('telemetria_no_encontrada', { eventId });
    return { applied: false, transitions: [] };
  }
  const antennaId = idem.antennaId as string;
  const mKey = K.metric(antennaId, idem.observedAt as string, eventId);

  return withCas(async () => {
    const metric = await store.get(mKey.pk, mKey.sk, { consistent: true });
    if (!metric || metric.applied) return { applied: false, transitions: [] };
    const ant = getAntenna(antennaId)!;
    const sKey = K.antennaState(antennaId);
    const stItem = await store.get(sKey.pk, sKey.sk, { consistent: true });
    const prev: AntennaState = stItem ? (stItem as unknown as AntennaState) : emptyAntennaState(antennaId, ant.zoneId);
    const res = applyReading(prev, { eventId, observedAt: metric.observedAt as string, gbPerMinute: metric.gbPerMinute as number }, cfg);
    const next = { ...res.state, version: prev.version + 1 };
    const ops: TxOp[] = [
      { type: 'put', item: { ...sKey, entity: 'ANTENNA_STATE', ...next } as Item, condition: prev.version === 0 && !stItem ? { kind: 'notExists' } : { kind: 'version', version: prev.version } },
      { type: 'put', item: { ...metric, applied: true, late: res.late, version: (metric.version as number) + 1 }, condition: { kind: 'version', version: metric.version as number } },
    ];
    for (const tr of res.transitions) {
      const ep = tr.episode;
      const epKey = K.episode(antennaId, ep.startedAt, ep.episodeId);
      const episode: AntennaEpisode & Item = {
        ...epKey,
        entity: 'EPISODE',
        episodeId: ep.episodeId,
        antennaId,
        zoneId: ant.zoneId,
        startedAt: ep.startedAt,
        worstStatus: ep.worstStatus,
        anomalousReadings: ep.anomalousReadings,
        endedAt: tr.kind === 'EPISODE_RECOVERED' ? tr.endedAt : undefined,
        gsi1pk: K.episodesGsi,
        gsi1sk: `${ep.startedAt}#${antennaId}`,
      };
      ops.push({ type: 'put', item: episode });
      const seq = tr.kind === 'EPISODE_OPENED' ? 'open' : tr.kind === 'EPISODE_RECOVERED' ? 'recovered' : `sev-${ep.anomalousReadings}`;
      const outId = `epi-${ep.episodeId}-${seq}`;
      const payload = {
        antennaId,
        zoneId: ant.zoneId,
        transition: tr.kind,
        episodeId: ep.episodeId,
        startedAt: ep.startedAt,
        currentStatus: tr.kind === 'EPISODE_RECOVERED' ? 'NORMAL' : ep.currentStatus,
        worstStatus: ep.worstStatus,
        observedAt: metric.observedAt,
        ...(tr.kind === 'EPISODE_RECOVERED' ? { endedAt: tr.endedAt, normalReadings: tr.normalReadings } : {}),
        ...(tr.kind === 'EPISODE_SEVERITY_CHANGED' ? { from: tr.from, to: tr.to } : {}),
      };
      const out: OutboxEvent = { entity: 'OUTBOX', eventId: outId, type: 'ANTENNA_EPISODE_CHANGED', subjectId: antennaId, payload, createdAt: new Date().toISOString(), status: 'PENDIENTE' };
      ops.push({ type: 'put', item: { ...K.outbox(outId), ...out, gsi1pk: K.outboxPendingGsi, gsi1sk: out.createdAt }, condition: { kind: 'notExists' } });
    }
    // Un ítem de episodio puede repetirse (apertura+recuperación no ocurren en la misma lectura).
    await store.transact(ops);
    if (res.transitions.length) log.info('transicion_antena', { antennaId, transitions: res.transitions.map((t) => t.kind) });
    return { applied: true, transitions: res.transitions.map((t) => t.kind), late: res.late };
  });
}

export async function listEpisodes(antennaId: string, sinceIso: string): Promise<AntennaEpisode[]> {
  const { store } = await rt();
  return (await queryAll(store, { pk: K.antennaPk(antennaId), skBetween: [`EPI#${sinceIso}`, 'EPI#~'] })) as unknown as AntennaEpisode[];
}

export async function listAntennas() {
  const { store, cfg, now } = await rt();
  const nowD = now();
  const since = new Date(nowD.getTime() - cfg.recurrenceWindowMs).toISOString();
  return Promise.all(
    ANTENNAS.map(async (a) => {
      const st = (await store.get(K.antennaState(a.antennaId).pk, 'STATE')) as unknown as AntennaState | undefined;
      const episodes = await listEpisodes(a.antennaId, since);
      const rec = evaluateRecurrence(a.antennaId, episodes as EpisodeSummary[], nowD, cfg.recurrenceEpisodes, cfg.recurrenceWindowMs);
      const zone = getZone(a.zoneId)!;
      return {
        ...a,
        zoneName: zone.name,
        zoneCriticality: zone.criticality,
        coordinatesAreSynthetic: true,
        lastValue: st?.lastValue ?? null,
        lastObservedAt: st?.lastObservedAt ?? null,
        rawStatus: st?.status ?? null,
        status: displayStatus(st, nowD, cfg),
        trend: trend(st?.recent ?? []),
        recent: st?.recent ?? [],
        consecutiveNormal: st?.consecutiveNormal ?? 0,
        recoveryPolicy: `${cfg.recoveryConsecutiveNormal} lecturas normales consecutivas`,
        openEpisode: st?.openEpisode ?? null,
        lateReadings: st?.lateReadings ?? 0,
        recurrence: rec,
      };
    }),
  );
}

export async function antennaMetrics(antennaId: string, q: { from?: string; to?: string; limit?: number }) {
  if (!getAntenna(antennaId)) throw notFound('Antena no encontrada');
  const { store, now } = await rt();
  const to = q.to ? new Date(q.to) : now();
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 2 * 3_600_000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) throw badRequest('Rango de fechas inválido');
  const items = await queryAll(store, { pk: K.antennaPk(antennaId), skBetween: [`MET#${from.toISOString()}`, `MET#${to.toISOString()}~`] }, Math.min(q.limit ?? 1500, 5000));
  const episodes = await listEpisodes(antennaId, new Date(to.getTime() - 30 * 86_400_000).toISOString());
  return {
    antennaId,
    from: from.toISOString(),
    to: to.toISOString(),
    unit: 'GB/min',
    metrics: items.map((m) => ({ observedAt: m.observedAt, gbPerMinute: m.gbPerMinute, status: m.status, late: m.late ?? false, synthetic: m.synthetic })),
    episodes: episodes.map((e) => ({
      episodeId: e.episodeId,
      startedAt: e.startedAt,
      endedAt: e.endedAt ?? null,
      worstStatus: e.worstStatus,
      anomalousReadings: e.anomalousReadings,
      durationMinutes: Math.round(((e.endedAt ? new Date(e.endedAt).getTime() : now().getTime()) - new Date(e.startedAt).getTime()) / 60_000),
    })),
  };
}
