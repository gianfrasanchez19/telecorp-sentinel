import { z } from 'zod';
import { hmacHex, randomId, sha256Hex } from '../lib/crypto.js';
import { getKeys } from '../lib/secrets.js';
import type { AiAnalysis, AiClient } from '../services/runtime.js';
import { getCloudRunIdToken, type WifConfig } from './gcpAuth.js';

/** Errores transitorios (timeout/5xx): Step Functions los reintenta con backoff. */
export class AiTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiTransientError';
  }
}
/** Errores definitivos (config, 4xx, salida inválida): van directo al respaldo. */
export class AiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

export const aiOutputSchema = z.object({
  summary: z.string().min(1).max(1500),
  probableCauses: z.array(z.string().max(500)).max(8),
  recommendedActions: z.array(z.string().max(500)).max(10),
  uncertainties: z.array(z.string().max(500)).max(8),
  relatedProblemType: z.string().max(60),
  model: z.string().max(100),
  generatedAt: z.string(),
  requestId: z.string().optional(),
  latencyMs: z.number().optional(),
});

const MAX_INPUT_BYTES = 16_000;

export class CloudRunAiClient implements AiClient {
  readonly kind = 'gcp-cloud-run-vertex-ai';
  constructor(
    private readonly opts: { url: string; authMode: 'wif' | 'hmac'; wif?: WifConfig; timeoutMs?: number },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async analyze(context: Record<string, unknown>, requestId: string): Promise<AiAnalysis & { latencyMs: number }> {
    const body = JSON.stringify({ requestId, context });
    if (Buffer.byteLength(body) > MAX_INPUT_BYTES) throw new AiUnavailableError('Contexto excede el límite de entrada');
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-request-id': requestId };
    try {
      if (this.opts.authMode === 'wif') {
        if (!this.opts.wif) throw new AiUnavailableError('WIF no configurado');
        headers.authorization = `Bearer ${await getCloudRunIdToken(this.opts.wif, this.fetchImpl)}`;
      } else {
        const keys = await getKeys();
        const ts = Math.floor(Date.now() / 1000).toString();
        const nonce = randomId(16);
        headers['x-sentinel-timestamp'] = ts;
        headers['x-sentinel-nonce'] = nonce;
        headers['x-sentinel-signature'] = hmacHex(keys.aiHmac, `${ts}.${nonce}.${sha256Hex(body)}`);
      }
    } catch (e) {
      if (e instanceof AiUnavailableError) throw e;
      throw new AiTransientError(`Autenticación con GCP falló: ${(e as Error).message}`);
    }
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.url.replace(/\/$/, '')}/v1/analyze`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 12_000) });
    } catch (e) {
      throw new AiTransientError(`Sin respuesta del servicio IA: ${(e as Error).name}`);
    }
    const latencyMs = Date.now() - started;
    if (res.status >= 500 || res.status === 429) throw new AiTransientError(`Servicio IA respondió ${res.status}`);
    if (!res.ok) throw new AiUnavailableError(`Servicio IA respondió ${res.status}`);
    const parsed = aiOutputSchema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new AiUnavailableError('Salida de IA no cumple el esquema');
    return { ...parsed.data, latencyMs };
  }
}

/** Cliente para entornos sin IA configurada: siempre cae al respaldo etiquetado. */
export class DisabledAiClient implements AiClient {
  readonly kind = 'disabled';
  async analyze(): Promise<never> {
    throw new AiUnavailableError('IA no configurada en este entorno (AI_SERVICE_URL vacío)');
  }
}
