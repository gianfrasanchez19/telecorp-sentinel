import { ANTENNAS, CELLS, ZONES } from '../../domain/catalog.js';
import { CORRELATABLE_FAMILIES, PROBLEM_TYPES, REPORT_STATUSES, type CaseStatus } from '../../domain/reports.js';
import { allowedTransitions } from '../../domain/status.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { analytics } from '../../services/analytics.js';
import { login } from '../../services/auth.js';
import { changeIncidentStatus, incidentDetail, incidentHistory, listIncidents } from '../../services/incidents.js';
import { processingStats, replayEvent } from '../../services/pipeline.js';
import { checkRateLimit, ingestReport, listReports, lookupTicket } from '../../services/reports.js';
import { rt } from '../../services/runtime.js';
import { runScenario, simulatorStatus, simulatorTick } from '../../services/simulator.js';
import { antennaMetrics, ingestTelemetry, listAntennas } from '../../services/telemetry.js';
import { ipHashOf, ok, type Req, type Route } from './http.js';

const operatorOnly = (req: Req) => {
  if (req.auth?.role !== 'OPERADOR') throw forbidden('Se requiere rol OPERADOR');
};

const num = (v: string | undefined, def: number) => (v === undefined ? def : Number.isFinite(Number(v)) ? Number(v) : def);

export const PUBLIC_ROUTES: Route[] = [
  {
    method: 'GET',
    path: '/health',
    auth: 'public',
    handler: async () => {
      const r = await rt();
      // Sin información sensible: sólo modo y tipo de adaptadores.
      return ok({ status: 'ok', mode: r.mode, storage: r.store.kind, orchestrator: r.orchestrator.kind, queues: r.queues.kind, ai: r.ai.kind, time: r.now().toISOString() });
    },
  },
  {
    method: 'GET',
    path: '/catalog',
    auth: 'public',
    handler: async () =>
      ok({
        syntheticNotice: 'Catálogo ficticio de demostración: zonas, antenas, coordenadas y coberturas sintéticas.',
        zones: ZONES,
        antennas: ANTENNAS,
        cells: CELLS,
        problemTypes: Object.entries(PROBLEM_TYPES).map(([id, v]) => ({ id, ...v, correlatable: CORRELATABLE_FAMILIES.has(v.family) })),
        statuses: REPORT_STATUSES,
      }),
  },
  {
    method: 'POST',
    path: '/reports',
    auth: 'public',
    handler: async (req) => {
      await checkRateLimit(`rpt:${await ipHashOf(req.sourceIp)}`, Number(process.env.REPORTS_PER_MINUTE_PER_IP ?? 20));
      const body = { ...(req.body as object), idempotencyKey: (req.body as { idempotencyKey?: string })?.idempotencyKey ?? req.headers['idempotency-key'] };
      const r = await ingestReport(body);
      return ok(r, r.duplicate ? 200 : 201);
    },
  },
  {
    method: 'POST',
    path: '/reports/lookup',
    auth: 'public',
    handler: async (req) => {
      await checkRateLimit(`lkp:${await ipHashOf(req.sourceIp)}`, 30);
      const token = (req.body as { token?: unknown })?.token;
      if (typeof token !== 'string') throw badRequest('Token requerido en el cuerpo');
      return ok(await lookupTicket(token));
    },
  },
  {
    method: 'POST',
    path: '/auth/login',
    auth: 'public',
    handler: async (req) => ok(await login(req.body, await ipHashOf(req.sourceIp))),
  },
];

export const INGEST_ROUTES: Route[] = [
  {
    method: 'POST',
    path: '/telemetry',
    auth: 'ingest',
    handler: async (req) => {
      const r = await ingestTelemetry(req.body);
      return ok(r, r.duplicate ? 200 : 202);
    },
  },
];

export const OPERATOR_ROUTES: Route[] = [
  {
    method: 'GET',
    path: '/operator/reports',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await listReports({ from: req.query.from, to: req.query.to, zoneId: req.query.zone, status: req.query.status, limit: num(req.query.limit, 200) }));
    },
  },
  {
    method: 'GET',
    path: '/operator/antennas',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await listAntennas());
    },
  },
  {
    method: 'GET',
    path: '/operator/antennas/{id}/metrics',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await antennaMetrics(req.params.id, { from: req.query.from, to: req.query.to, limit: num(req.query.limit, 1500) }));
    },
  },
  {
    method: 'GET',
    path: '/operator/incidents',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await listIncidents({ active: req.query.active !== 'false', zoneId: req.query.zone, level: req.query.level, kind: req.query.kind, status: req.query.status, limit: num(req.query.limit, 200) }));
    },
  },
  {
    method: 'GET',
    path: '/operator/incidents/{id}',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      const d = await incidentDetail(req.params.id);
      return ok({ ...d, allowedTransitions: allowedTransitions(d.incident.status as CaseStatus), allowedReopen: allowedTransitions(d.incident.status as CaseStatus, { reopen: true }) });
    },
  },
  {
    method: 'GET',
    path: '/operator/incidents/{id}/history',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await incidentHistory(req.params.id));
    },
  },
  {
    method: 'PATCH',
    path: '/operator/incidents/{id}/status',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      const b = req.body as { status?: string; reason?: string; reopen?: boolean; expectedVersion?: number };
      if (!b || !REPORT_STATUSES.includes(b.status as CaseStatus)) throw badRequest(`status debe ser uno de ${REPORT_STATUSES.join(', ')}`);
      const m = await changeIncidentStatus(req.params.id, b.status as CaseStatus, String(b.reason ?? ''), `operador:${req.auth!.sub}`, { reopen: !!b.reopen, expectedVersion: typeof b.expectedVersion === 'number' ? b.expectedVersion : undefined });
      return ok({ incidentId: m.incidentId, status: m.status, version: m.version });
    },
  },
  {
    method: 'GET',
    path: '/operator/analytics',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await analytics({ from: req.query.from, to: req.query.to, zoneId: req.query.zone }));
    },
  },
  {
    method: 'GET',
    path: '/operator/simulator',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await simulatorStatus());
    },
  },
  {
    method: 'POST',
    path: '/operator/simulator/scenarios',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      const b = (req.body ?? {}) as { scenario?: string; params?: Record<string, unknown> };
      if (b.scenario === 'tick') return ok(await simulatorTick());
      if (typeof b.scenario !== 'string') throw badRequest('scenario requerido');
      return ok(await runScenario(b.scenario, b.params ?? {}), 202);
    },
  },
  {
    method: 'GET',
    path: '/operator/processing',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await processingStats());
    },
  },
  {
    method: 'POST',
    path: '/operator/processing/{eventId}/replay',
    auth: 'operator',
    handler: async (req) => {
      operatorOnly(req);
      return ok(await replayEvent(req.params.eventId), 202);
    },
  },
];

export const ALL_ROUTES: Route[] = [...PUBLIC_ROUTES, ...INGEST_ROUTES, ...OPERATOR_ROUTES];
