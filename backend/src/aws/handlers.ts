import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { DynamoDBStreamEvent, SQSBatchResponse, SQSEvent } from 'aws-lambda';
import { lambdaApi } from '../handlers/api/http.js';
import { INGEST_ROUTES, OPERATOR_ROUTES, PUBLIC_ROUTES } from '../handlers/api/routes.js';
import { log, setLogContext } from '../lib/logger.js';
import { verifyJwt } from '../services/auth.js';
import { NotificationRetryableError, processNotification } from '../services/notifications.js';
import { handleEventMessage, publishChanges, reconcileOutbox } from '../services/pipeline.js';
import { setRuntimeFactory } from '../services/runtime.js';
import { simulatorTick } from '../services/simulator.js';
import type { ChangeRecord, Item } from '../store/types.js';
import { STEPS, type StepName } from '../workflow/steps.js';
import { createCloudRuntime } from './cloudRuntime.js';

/**
 * Puntos de entrada de AWS Lambda (un único bundle ESM, varias funciones).
 * Cada función de serverless.yml apunta a una exportación de este módulo.
 */
setRuntimeFactory(createCloudRuntime);
setLogContext({ fn: process.env.AWS_LAMBDA_FUNCTION_NAME, stage: process.env.STAGE });

// ---------- API Gateway HTTP API ----------
export const publicApi = lambdaApi(PUBLIC_ROUTES);
export const ingestApi = lambdaApi(INGEST_ROUTES);
export const operatorApi = lambdaApi(OPERATOR_ROUTES);

/** Lambda Authorizer (HTTP API, respuestas simples). */
export async function authorizer(event: { headers?: Record<string, string>; routeKey?: string }): Promise<{ isAuthorized: boolean; context?: Record<string, string> }> {
  try {
    const h = event.headers?.authorization ?? event.headers?.Authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token) return { isAuthorized: false };
    const c = await verifyJwt(token);
    const isTelemetry = (event.routeKey ?? '').includes('/telemetry');
    const ok = isTelemetry ? c.role === 'INGESTA' || c.role === 'OPERADOR' : c.role === 'OPERADOR';
    return ok ? { isAuthorized: true, context: { sub: c.sub, role: c.role } } : { isAuthorized: false };
  } catch {
    return { isAuthorized: false };
  }
}

// ---------- DynamoDB Streams -> SQS (publicador outbox) ----------
export async function streamPublisher(event: DynamoDBStreamEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const failures: { itemIdentifier: string }[] = [];
  for (const r of event.Records) {
    const rec: ChangeRecord = {
      eventName: r.eventName as ChangeRecord['eventName'],
      newImage: r.dynamodb?.NewImage ? (unmarshall(r.dynamodb.NewImage as never) as Item) : undefined,
    };
    try {
      await publishChanges([rec]);
    } catch (e) {
      log.error('publicacion_outbox_fallida', e);
      // Desde el primer fallo se reintenta el resto del lote (orden por shard).
      failures.push({ itemIdentifier: r.dynamodb!.SequenceNumber! });
      break;
    }
  }
  return { batchItemFailures: failures };
}

// ---------- SQS: cola de eventos -> Step Functions ----------
export async function eventsConsumer(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  await Promise.all(
    event.Records.map(async (r) => {
      try {
        await handleEventMessage(JSON.parse(r.body));
      } catch (e) {
        log.error('evento_no_procesado', e, { messageId: r.messageId, receiveCount: r.attributes.ApproximateReceiveCount });
        batchItemFailures.push({ itemIdentifier: r.messageId });
      }
    }),
  );
  return { batchItemFailures };
}

// ---------- SQS: cola de notificaciones -> SES/SNS ----------
export async function notificationsConsumer(event: SQSEvent): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const r of event.Records) {
    try {
      await processNotification((JSON.parse(r.body) as { notificationId: string }).notificationId);
    } catch (e) {
      if (!(e instanceof NotificationRetryableError)) log.error('notificacion_error', e, { messageId: r.messageId });
      batchItemFailures.push({ itemIdentifier: r.messageId });
    }
  }
  return { batchItemFailures };
}

// ---------- Pasos de Step Functions ----------
function step(name: StepName) {
  return async (input: unknown) => {
    setLogContext({ fn: process.env.AWS_LAMBDA_FUNCTION_NAME, step: name, eventId: (input as { eventId?: string })?.eventId });
    return (STEPS[name] as (i: unknown) => Promise<unknown>)(input);
  };
}
export const wfLoadEvent = step('LoadEvent');
export const wfValidateAndCorrelate = step('ValidateAndCorrelate');
export const wfPersistIncidentAndHistory = step('PersistIncidentAndHistory');
export const wfCalculatePriority = step('CalculatePriority');
export const wfAnalyzeWithGcp = step('AnalyzeWithGCP');
export const wfBuildFallbackAnalysis = step('BuildFallbackAnalysis');
export const wfPersistAnalysis = step('PersistAnalysis');
export const wfPropagateStatus = step('PropagateStatus');
export const wfQueueNotifications = step('QueueNotifications');
export const wfMarkSucceeded = step('MarkSucceeded');
export const wfMarkFailed = step('MarkFailed');

// ---------- Programados ----------
export async function simulator(): Promise<unknown> {
  return simulatorTick();
}
export async function outboxReconciler(): Promise<{ republished: number }> {
  return { republished: await reconcileOutbox() };
}
