import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { CloudRunAiClient, DisabledAiClient } from '../ai/aiClient.js';
import { log } from '../lib/logger.js';
import { setMasterKeyForLocal } from '../lib/secrets.js';
import { NotificationRetryableError, processNotification } from '../services/notifications.js';
import { handleEventMessage, publishChanges } from '../services/pipeline.js';
import { baseConfig, setRuntime, type NotificationProvider, type Orchestrator, type QueuePort, type Runtime } from '../services/runtime.js';
import { MemoryStore } from '../store/memoryStore.js';
import { STEPS, type StepName } from '../workflow/steps.js';
import { AslInterpreter, type ExecutionRecord } from './aslInterpreter.js';

const here = dirname(fileURLToPath(import.meta.url));
export const ASL_PATH = resolve(here, '../../statemachine/incident-workflow.asl.json');

interface Msg {
  id: string;
  body: Record<string, unknown>;
  receiveCount: number;
}

/**
 * COLA LOCAL EMULADA (no es SQS): lotes de hasta 10, concurrencia configurable,
 * reintentos con "visibilidad" y DLQ tras maxReceiveCount — misma semántica de
 * fallos parciales por ítem (batch item failures) que usa el consumidor real.
 */
export class LocalQueue {
  private pending: Msg[] = [];
  private inflight = 0;
  readonly dlq: Msg[] = [];
  processed = 0;
  failedAttempts = 0;
  private waiters: (() => void)[] = [];

  constructor(
    readonly name: string,
    private readonly handler: (body: Record<string, unknown>) => Promise<void>,
    private readonly opts: { maxReceiveCount: number; concurrency: number; retryDelayMs: number },
  ) {}

  send(msgs: { id: string; body: Record<string, unknown> }[]): void {
    for (const m of msgs) this.pending.push({ ...m, receiveCount: 0 });
    this.pump();
  }

  private pump(): void {
    while (this.inflight < this.opts.concurrency && this.pending.length) {
      const batch = this.pending.splice(0, 10);
      this.inflight++;
      void this.runBatch(batch).finally(() => {
        this.inflight--;
        this.pump();
        this.notifyIdle();
      });
    }
  }

  private async runBatch(batch: Msg[]): Promise<void> {
    await Promise.all(
      batch.map(async (m) => {
        m.receiveCount++;
        try {
          await this.handler(m.body);
          this.processed++;
        } catch (e) {
          this.failedAttempts++;
          if (m.receiveCount >= this.opts.maxReceiveCount) {
            this.dlq.push(m);
            log.error('mensaje_a_dlq_local', e, { queue: this.name, id: m.id });
          } else {
            this.inflight++;
            setTimeout(() => {
              this.inflight--;
              this.pending.push(m);
              this.pump();
            }, this.opts.retryDelayMs * m.receiveCount);
          }
        }
      }),
    );
  }

  redriveDlq(): number {
    const n = this.dlq.length;
    this.send(this.dlq.splice(0).map((m) => ({ id: m.id, body: m.body })));
    return n;
  }

  get busy(): boolean {
    return this.inflight > 0 || this.pending.length > 0;
  }

  private notifyIdle(): void {
    if (!this.busy) for (const w of this.waiters.splice(0)) w();
  }

  stats() {
    return { name: this.name, pending: this.pending.length, inflight: this.inflight, processed: this.processed, failedAttempts: this.failedAttempts, dlq: this.dlq.length };
  }
}

/** ORQUESTADOR LOCAL: ejecuta la definición ASL con el intérprete (etiquetado como emulador). */
export class LocalOrchestrator implements Orchestrator {
  readonly kind = 'local-asl-emulator' as const;
  readonly executions = new Map<string, ExecutionRecord>();
  private running = 0;
  private readonly interpreter: AslInterpreter;

  constructor(definition: unknown, opts: { retryDelayScale?: number } = {}) {
    const resolveTask = (resource: string) => {
      const m = /^\$\{(\w+)Arn\}$/.exec(resource);
      const map: Record<string, StepName> = {
        LoadEvent: 'LoadEvent',
        ValidateAndCorrelate: 'ValidateAndCorrelate',
        PersistIncidentAndHistory: 'PersistIncidentAndHistory',
        CalculatePriority: 'CalculatePriority',
        AnalyzeWithGcp: 'AnalyzeWithGCP',
        BuildFallbackAnalysis: 'BuildFallbackAnalysis',
        PersistAnalysis: 'PersistAnalysis',
        PropagateStatus: 'PropagateStatus',
        QueueNotifications: 'QueueNotifications',
        MarkSucceeded: 'MarkSucceeded',
        MarkFailed: 'MarkFailed',
      };
      const step = m ? map[m[1]] : undefined;
      if (!step) throw new Error(`Recurso ASL desconocido ${resource}`);
      return STEPS[step] as (i: unknown) => Promise<unknown>;
    };
    this.interpreter = new AslInterpreter(definition, resolveTask, opts);
  }

  async start(name: string, input: Record<string, unknown>) {
    const existing = this.executions.get(name);
    if (existing) {
      if (JSON.stringify(existing.input) !== JSON.stringify(input)) throw Object.assign(new Error('Execution already exists with different input'), { name: 'ExecutionAlreadyExists' });
      return { executionArn: `local:execution:${name}`, alreadyExisted: true };
    }
    const rec: ExecutionRecord = { name, status: 'RUNNING', input, startedAt: new Date().toISOString(), events: [] };
    this.executions.set(name, rec);
    this.running++;
    // Asíncrono (como StartExecution): el inicio es "durable" al quedar registrado.
    setImmediate(() => {
      this.interpreter
        .run(name, input, rec)
        .then((out) => {
          rec.status = 'SUCCEEDED';
          rec.output = out;
        })
        .catch((e) => {
          rec.status = 'FAILED';
          rec.error = { Error: e.error ?? e.name, Cause: e.cause ?? e.message };
        })
        .finally(() => {
          rec.stoppedAt = new Date().toISOString();
          this.running--;
        });
    });
    return { executionArn: `local:execution:${name}`, alreadyExisted: false };
  }

  get busy(): boolean {
    return this.running > 0;
  }
}

/** Buzón local: guarda los mensajes como archivos (NO se envían). */
export class LocalMailbox implements NotificationProvider {
  readonly name = 'BUZON_LOCAL_EMULADO';
  readonly sent: { to: string; subject: string; at: string }[] = [];
  constructor(
    readonly channel: 'EMAIL' | 'SMS',
    private readonly dir?: string,
    public failNext = 0,
  ) {}
  async send(to: string, subject: string, body: string) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Fallo simulado del proveedor local');
    }
    const at = new Date().toISOString();
    this.sent.push({ to, subject, at });
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(join(this.dir, `${at.replace(/[:.]/g, '-')}-${this.channel}.txt`), `LOCAL — NO ENVIADO\nPara: ${to}\nAsunto: ${subject}\n\n${body}\n`);
    }
    return { providerMessageId: `local-${randomBytes(6).toString('hex')}` };
  }
}

export interface LocalEnv {
  runtime: Runtime;
  store: MemoryStore;
  events: LocalQueue;
  notifications: LocalQueue;
  orchestrator: LocalOrchestrator;
  mailbox: LocalMailbox;
  idle(timeoutMs?: number): Promise<void>;
  setNow(d: Date | undefined): void;
}

export function loadOrCreateLocalMasterKey(dir: string): string {
  if (process.env.LOCAL_MASTER_KEY) return process.env.LOCAL_MASTER_KEY;
  const f = join(dir, 'master.key');
  if (existsSync(f)) return readFileSync(f, 'utf8').trim();
  mkdirSync(dir, { recursive: true });
  const k = randomBytes(48).toString('base64url');
  writeFileSync(f, k, { mode: 0o600 });
  return k;
}

export function createLocalEnv(opts: { dataFile?: string; mailDir?: string; masterKey?: string; concurrency?: number; allowedRecipients?: string[] } = {}): LocalEnv {
  const store = new MemoryStore({ file: opts.dataFile });
  setMasterKeyForLocal(opts.masterKey ?? randomBytes(48).toString('base64url'));
  const definition = JSON.parse(readFileSync(ASL_PATH, 'utf8'));
  const orchestrator = new LocalOrchestrator(definition);
  const mailbox = new LocalMailbox('EMAIL', opts.mailDir);
  let fixedNow: Date | undefined;

  const events = new LocalQueue(
    'eventos',
    async (b) => {
      await handleEventMessage(b as { eventId: string; type: string });
    },
    { maxReceiveCount: 5, concurrency: opts.concurrency ?? 8, retryDelayMs: 20 },
  );
  const notifications = new LocalQueue(
    'notificaciones',
    async (b) => {
      try {
        await processNotification(b.notificationId as string);
      } catch (e) {
        if (e instanceof NotificationRetryableError) throw e;
        throw e;
      }
    },
    { maxReceiveCount: 5, concurrency: 4, retryDelayMs: 20 },
  );
  const queues: QueuePort = {
    kind: 'local-queue-emulator',
    async send(q, msgs) {
      (q === 'events' ? events : notifications).send(msgs);
    },
  };
  const aiUrl = process.env.AI_SERVICE_URL;
  const runtime: Runtime = {
    mode: 'local',
    store,
    queues,
    ...baseConfig(),
    now: () => fixedNow ?? new Date(),
    orchestrator,
    notifiers: [mailbox],
    ai: aiUrl ? new CloudRunAiClient({ url: aiUrl, authMode: 'hmac' }) : new DisabledAiClient(),
    allowedRecipients: opts.allowedRecipients ?? (process.env.NOTIFY_ALLOWED_RECIPIENTS ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
  };
  setRuntime(runtime);

  // "DynamoDB Streams" emulado: cambios -> publicador outbox (con reintento).
  let pendingStream = 0;
  store.onChange((c) => {
    pendingStream++;
    const attempt = async (n: number): Promise<void> => {
      try {
        await publishChanges([c]);
      } catch (e) {
        if (n < 5) return new Promise((r) => setTimeout(() => r(attempt(n + 1)), 20 * (n + 1)));
        log.error('stream_local_fallido', e);
      }
    };
    void attempt(0).finally(() => pendingStream--);
  });

  return {
    runtime,
    store,
    events,
    notifications,
    orchestrator,
    mailbox,
    setNow: (d) => {
      fixedNow = d;
    },
    async idle(timeoutMs = 20_000) {
      const start = Date.now();
      let quiet = 0;
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 15));
        const busy = pendingStream > 0 || events.busy || notifications.busy || orchestrator.busy;
        quiet = busy ? 0 : quiet + 1;
        if (quiet >= 4) return;
      }
      throw new Error('Timeout esperando a que el pipeline local quede inactivo');
    },
  };
}
