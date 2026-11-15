import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { DescribeExecutionCommand, ExecutionAlreadyExists, SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { SendMessageBatchCommand, SQSClient } from '@aws-sdk/client-sqs';
import { CloudRunAiClient, DisabledAiClient } from '../ai/aiClient.js';
import { baseConfig, type NotificationProvider, type Orchestrator, type QueuePort, type Runtime } from '../services/runtime.js';
import { DynamoStore } from '../store/dynamoStore.js';

function env(name: string, required = true): string {
  const v = process.env[name];
  if (required && !v) throw new Error(`Variable de entorno requerida: ${name}`);
  return v ?? '';
}

/** Step Functions Standard: nombre determinista => inicio idempotente. */
export class SfnOrchestrator implements Orchestrator {
  readonly kind = 'aws-stepfunctions' as const;
  private readonly sfn = new SFNClient({});
  constructor(private readonly stateMachineArn: string) {}

  async start(name: string, input: Record<string, unknown>) {
    const payload = JSON.stringify(input);
    try {
      const r = await this.sfn.send(new StartExecutionCommand({ stateMachineArn: this.stateMachineArn, name, input: payload }));
      return { executionArn: r.executionArn!, alreadyExisted: false };
    } catch (e) {
      if (!(e instanceof ExecutionAlreadyExists)) throw e;
      // Verificar que la ejecución existente corresponde al mismo evento.
      const executionArn = this.stateMachineArn.replace(':stateMachine:', ':execution:') + `:${name}`;
      const d = await this.sfn.send(new DescribeExecutionCommand({ executionArn }));
      if (d.input !== payload) throw new Error(`Ejecución ${name} existe con otra entrada`);
      return { executionArn, alreadyExisted: true };
    }
  }
}

export class SqsQueues implements QueuePort {
  readonly kind = 'aws-sqs' as const;
  private readonly sqs = new SQSClient({});
  constructor(private readonly urls: { events: string; notifications: string }) {}

  async send(queue: 'events' | 'notifications', messages: { id: string; body: Record<string, unknown> }[]) {
    for (let i = 0; i < messages.length; i += 10) {
      const chunk = messages.slice(i, i + 10);
      const r = await this.sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: this.urls[queue],
          Entries: chunk.map((m, k) => ({ Id: `m${k}`, MessageBody: JSON.stringify(m.body) })),
        }),
      );
      if (r.Failed?.length) throw new Error(`SQS rechazó ${r.Failed.length} mensaje(s): ${r.Failed.map((f) => f.Code).join(',')}`);
    }
  }
}

/** Amazon SES (correo). En sandbox sólo entrega a identidades verificadas. */
export class SesEmail implements NotificationProvider {
  readonly name = 'AWS_SES';
  readonly channel = 'EMAIL' as const;
  private readonly ses = new SESv2Client({});
  constructor(private readonly from: string) {}
  async send(to: string, subject: string, body: string) {
    const r = await this.ses.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [to] },
        Content: { Simple: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: body, Charset: 'UTF-8' } } } },
      }),
    );
    return { providerMessageId: r.MessageId };
  }
}

/** Amazon SNS SMS (opcional; depende de la cuenta/región). */
export class SnsSms implements NotificationProvider {
  readonly name = 'AWS_SNS_SMS';
  readonly channel = 'SMS' as const;
  private readonly sns = new SNSClient({});
  async send(to: string, _subject: string, body: string) {
    const r = await this.sns.send(new PublishCommand({ PhoneNumber: to, Message: body.slice(0, 300), MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } } }));
    return { providerMessageId: r.MessageId };
  }
}

export async function createCloudRuntime(): Promise<Runtime> {
  const notifiers: NotificationProvider[] = [];
  if (process.env.SES_FROM_EMAIL) notifiers.push(new SesEmail(process.env.SES_FROM_EMAIL));
  if (process.env.SMS_ENABLED === 'true') notifiers.push(new SnsSms());
  const aiUrl = process.env.AI_SERVICE_URL;
  const authMode = (process.env.AI_AUTH_MODE as 'wif' | 'hmac') || 'wif';
  const ai = aiUrl
    ? new CloudRunAiClient({
        url: aiUrl,
        authMode,
        timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 12000),
        wif:
          authMode === 'wif'
            ? {
                projectNumber: env('GCP_PROJECT_NUMBER'),
                poolId: env('GCP_WIF_POOL'),
                providerId: env('GCP_WIF_PROVIDER'),
                serviceAccountEmail: env('GCP_INVOKER_SA'),
                audience: aiUrl,
                awsRegion: process.env.AWS_REGION ?? 'us-east-1',
              }
            : undefined,
      })
    : new DisabledAiClient();
  return {
    mode: 'aws',
    store: new DynamoStore(env('TABLE_NAME')),
    queues: new SqsQueues({ events: env('EVENTS_QUEUE_URL', false), notifications: env('NOTIFICATIONS_QUEUE_URL', false) }),
    ...baseConfig(),
    now: () => new Date(),
    orchestrator: new SfnOrchestrator(env('STATE_MACHINE_ARN', false)),
    notifiers,
    ai,
    allowedRecipients: (process.env.NOTIFY_ALLOWED_RECIPIENTS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
