import { beforeEach, describe, expect, it } from 'vitest';
import { STEPS } from '../src/workflow/steps.js';
import { changeIncidentStatus, getIncident, incidentDetail, listIncidents } from '../src/services/incidents.js';
import { handleEventMessage, processingStats, replayEvent } from '../src/services/pipeline.js';
import { ingestReport, lookupTicket } from '../src/services/reports.js';
import { ingestTelemetry, listAntennas } from '../src/services/telemetry.js';
import { queryAll } from '../src/store/types.js';
import type { LocalEnv } from '../src/local/localRuntime.js';
import { FakeAi, newEnv, report, reportBody } from './helpers.js';

let env: LocalEnv;

async function collectives(zoneId = 'Z-LPA') {
  return (await listIncidents({ active: true })).filter((i) => i.kind === 'COLECTIVO' && i.zoneId === zoneId);
}

let tick = 0;
async function metric(antennaId: string, zoneId: string, v: number, offsetSec?: number) {
  tick++;
  const at = new Date(Date.now() - 90_000 + (offsetSec ?? tick) * 1000).toISOString();
  return ingestTelemetry({ eventId: `t-${antennaId}-${Date.now()}-${tick}`, antennaId, zoneId, gbPerMinute: v, observedAt: at });
}

describe('incidente colectivo (10 usuarios distintos, ventana < 24 h)', () => {
  beforeEach(() => {
    env = newEnv();
  });

  it('9 distintos + repetición => sin colectivo; el 10.º distinto => exactamente uno; el 11.º actualiza afectación', async () => {
    for (let i = 0; i < 9; i++) await report(i);
    await report(3); // mismo usuario otra vez (otro ticket)
    await env.idle();
    expect(await collectives()).toHaveLength(0);

    await report(9);
    await env.idle();
    const c = await collectives();
    expect(c).toHaveLength(1);
    expect(c[0].uniqueReporters).toBe(10);
    expect(c[0].investigationPending).toBe(true); // antenas sin anomalía

    await report(10);
    await env.idle();
    const c2 = await collectives();
    expect(c2).toHaveLength(1);
    expect(c2[0].uniqueReporters).toBe(11);
  });

  it('otra zona, familia incompatible o exactamente 24 h antes NO cuentan', async () => {
    const t0 = Date.now() - 60 * 60_000;
    for (let i = 0; i < 9; i++) await report(i, { occurredAt: new Date(t0).toISOString() });
    await report(100, { zoneId: 'Z-MIR', occurredAt: new Date(t0).toISOString() });
    await report(101, { problemType: 'FACTURACION', occurredAt: new Date(t0).toISOString() });
    await report(102, { occurredAt: new Date(t0 - 24 * 3_600_000).toISOString() });
    await env.idle();
    expect(await collectives()).toHaveLength(0);
    expect(await collectives('Z-MIR')).toHaveLength(0);
  });

  it('10 reportes simultáneos (carrera) => exactamente un colectivo, 10 usuarios', async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => report(200 + i)));
    await env.idle();
    const c = await collectives();
    expect(c).toHaveLength(1);
    expect(c[0].uniqueReporters).toBe(10);
    expect(c[0].reportCount).toBe(10);
    const locks = env.store.dump().filter((x) => x.pk.startsWith('INCKEY#COLL#Z-LPA'));
    expect(locks).toHaveLength(1);
  });
});

describe('antenas, episodios y recuperación', () => {
  beforeEach(() => {
    env = newEnv();
  });

  it('abre UN incidente desde la primera lectura anómala, no uno por minuto; recuperación requiere verificación', async () => {
    await metric('ANT-CSU-01', 'Z-CSU', 100);
    for (let i = 0; i < 5; i++) await metric('ANT-CSU-01', 'Z-CSU', 30);
    await env.idle();
    let infra = (await listIncidents({})).filter((i) => i.kind === 'INFRAESTRUCTURA');
    expect(infra).toHaveLength(1);
    expect(infra[0].worstAntennaStatus).toBe('CAIDA');
    for (let i = 0; i < 3; i++) await metric('ANT-CSU-01', 'Z-CSU', 100);
    await env.idle();
    infra = (await listIncidents({})).filter((i) => i.kind === 'INFRAESTRUCTURA');
    expect(infra).toHaveLength(1);
    expect(infra[0].status).toBe('REGISTRADA'); // no se declara resuelto solo
    expect(infra[0].recovery?.pendingVerification).toBe(true);
    const ant = (await listAntennas()).find((a) => a.antennaId === 'ANT-CSU-01')!;
    expect(ant.status).toBe('NORMAL');
    expect(ant.recurrence.episodesInWindow).toBe(1);
  });

  it('telemetría duplicada (mismo eventId) no se procesa dos veces', async () => {
    const body = { eventId: 'dup-evt-000001', antennaId: 'ANT-MIR-01', zoneId: 'Z-MIR', gbPerMinute: 0, observedAt: new Date(Date.now() - 1000).toISOString() };
    const a = await ingestTelemetry(body);
    const b = await ingestTelemetry(body);
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(true);
    await env.idle();
    expect((await listIncidents({})).filter((i) => i.kind === 'INFRAESTRUCTURA')).toHaveLength(1);
  });

  it('antena caída correlacionada con reportes; múltiples antenas en la zona => incidentes por antena + colectivo relacionado sin duplicar usuarios', async () => {
    for (let i = 0; i < 10; i++) await report(300 + i, { zoneId: 'Z-SRN' });
    await metric('ANT-SRN-01', 'Z-SRN', 0);
    await metric('ANT-SRN-02', 'Z-SRN', 20);
    await env.idle();
    const all = (await listIncidents({})).filter((i) => i.zoneId === 'Z-SRN');
    const infra = all.filter((i) => i.kind === 'INFRAESTRUCTURA');
    const coll = all.filter((i) => i.kind === 'COLECTIVO');
    expect(infra).toHaveLength(2);
    expect(coll).toHaveLength(1);
    expect(coll[0].uniqueReporters).toBe(10);
    expect(coll[0].relatedIncidentIds.sort()).toEqual(infra.map((i) => i.incidentId).sort());
    for (const i of infra) expect(i.uniqueReporters).toBe(10); // mismo conjunto, no se suman
    expect(coll[0].priority?.level).toBeDefined();
    // Hospital (Z-SRN) con antena inhabilitada => alta prioridad
    expect(['CRITICA', 'ALTA']).toContain(infra.find((i) => i.antennaIds[0] === 'ANT-SRN-01')!.priority!.level);
  });

  it('hospital se prioriza frente a residencial en igualdad de condiciones', async () => {
    await metric('ANT-SRN-03', 'Z-SRN', 20);
    await metric('ANT-MIR-01', 'Z-MIR', 20);
    await env.idle();
    const inc = await listIncidents({});
    const h = inc.find((i) => i.antennaIds[0] === 'ANT-SRN-03')!;
    const r = inc.find((i) => i.antennaIds[0] === 'ANT-MIR-01')!;
    expect(h.priority!.score).toBeGreaterThan(r.priority!.score);
    expect(inc[0].incidentId).toBe(h.incidentId); // cola ordenada por prioridad
  });
});

describe('reportes: idempotencia, consulta y privacidad', () => {
  beforeEach(() => {
    env = newEnv();
  });

  it('reintento con la misma clave devuelve el mismo ticket y token; otra carga => 409', async () => {
    const body = reportBody(1);
    const a = await ingestReport(body);
    const b = await ingestReport(body);
    expect(b.duplicate).toBe(true);
    expect(b.ticketId).toBe(a.ticketId);
    expect(b.token).toBe(a.token);
    await expect(ingestReport({ ...body, description: 'otra descripción distinta' })).rejects.toMatchObject({ status: 409 });
    // El token nunca se guarda en claro
    expect(JSON.stringify(env.store.dump())).not.toContain(a.token);
  });

  it('consulta por token sin PII; token inválido => 404', async () => {
    const a = await report(7, { contact: { email: 'persona@example.com' }, notifyConsent: true });
    await env.idle();
    const v = await lookupTicket(a.token);
    expect(v.ticketId).toBe(a.ticketId);
    expect(v.status).toBe('EN_REVISION');
    const json = JSON.stringify(v);
    expect(json).not.toContain('40000007');
    expect(json).not.toContain('persona@example.com');
    expect(v.notifications.email).toBe('p***@example.com');
    await expect(lookupTicket('x'.repeat(43))).rejects.toMatchObject({ status: 404 });
    // Tampoco hay DNI/teléfono/correo en claro en la tabla
    const dump = JSON.stringify(env.store.dump());
    expect(dump).not.toContain('40000007');
    expect(dump).not.toContain('persona@example.com');
  });
});

describe('estados, historial, notificaciones e IA', () => {
  it('cambio de estado validado, historial, propagación a reportes y notificación de restablecimiento deduplicada', async () => {
    env = newEnv({ ai: new FakeAi('ok') });
    const r = await report(1, { zoneId: 'Z-VIN', contact: { email: 'demo@example.com' }, notifyConsent: true });
    await metric('ANT-VIN-01', 'Z-VIN', 0);
    await env.idle();
    const inc = (await listIncidents({})).find((i) => i.kind === 'INFRAESTRUCTURA')!;
    await expect(changeIncidentStatus(inc.incidentId, 'SOLUCIONADA', 'saltar estados', 'operador:test')).rejects.toMatchObject({ status: 409 });
    await changeIncidentStatus(inc.incidentId, 'EN_ATENCION', 'Cuadrilla enviada', 'operador:test');
    await changeIncidentStatus(inc.incidentId, 'SOLUCIONADA', 'Energía restablecida y verificada', 'operador:test');
    await env.idle();
    const d = await incidentDetail(inc.incidentId);
    expect(d.history.filter((h) => h.type === 'CAMBIO_ESTADO').map((h) => `${h.fromStatus}->${h.toStatus}`)).toEqual(['REGISTRADA->EN_ATENCION', 'EN_ATENCION->SOLUCIONADA']);
    expect(d.incident.ai?.source).toBe('VERTEX_AI_GEMINI');
    const view = await lookupTicket(r.token);
    expect(view.status).toBe('SOLUCIONADA');
    const kinds = env.mailbox.sent.map((m) => m.subject);
    expect(kinds.filter((s) => s.includes('restablecido'))).toHaveLength(1);
    expect(kinds.filter((s) => s.includes('evaluado'))).toHaveLength(1);
    // reapertura auditada y cierre
    await changeIncidentStatus(inc.incidentId, 'CERRADA', 'Cerrado tras verificación', 'operador:test');
    await changeIncidentStatus(inc.incidentId, 'EN_REVISION', 'Usuarios reportan de nuevo', 'operador:test', { reopen: true });
    await env.idle();
    const h = (await incidentDetail(inc.incidentId)).history;
    expect(h.some((x) => x.type === 'REAPERTURA')).toBe(true);
  });

  it('IA no disponible => respaldo etiquetado AI_UNAVAILABLE (nunca como Gemini); transitorio se reintenta', async () => {
    const ai = new FakeAi('transient');
    env = newEnv({ ai });
    await metric('ANT-LPA-01', 'Z-LPA', 0);
    await env.idle();
    const inc = (await listIncidents({}))[0];
    expect(inc.ai?.source).toBe('AI_UNAVAILABLE');
    expect(inc.ai?.summary).toContain('IA NO DISPONIBLE');
    expect(ai.calls).toBe(3); // 1 + 2 reintentos (Retry de la state machine)
  });

  it('el contexto enviado a la IA no contiene PII', async () => {
    let captured = '';
    env = newEnv({
      ai: {
        kind: 'spy',
        async analyze(ctx) {
          captured = JSON.stringify(ctx);
          return { summary: 's', probableCauses: [], recommendedActions: [], uncertainties: [], relatedProblemType: 'X', model: 'm', generatedAt: new Date().toISOString(), latencyMs: 1 };
        },
      },
    });
    for (let i = 0; i < 10; i++) await report(500 + i, { description: `Sin señal, llámenme al 987654321 o escriban a vecino${i}@correo.pe`, contact: { email: `vecino${i}@correo.pe` }, notifyConsent: true });
    await env.idle();
    expect(captured).not.toBe('');
    expect(captured).not.toMatch(/987654321|@correo\.pe|4000050\d/);
    expect(captured).toContain('[NUMERO]');
  });

  it('fallo de proveedor de correo se reintenta sin duplicar; respuesta perdida => INCIERTA sin reenvío', async () => {
    env = newEnv();
    env.mailbox.failNext = 1;
    await report(1, { contact: { email: 'a@example.com' }, notifyConsent: true });
    await env.idle();
    expect(env.mailbox.sent).toHaveLength(1);
    const notif = env.store.dump().find((x) => x.pk.startsWith('NOTIF#'))!;
    expect(notif.status).toBe('ACEPTADA_PROVEEDOR');
    expect(notif.attempts).toBe(2);
    // Simular respuesta perdida: quedó ENVIANDO
    await env.store.put({ ...notif, status: 'ENVIANDO', version: (notif.version as number) + 1 });
    env.notifications.send([{ id: 'x', body: { notificationId: notif.notificationId } }]);
    await env.idle();
    const after = await env.store.get(notif.pk, notif.sk);
    expect(after?.status).toBe('INCIERTA');
    expect(env.mailbox.sent).toHaveLength(1);
  });

  it('sin consentimiento no se notifica; destinatario fuera de la lista => OMITIDA', async () => {
    env = newEnv({ allowedRecipients: ['permitido@example.com'] });
    await report(1, { contact: { email: 'otro@example.com' }, notifyConsent: true });
    await report(2);
    await env.idle();
    expect(env.mailbox.sent).toHaveLength(0);
    const notifs = env.store.dump().filter((x) => x.pk.startsWith('NOTIF#'));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].status).toBe('OMITIDA');
  });
});

describe('confiabilidad: entregas repetidas, fallos y replay', () => {
  it('entrega SQS repetida no crea otra ejecución', async () => {
    env = newEnv();
    const r = await report(1);
    await env.idle();
    const before = env.orchestrator.executions.size;
    const res = await handleEventMessage({ eventId: `rpt-${r.ticketId}`, type: 'REPORT_RECEIVED' });
    await env.idle();
    expect(res).toBe('YA_INICIADA');
    expect(env.orchestrator.executions.size).toBe(before);
  });

  it('fallo de ejecución queda trazado (FALLIDO) y el replay específico lo recupera', async () => {
    env = newEnv();
    const original = STEPS.ValidateAndCorrelate;
    (STEPS as Record<string, unknown>).ValidateAndCorrelate = async () => {
      throw Object.assign(new Error('fallo controlado de prueba'), { name: 'ControlledFailure' });
    };
    const r = await report(1);
    await env.idle();
    let stats = await processingStats();
    expect(stats.byStatus.FALLIDO).toBe(1);
    expect((stats.recentFailures[0].error as { name?: string })?.name).toBe('ControlledFailure');
    // Una entrega repetida NO re-ejecuta automáticamente un evento fallido
    expect(await handleEventMessage({ eventId: `rpt-${r.ticketId}`, type: 'REPORT_RECEIVED' })).toBe('FALLIDO_REQUIERE_REPLAY');
    (STEPS as Record<string, unknown>).ValidateAndCorrelate = original;
    const rp = await replayEvent(`rpt-${r.ticketId}`);
    expect(rp.executionName).toMatch(/-r1$/);
    await env.idle();
    stats = await processingStats();
    expect(stats.byStatus.FALLIDO).toBe(0);
    expect(stats.byStatus.COMPLETADO).toBe(1);
  });

  it('ráfaga de 300 reportes: todos persistidos y procesados (sin pérdidas medidas)', async () => {
    env = newEnv();
    const zones = ['Z-LPA', 'Z-MIR', 'Z-CSU', 'Z-VIN', 'Z-CCV', 'Z-SRN'];
    const res = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => report(1000 + i, { zoneId: zones[i % zones.length] })));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(300);
    await env.idle(60_000);
    const stats = await processingStats();
    expect(stats.byStatus.COMPLETADO).toBe(300);
    expect(stats.pendingOutbox).toBe(0);
    expect(env.events.dlq).toHaveLength(0);
    const persisted = env.store.dump().filter((x) => x.pk.startsWith('RPT#') && x.sk === 'META');
    expect(persisted).toHaveLength(300);
    const coll = (await listIncidents({})).filter((i) => i.kind === 'COLECTIVO');
    expect(coll).toHaveLength(6); // 50 usuarios distintos por zona => 1 colectivo por zona
    const rels = await queryAll(env.store, { pk: `INC#${coll[0].incidentId}`, skBeginsWith: 'USR#' });
    expect(rels).toHaveLength(50);
    expect(await getIncident(coll[0].incidentId)).toBeDefined();
  }, 120_000);
});

describe('limitador de tasa por IP', () => {
  it('bajo concurrencia permite exactamente el máximo (contador atómico) y rechaza el resto con 429', async () => {
    env = newEnv();
    const { checkRateLimit } = await import('../src/services/reports.js');
    const res = await Promise.allSettled(Array.from({ length: 50 }, () => checkRateLimit('ip-de-prueba', 30)));
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(30);
    expect(res.filter((r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 429)).toHaveLength(20);
  });
});
