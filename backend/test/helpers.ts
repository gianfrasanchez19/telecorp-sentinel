process.env.LOG_SILENT = process.env.LOG_SILENT ?? '1';
import { createLocalEnv, type LocalEnv } from '../src/local/localRuntime.js';
import { ingestReport } from '../src/services/reports.js';
import type { AiClient } from '../src/services/runtime.js';

export function newEnv(opts: { ai?: AiClient; allowedRecipients?: string[] } = {}): LocalEnv {
  const env = createLocalEnv({ allowedRecipients: opts.allowedRecipients ?? ['*'], concurrency: 8 });
  if (opts.ai) env.runtime.ai = opts.ai;
  return env;
}

let seq = 0;
export function reportBody(i: number, over: Record<string, unknown> = {}) {
  seq++;
  return {
    documentType: 'DNI',
    documentNumber: String(40_000_000 + i),
    serviceNumber: `9${String(10_000_000 + i).slice(-8)}`,
    zoneId: 'Z-LPA',
    occurredAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    problemType: 'SIN_SENAL',
    description: `Sin señal en mi casa desde hace un rato (${i})`,
    idempotencyKey: `test-key-${Date.now()}-${seq}-${i}`,
    ...over,
  };
}

export async function report(i: number, over: Record<string, unknown> = {}) {
  return ingestReport(reportBody(i, over));
}

export class FakeAi implements AiClient {
  readonly kind = 'test-double';
  calls = 0;
  constructor(private behaviour: 'ok' | 'transient' | 'invalid' = 'ok') {}
  async analyze(context: Record<string, unknown>) {
    this.calls++;
    if (this.behaviour === 'transient') throw Object.assign(new Error('timeout simulado'), { name: 'AiTransientError' });
    if (this.behaviour === 'invalid') throw Object.assign(new Error('salida inválida'), { name: 'AiUnavailableError' });
    return { summary: `Resumen de prueba ${JSON.stringify(context).length}`, probableCauses: ['c'], recommendedActions: ['a'], uncertainties: ['u'], relatedProblemType: 'CONECTIVIDAD', model: 'modelo-de-prueba', generatedAt: new Date().toISOString(), latencyMs: 1 };
  }
}
