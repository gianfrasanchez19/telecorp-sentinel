import { ANTENNAS, ZONES, antennasInZone, getAntenna, isValidZone } from '../domain/catalog.js';
import { PROBLEM_TYPES, type ProblemType } from '../domain/reports.js';
import { createHash } from 'node:crypto';
import { badRequest } from '../lib/errors.js';
import { log } from '../lib/logger.js';
import { K } from '../repo/keys.js';
import { ingestReport } from './reports.js';
import { rt } from './runtime.js';
import { ingestTelemetry } from './telemetry.js';

/**
 * SIMULADOR de telemetría y escenarios (DATOS SINTÉTICOS).
 * - Invocado cada minuto por EventBridge (regla programada, apagable) o por el
 *   operador autenticado desde el "Laboratorio de simulación".
 * - eventId determinista por antena+minuto => re-invocaciones idempotentes.
 */
type Mode = 'NORMAL' | 'CAIDA' | 'INHABILITADA' | 'SATURADA' | 'SIN_DATOS';
interface Override {
  mode: Mode;
  until: string;
}
interface SimConfig {
  overrides: Record<string, Override>;
  version: number;
}

function rand01(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) / 0xffffffff;
}

function valueFor(mode: Mode, seed: string): number | null {
  const r = rand01(seed);
  switch (mode) {
    case 'NORMAL':
      return Math.round((65 + r * 60) * 100) / 100; // 65–125
    case 'CAIDA':
      return Math.round((8 + r * 45) * 100) / 100; // 8–53
    case 'INHABILITADA':
      return 0;
    case 'SATURADA':
      return Math.round((132 + r * 40) * 100) / 100; // 132–172
    case 'SIN_DATOS':
      return null;
  }
}

async function getConfig(): Promise<SimConfig> {
  const { store } = await rt();
  const it = await store.get(K.simConfig().pk, 'CONFIG', { consistent: true });
  return it ? (it as unknown as SimConfig) : { overrides: {}, version: 0 };
}

async function saveConfig(c: SimConfig): Promise<void> {
  const { store } = await rt();
  await store.put({ ...K.simConfig(), entity: 'SIM_CONFIG', overrides: c.overrides, version: c.version + 1 }, c.version === 0 ? undefined : { kind: 'version', version: c.version });
}

export async function simulatorTick(maxEvents = Number(process.env.SIMULATOR_MAX_EVENTS ?? 50)): Promise<{ emitted: number; skipped: number; minute: string }> {
  const { now } = await rt();
  const nowD = now();
  const minute = new Date(Math.floor(nowD.getTime() / 60_000) * 60_000).toISOString();
  const cfg = await getConfig();
  let emitted = 0;
  let skipped = 0;
  for (const a of ANTENNAS.slice(0, maxEvents)) {
    const ov = cfg.overrides[a.antennaId];
    const mode: Mode = ov && ov.until > nowD.toISOString() ? ov.mode : 'NORMAL';
    const v = valueFor(mode, `${a.antennaId}|${minute}`);
    if (v === null) {
      skipped++; // falta de datos (distinto de 0)
      continue;
    }
    await ingestTelemetry({ eventId: `sim-${a.antennaId}-${minute.replace(/[^0-9]/g, '').slice(0, 12)}`, antennaId: a.antennaId, zoneId: a.zoneId, gbPerMinute: v, observedAt: minute, synthetic: true });
    emitted++;
  }
  log.info('simulador_tick', { minute, emitted, skipped });
  return { emitted, skipped, minute };
}

export const SCENARIOS = [
  { id: 'antena-caida', label: 'Antena caída (< 60 GB/min)', params: ['antennaId', 'minutes'] },
  { id: 'antena-inhabilitada', label: 'Antena inhabilitada (0 GB/min)', params: ['antennaId', 'minutes'] },
  { id: 'antena-saturada', label: 'Antena saturada (> 129 GB/min)', params: ['antennaId', 'minutes'] },
  { id: 'sin-datos', label: 'Falta de datos (sin lecturas)', params: ['antennaId', 'minutes'] },
  { id: 'recuperar', label: 'Recuperar antena (lecturas normales)', params: ['antennaId'] },
  { id: 'lecturas-limite', label: 'Lecturas límite 0 · 59.99 · 60 · 129 · 129.01 · negativo', params: ['antennaId'] },
  { id: 'recurrencia', label: 'Recurrencia: 3 episodios cortos', params: ['antennaId'] },
  { id: 'reportes-usuarios', label: 'Reportes de usuarios distintos (sintéticos)', params: ['zoneId', 'count', 'startIndex', 'problemType', 'repeatIndex'] },
  { id: 'multi-zona', label: 'Fallas simultáneas en varias zonas', params: [] },
] as const;

export type ScenarioId = (typeof SCENARIOS)[number]['id'];

function syntheticIdentity(zoneId: string, i: number) {
  // DNI ficticio derivado de zona+índice (8 dígitos). Nunca se contacta.
  const n = 10_000_000 + (parseInt(createHash('sha256').update(`${zoneId}|${i}`).digest('hex').slice(0, 7), 16) % 89_999_999);
  return { documentType: 'DNI' as const, documentNumber: String(n).padStart(8, '0').slice(0, 8), serviceNumber: `9${String(n).slice(-8).padStart(8, '0')}` };
}

const SAMPLE_DESCRIPTIONS = [
  'No tengo señal desde hace un rato en mi casa',
  'Se me cortan las llamadas a cada rato',
  'El internet móvil no carga ninguna página',
  'Sin datos, solo aparece E en la barra',
  'La conexión va y viene, muy inestable',
  'No puedo llamar a nadie, dice sin servicio',
  'Internet lentísimo, no cargan los videos',
  'desde la mañana sin cobertura en la zona',
];

export async function runScenario(id: string, p: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { now } = await rt();
  const nowD = now();
  const minutes = Math.min(Math.max(Number(p.minutes ?? 15), 1), 240);
  const antennaId = p.antennaId as string | undefined;
  const needAntenna = () => {
    if (!antennaId || !getAntenna(antennaId)) throw badRequest('antennaId inválido');
    return getAntenna(antennaId)!;
  };
  const setOverride = async (aid: string, mode: Mode | null) => {
    const c = await getConfig();
    const overrides = { ...c.overrides };
    if (mode) overrides[aid] = { mode, until: new Date(nowD.getTime() + minutes * 60_000).toISOString() };
    else delete overrides[aid];
    await saveConfig({ ...c, overrides });
  };
  const inject = async (aid: string, values: number[], tag: string) => {
    const a = getAntenna(aid)!;
    const out: { value: number; result: string }[] = [];
    for (let i = 0; i < values.length; i++) {
      const observedAt = new Date(nowD.getTime() + (i + 1) * 2000).toISOString();
      try {
        const r = await ingestTelemetry({ eventId: `scn-${tag}-${aid}-${nowD.getTime()}-${i}`, antennaId: aid, zoneId: a.zoneId, gbPerMinute: values[i], observedAt, synthetic: true });
        out.push({ value: values[i], result: r.status });
      } catch (e) {
        out.push({ value: values[i], result: `RECHAZADA: ${(e as Error).message}` });
      }
    }
    return out;
  };

  switch (id as ScenarioId) {
    case 'antena-caida':
    case 'antena-inhabilitada':
    case 'antena-saturada':
    case 'sin-datos': {
      const a = needAntenna();
      const mode: Mode = id === 'antena-caida' ? 'CAIDA' : id === 'antena-inhabilitada' ? 'INHABILITADA' : id === 'antena-saturada' ? 'SATURADA' : 'SIN_DATOS';
      await setOverride(a.antennaId, mode);
      const injected = mode === 'SIN_DATOS' ? [] : await inject(a.antennaId, [valueFor(mode, `${a.antennaId}|${nowD.toISOString()}`)!], id);
      return { scenario: id, antennaId: a.antennaId, mode, minutes, injected, note: 'El simulador programado mantendrá este modo hasta que expire o se recupere.' };
    }
    case 'recuperar': {
      const a = needAntenna();
      await setOverride(a.antennaId, null);
      const injected = await inject(a.antennaId, [95, 100, 105], 'rec');
      return { scenario: id, antennaId: a.antennaId, injected, note: 'Política de recuperación: 3 lecturas normales consecutivas (configurable). Requiere verificación del operador.' };
    }
    case 'lecturas-limite': {
      const a = needAntenna();
      const injected = await inject(a.antennaId, [0, 59.99, 60, 129, 129.01, -5, 100, 100, 100], 'lim');
      return { scenario: id, antennaId: a.antennaId, injected };
    }
    case 'recurrencia': {
      const a = needAntenna();
      const seq = [30, 100, 100, 100, 0, 100, 100, 100, 150, 100, 100, 100];
      const injected = await inject(a.antennaId, seq, 'rcr');
      return { scenario: id, antennaId: a.antennaId, injected, note: '3 episodios distintos (caída, inhabilitada, saturada), cada uno cerrado con 3 lecturas normales.' };
    }
    case 'reportes-usuarios': {
      const zoneId = p.zoneId as string;
      if (!isValidZone(zoneId)) throw badRequest('zoneId inválido');
      const count = Math.min(Math.max(Number(p.count ?? 10), 1), 200);
      const start = Math.max(Number(p.startIndex ?? 0), 0);
      const problemType = (p.problemType as ProblemType) ?? 'SIN_SENAL';
      if (!(problemType in PROBLEM_TYPES)) throw badRequest('problemType inválido');
      const minutesAgo = Math.min(Math.max(Number(p.minutesAgo ?? 5), 0), 60 * 24 * 7);
      const indices = Array.from({ length: count }, (_, k) => start + k);
      if (p.repeatIndex !== undefined) indices.push(Number(p.repeatIndex));
      const demoEmail = process.env.DEMO_NOTIFY_EMAIL;
      const tickets: { ticketId: string; duplicate: boolean }[] = [];
      for (const i of indices) {
        const idn = syntheticIdentity(zoneId, i);
        const withContact = !!demoEmail && i === start;
        const r = await ingestReport({
          ...idn,
          zoneId,
          problemType,
          occurredAt: new Date(nowD.getTime() - minutesAgo * 60_000 - (indices.length - tickets.length) * 1000).toISOString(),
          description: SAMPLE_DESCRIPTIONS[i % SAMPLE_DESCRIPTIONS.length],
          notifyConsent: withContact,
          contact: withContact ? { email: demoEmail } : undefined,
          idempotencyKey: `sim-${zoneId}-${i}-${nowD.getTime()}-${tickets.length}`,
          synthetic: true,
        });
        tickets.push({ ticketId: r.ticketId, duplicate: r.duplicate });
      }
      return { scenario: id, zoneId, problemType, created: tickets.length, distinctSyntheticUsers: new Set(indices).size, tickets: tickets.map((t) => t.ticketId) };
    }
    case 'multi-zona': {
      const picks = ['Z-SRN', 'Z-LPA', 'Z-VIN'].map((z) => antennasInZone(z)[0]);
      for (const a of picks) await setOverride(a.antennaId, 'CAIDA');
      const injected = [];
      for (const a of picks) injected.push({ antennaId: a.antennaId, readings: await inject(a.antennaId, [25], 'mz') });
      return { scenario: id, antennas: picks.map((a) => a.antennaId), injected };
    }
    default:
      throw badRequest(`Escenario desconocido. Disponibles: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  }
}

export async function simulatorStatus() {
  const c = await getConfig();
  const { now } = await rt();
  const active = Object.entries(c.overrides).filter(([, o]) => o.until > now().toISOString());
  return { overrides: Object.fromEntries(active), scenarios: SCENARIOS, zones: ZONES.map((z) => z.zoneId), scheduleNote: 'En AWS el simulador corre cada minuto mediante una regla programada de EventBridge (parámetro simulatorEnabled).' };
}
