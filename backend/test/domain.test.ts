import { describe, expect, it } from 'vitest';
import { estimatedUsersForAntennas } from '../src/domain/catalog.js';
import { DEFAULT_CONFIG } from '../src/domain/config.js';
import { maxDistinctUsersInWindow } from '../src/domain/correlation.js';
import { computePriority } from '../src/domain/priority.js';
import { evaluateRecurrence } from '../src/domain/recurrence.js';
import { redactText, validateReport } from '../src/domain/reports.js';
import { assertTransition, allowedTransitions } from '../src/domain/status.js';
import { applyReading, classifyGbPerMinute, displayStatus, emptyAntennaState, validateTelemetry } from '../src/domain/telemetry.js';

const H = 3_600_000;

describe('clasificación gbPerMinute (umbrales exactos)', () => {
  it.each([
    [0, 'INHABILITADA'],
    [0.0001, 'CAIDA'],
    [59.99, 'CAIDA'],
    [60, 'NORMAL'],
    [129, 'NORMAL'],
    [129.01, 'SATURADA'],
    [500, 'SATURADA'],
  ])('%s -> %s', (v, s) => expect(classifyGbPerMinute(v)).toBe(s));

  it('rechaza negativos y no finitos', () => {
    for (const v of [-1, -0.01, NaN, Infinity, -Infinity]) expect(() => classifyGbPerMinute(v)).toThrow();
  });

  it('validateTelemetry rechaza zona fuera de catálogo, antena de otra zona, futuro y negativo', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const base = { eventId: 'evt-00000001', antennaId: 'ANT-SRN-01', zoneId: 'Z-SRN', gbPerMinute: 80, observedAt: now.toISOString() };
    expect(validateTelemetry(base, now, DEFAULT_CONFIG).status).toBe('NORMAL');
    expect(() => validateTelemetry({ ...base, zoneId: 'Z-XXX' }, now, DEFAULT_CONFIG)).toThrow(/catálogo/);
    expect(() => validateTelemetry({ ...base, zoneId: 'Z-LPA' }, now, DEFAULT_CONFIG)).toThrow(/no pertenece/);
    expect(() => validateTelemetry({ ...base, observedAt: new Date(now.getTime() + 10 * 60_000).toISOString() }, now, DEFAULT_CONFIG)).toThrow(/futuro/);
    expect(() => validateTelemetry({ ...base, gbPerMinute: -3 }, now, DEFAULT_CONFIG)).toThrow();
  });
});

describe('estado de antena y episodios', () => {
  const t = (m: number) => new Date(Date.UTC(2026, 10, 15, 12, m)).toISOString();
  it('abre UN episodio en la primera anomalía, escala, y se recupera tras 3 normales', () => {
    let s = emptyAntennaState('ANT-SRN-01', 'Z-SRN');
    const kinds: string[] = [];
    const vals = [100, 40, 30, 0, 100, 100, 50, 100, 100, 100];
    vals.forEach((v, i) => {
      const r = applyReading(s, { eventId: `e${i}`, observedAt: t(i), gbPerMinute: v }, DEFAULT_CONFIG);
      s = r.state;
      kinds.push(...r.transitions.map((x) => x.kind));
    });
    // 40 abre; 0 escala; 50 re-escala (aún sin 3 normales); 3 normales cierran
    expect(kinds).toEqual(['EPISODE_OPENED', 'EPISODE_SEVERITY_CHANGED', 'EPISODE_SEVERITY_CHANGED', 'EPISODE_RECOVERED']);
    expect(s.openEpisode).toBeUndefined();
  });

  it('métrica fuera de orden se guarda pero no retrocede el estado', () => {
    let s = emptyAntennaState('ANT-SRN-01', 'Z-SRN');
    s = applyReading(s, { eventId: 'a', observedAt: t(5), gbPerMinute: 100 }, DEFAULT_CONFIG).state;
    const r = applyReading(s, { eventId: 'b', observedAt: t(3), gbPerMinute: 0 }, DEFAULT_CONFIG);
    expect(r.late).toBe(true);
    expect(r.state.status).toBe('NORMAL');
    expect(r.transitions).toHaveLength(0);
  });

  it('entregas fuera de orden (SQS estándar): una lectura tardía completa la racha y dispara la recuperación', () => {
    // Caso real observado en AWS: 0 (t0) y luego 95 (t1), 100 (t2), 105 (t3) aplicadas como t0, t2, t3, t1.
    let s = emptyAntennaState('ANT-CSU-01', 'Z-CSU');
    const kinds: string[] = [];
    for (const [m, v] of [[0, 0], [2, 100], [3, 105], [1, 95]] as const) {
      const r = applyReading(s, { eventId: `e${m}`, observedAt: t(m), gbPerMinute: v }, DEFAULT_CONFIG);
      s = r.state;
      kinds.push(...r.transitions.map((x) => x.kind));
    }
    expect(kinds).toEqual(['EPISODE_OPENED', 'EPISODE_RECOVERED']);
    expect(s.openEpisode).toBeUndefined();
    expect(s.status).toBe('NORMAL');
    expect(s.lastObservedAt).toBe(t(3)); // el estado actual no retrocede
    expect(s.lateReadings).toBe(1);
  });

  it('una lectura tardía anómala no reabre episodios ni cambia el estado actual', () => {
    let s = emptyAntennaState('ANT-CSU-01', 'Z-CSU');
    for (const m of [2, 3, 4]) s = applyReading(s, { eventId: `n${m}`, observedAt: t(m), gbPerMinute: 100 }, DEFAULT_CONFIG).state;
    const r = applyReading(s, { eventId: 'late', observedAt: new Date(Date.UTC(2026, 10, 15, 12, 3, 30)).toISOString(), gbPerMinute: 0 }, DEFAULT_CONFIG);
    expect(r.transitions).toHaveLength(0);
    expect(r.state.status).toBe('NORMAL');
    expect(r.state.consecutiveNormal).toBe(1); // en orden temporal: N N A N
  });

  it('falta de datos se distingue del valor cero', () => {
    const now = new Date(Date.UTC(2026, 10, 15, 12, 10));
    expect(displayStatus(undefined, now, DEFAULT_CONFIG)).toBe('SIN_DATOS');
    expect(displayStatus({ lastObservedAt: t(9), status: 'INHABILITADA' }, now, DEFAULT_CONFIG)).toBe('INHABILITADA');
    expect(displayStatus({ lastObservedAt: t(0), status: 'NORMAL' }, now, DEFAULT_CONFIG)).toBe('SIN_DATOS');
  });
});

describe('ventana móvil estrictamente < 24 h con usuarios distintos', () => {
  const base = Date.UTC(2026, 10, 15, 0, 0);
  const pts = (n: number, offsetMs = 0) => Array.from({ length: n }, (_, i) => ({ userHash: `u${i}`, at: base + offsetMs + i * 60_000, ticketId: `t${i}` }));

  it('9 usuarios + repetición de uno => 9', () => {
    const p = [...pts(9), { userHash: 'u3', at: base + 20 * 60_000, ticketId: 'rep' }];
    expect(maxDistinctUsersInWindow(p, 24 * H).distinctUsers).toBe(9);
  });
  it('el décimo distinto => 10', () => {
    expect(maxDistinctUsersInWindow(pts(10), 24 * H).distinctUsers).toBe(10);
  });
  it('un reporte exactamente 24 h antes queda fuera', () => {
    const p = [...pts(9, 0), { userHash: 'old', at: base - 24 * H, ticketId: 'old' }];
    expect(maxDistinctUsersInWindow(p, 24 * H).distinctUsers).toBe(9);
    const same = Array.from({ length: 9 }, (_, i) => ({ userHash: `u${i}`, at: base, ticketId: `s${i}` }));
    const p2 = [...same, { userHash: 'old', at: base - 24 * H + 1, ticketId: 'old' }];
    expect(maxDistinctUsersInWindow(p2, 24 * H).distinctUsers).toBe(10);
  });
});

describe('prioridad determinista', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const common = { uniqueReporters: 12, estimatedUsers: 8000, worstAntennaStatus: 'CAIDA' as const, openedAt: '2026-11-15T10:00:00Z', now };
  it('hospital > residencial a igualdad del resto, con factores explicados', () => {
    const h = computePriority({ ...common, zoneCriticality: 'HOSPITAL' });
    const r = computePriority({ ...common, zoneCriticality: 'RESIDENCIAL' });
    expect(h.score).toBeGreaterThan(r.score);
    expect(h.factors.map((f) => f.factor)).toEqual(['REPORTANTES_UNICOS', 'USUARIOS_ESTIMADOS', 'CRITICIDAD_ZONA', 'GRAVEDAD_ANTENAS', 'DURACION']);
    expect(['CRITICA', 'ALTA', 'MEDIA', 'BAJA']).toContain(h.level);
  });
  it('coberturas solapadas no se suman dos veces', () => {
    // ANT-SRN-01 (C1,C2) + ANT-SRN-02 (C2,C3) => C1+C2+C3
    expect(estimatedUsersForAntennas(['ANT-SRN-01', 'ANT-SRN-02'])).toBe(4200 + 3100 + 2600);
  });
});

describe('estados y recurrencia', () => {
  it('transiciones válidas e inválidas; reapertura explícita', () => {
    expect(() => assertTransition('REGISTRADA', 'SOLUCIONADA')).toThrow();
    expect(() => assertTransition('CERRADA', 'EN_REVISION')).toThrow();
    expect(() => assertTransition('CERRADA', 'EN_REVISION', { reopen: true })).not.toThrow();
    expect(allowedTransitions('EN_ATENCION')).toContain('SOLUCIONADA');
  });
  it('3 episodios en 7 días => revisión estructural', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const eps = [1, 2, 3].map((d) => ({ episodeId: `e${d}`, antennaId: 'A', startedAt: new Date(now.getTime() - d * 86_400_000).toISOString(), endedAt: new Date(now.getTime() - d * 86_400_000 + 600_000).toISOString(), worstStatus: 'CAIDA', anomalousReadings: 5 }));
    const r = evaluateRecurrence('A', eps, now, 3, 7 * 86_400_000);
    expect(r.structuralReview).toBe(true);
    expect(r.totalAnomalousMinutes).toBe(30);
    expect(evaluateRecurrence('A', eps.slice(0, 2), now, 3, 7 * 86_400_000).structuralReview).toBe(false);
  });
});

describe('reportes: validación y redacción', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  const valid = { documentType: 'DNI', documentNumber: '12345678', serviceNumber: '987654321', zoneId: 'Z-LPA', occurredAt: '2026-11-15T11:00:00Z', problemType: 'SIN_SENAL', description: 'No tengo señal en casa', idempotencyKey: 'abcdefghijklmnop' };
  it('acepta válido y normaliza identidad', () => {
    const r = validateReport(valid, now, DEFAULT_CONFIG);
    expect(r.normalizedIdentity).toBe('DNI:12345678');
    expect(r.family).toBe('CONECTIVIDAD');
  });
  it('rechaza futuro, zona inválida, consentimiento sin contacto, correo inválido', () => {
    expect(() => validateReport({ ...valid, occurredAt: '2026-11-15T13:00:00Z' }, now, DEFAULT_CONFIG)).toThrow(/futuro/);
    expect(() => validateReport({ ...valid, zoneId: 'Z-NOPE' }, now, DEFAULT_CONFIG)).toThrow();
    expect(() => validateReport({ ...valid, notifyConsent: true }, now, DEFAULT_CONFIG)).toThrow();
    expect(() => validateReport({ ...valid, contact: { email: 'no-es-correo' } }, now, DEFAULT_CONFIG)).toThrow();
  });
  it('redacta correos y números en texto libre', () => {
    expect(redactText('escríbeme a ana@correo.pe o al 987 654 321, DNI 12345678')).toBe('escríbeme a [CORREO] o al [NUMERO], DNI [NUMERO]');
  });
});
