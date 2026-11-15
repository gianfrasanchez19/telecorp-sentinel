import { loadDomainConfig, type DomainConfig } from '../domain/config.js';
import { loadPriorityConfig, type PriorityConfig } from '../domain/priority.js';
import { ConcurrencyConflict } from '../lib/errors.js';
import { ConditionFailedError, TransientConflictError, type TableStore } from '../store/types.js';

/** Orquestador del flujo de incidentes (Step Functions real o intérprete local). */
export interface Orchestrator {
  readonly kind: 'aws-stepfunctions' | 'local-asl-emulator';
  start(name: string, input: Record<string, unknown>): Promise<{ executionArn: string; alreadyExisted: boolean }>;
}

export interface SendResult {
  providerMessageId?: string;
}
export interface NotificationProvider {
  readonly name: string;
  readonly channel: 'EMAIL' | 'SMS';
  send(to: string, subject: string, body: string): Promise<SendResult>;
}

export interface AiAnalysis {
  summary: string;
  probableCauses: string[];
  recommendedActions: string[];
  uncertainties: string[];
  relatedProblemType: string;
  model: string;
  generatedAt: string;
}
export interface AiClient {
  readonly kind: string;
  analyze(context: Record<string, unknown>, requestId: string): Promise<AiAnalysis & { latencyMs: number }>;
}

/** Colas: SQS real o cola local emulada. */
export interface QueuePort {
  readonly kind: 'aws-sqs' | 'local-queue-emulator';
  send(queue: 'events' | 'notifications', messages: { id: string; body: Record<string, unknown> }[]): Promise<void>;
}

export interface Runtime {
  mode: 'local' | 'aws';
  queues: QueuePort;
  store: TableStore;
  cfg: DomainConfig;
  priorityCfg: PriorityConfig;
  now: () => Date;
  orchestrator: Orchestrator;
  notifiers: NotificationProvider[];
  ai: AiClient;
  /** Destinatarios permitidos (sandbox SES / demo). Vacío = ninguno. "*" = todos. */
  allowedRecipients: string[];
}

let current: Runtime | undefined;
let factory: (() => Promise<Runtime>) | undefined;

export function setRuntime(r: Runtime): void {
  current = r;
}
export function setRuntimeFactory(f: () => Promise<Runtime>): void {
  factory = f;
}
export async function rt(): Promise<Runtime> {
  if (current) return current;
  if (!factory) throw new Error('Runtime no inicializado');
  current = await factory();
  return current;
}

export function baseConfig(): { cfg: DomainConfig; priorityCfg: PriorityConfig } {
  return { cfg: loadDomainConfig(), priorityCfg: loadPriorityConfig() };
}

/**
 * Reintenta una operación de lectura-modificación-escritura con control de
 * concurrencia optimista (CAS por versión) y backoff con jitter. Si se agotan los
 * intentos lanza ConcurrencyConflict, que Step Functions vuelve a reintentar.
 */
export async function withCas<T>(fn: (attempt: number) => Promise<T>, attempts = 6): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn(i);
    } catch (e) {
      if (!(e instanceof ConditionFailedError || e instanceof TransientConflictError)) throw e;
      last = e;
      await new Promise((r) => setTimeout(r, Math.min(200, 5 * 2 ** i) + Math.random() * 10));
    }
  }
  throw new ConcurrencyConflict(`Conflicto tras ${attempts} intentos: ${(last as Error)?.message}`);
}
